import { parseRecoveryCode } from './recovery.ts';

/**
 * The sealed form of a backup (sync phase S1, §6.4–6.5): a small JSON object that can travel over the companion
 * channel or sit in a file, readable only with the recovery code.
 *
 * - Key: PBKDF2-SHA256 over the code's 16 bytes with a random 128-bit salt (`i` iterations) gives 256 bits; HKDF
 *   from them gives the AES-256-GCM key (`iptv-backup/v1/enc`) and the source fingerprint key (`iptv-sync/v1/fp`, as
 *   `deriveFingerprintKey`), so the restoring device fingerprints its own sources the same way.
 * - Cipher: AES-256-GCM with a random 96-bit IV; AAD `iptv-backup|<v>|<i>|<s>|<at>` binds the header.
 * - WebCrypto only, on the Chromium 76 floor (PBKDF2, HKDF, AES-GCM, HMAC).
 *
 * `{ f: 'iptv-backup', v, i, s, iv, at, ct }`: `s`, `iv`, `ct` are base64, `at` is when it was made (ms).
 */
export interface BackupEnvelope {
  f: 'iptv-backup';
  v: number;
  /** PBKDF2 iterations. */
  i: number;
  s: string;
  iv: string;
  at: number;
  ct: string;
}

export const BACKUP_SCHEMA = 1;
/**
 * PBKDF2-SHA256 iterations of a new backup. The secret is the recovery code's 128 random bits, not a password, so
 * guessing it is infeasible at any count: the iterations are defence in depth only, and the count is chosen for
 * the slowest TV it must open on: half the phone pairing's 200k (≈ 0.2–1 s there), so about 0.1–0.5 s on a 1 GB
 * TV. The count is written into the header (`i`, bound by the AAD) and opening always uses that stored count, so
 * it can change without breaking older backups. The derivation runs outside AppApi's index lock (WebCrypto works
 * off the JS thread), so even a slow one never holds up the UI.
 */
export const BACKUP_PBKDF2_ITERATIONS = 100_000;
/**
 * An envelope asking for more work than this is refused: a hostile or future file must not keep a low-end TV busy
 * for more than about 1.5 s. Three times the default leaves room to raise it later.
 */
export const BACKUP_PBKDF2_MAX = 300_000;
/** Largest snapshot JSON sealed (bytes). Its envelope stays under the companion's 8 MiB message cap. */
export const BACKUP_PLAINTEXT_MAX = 4 * 1024 * 1024;
/** Longest `ct` accepted (base64 of BACKUP_PLAINTEXT_MAX plus the tag, rounded up). */
export const BACKUP_ENVELOPE_MAX_CHARS = 6 * 1024 * 1024;

const ENC_INFO = 'iptv-backup/v1/enc';
/** The same label as `deriveFingerprintKey`: the fingerprint key of a backup is built like the sync one. */
const FP_INFO = 'iptv-sync/v1/fp';
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export type BackupErrorReason = 'invalid' | 'tooNew' | 'badCode' | 'wrongCode' | 'tooLarge';

/** Why a backup could not be made or opened. A wrong code and a damaged backup look the same (GCM). */
export class BackupError extends Error {
  constructor(readonly reason: BackupErrorReason, message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const b64 = (x: unknown, min: number, max: number): x is string =>
  typeof x === 'string' && x.length >= min && x.length <= max && x.length % 4 === 0 && B64_RE.test(x);

/** Shape check of an untrusted envelope (any schema version; `openBackup` refuses newer ones). */
export function isBackupEnvelope(x: unknown): x is BackupEnvelope {
  if (!isObj(x)) return false;
  const keys = Object.keys(x);
  if (keys.length !== 7 || !['f', 'v', 'i', 's', 'iv', 'at', 'ct'].every((k) => keys.includes(k))) return false;
  return x['f'] === 'iptv-backup'
    && Number.isSafeInteger(x['v']) && (x['v'] as number) >= 1
    && Number.isSafeInteger(x['i']) && (x['i'] as number) >= 1 && (x['i'] as number) <= BACKUP_PBKDF2_MAX
    && b64(x['s'], 24, 24) && b64(x['iv'], 16, 16)
    && Number.isSafeInteger(x['at']) && (x['at'] as number) >= 0
    && b64(x['ct'], 4, BACKUP_ENVELOPE_MAX_CHARS);
}

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
  return btoa(bin);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const aad = (v: number, i: number, s: string, at: number) => new TextEncoder().encode(`iptv-backup|${v}|${i}|${s}|${at}`);

/** Imports the fingerprint key from its raw bytes (kept on the device to match sources added after a restore). */
export function importFingerprintKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
}

interface BackupKeys { enc: CryptoKey; fpKey: CryptoKey; fpRaw: Uint8Array }

async function deriveKeys(code: Uint8Array, salt: Uint8Array, iterations: number): Promise<BackupKeys> {
  const pw = await crypto.subtle.importKey('raw', code, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, pw, 256);
  const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const hkdf = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(info) });
  const enc = await crypto.subtle.deriveKey(hkdf(ENC_INFO), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const fpRaw = new Uint8Array(await crypto.subtle.deriveBits(hkdf(FP_INFO), base, 256));
  return { enc, fpKey: await importFingerprintKey(fpRaw), fpRaw };
}

function codeBytes(code: string): Uint8Array {
  const bytes = parseRecoveryCode(code);
  if (!bytes) throw new BackupError('badCode', 'That is not a recovery code.');
  return bytes;
}

export interface SealedBackup extends Omit<BackupKeys, 'enc'> { envelope: BackupEnvelope }

/**
 * Keys for a new backup under `code` (fresh salt): the fingerprint key comes first, because the snapshot's refs are
 * built with it; `seal` then encrypts the snapshot JSON.
 */
export interface BackupSealer extends Omit<BackupKeys, 'enc'> {
  seal(plaintext: Uint8Array, now: number): Promise<BackupEnvelope>;
}

export async function newBackupKeys(code: string, opts: { iterations?: number } = {}): Promise<BackupSealer> {
  const i = opts.iterations ?? BACKUP_PBKDF2_ITERATIONS;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keys = await deriveKeys(codeBytes(code), salt, i);
  const s = toBase64(salt);
  return {
    fpKey: keys.fpKey,
    fpRaw: keys.fpRaw,
    async seal(plaintext, now) {
      if (plaintext.length > BACKUP_PLAINTEXT_MAX) throw new BackupError('tooLarge', 'The backup is too large.');
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const at = Math.floor(now);
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(BACKUP_SCHEMA, i, s, at) }, keys.enc, plaintext);
      return { f: 'iptv-backup', v: BACKUP_SCHEMA, i, s, iv: toBase64(iv), at, ct: toBase64(new Uint8Array(ct)) };
    },
  };
}

/** Seals `plaintext` (the snapshot JSON) under `code`. */
export async function sealBackup(
  plaintext: Uint8Array, code: string, opts: { now: number; iterations?: number },
): Promise<SealedBackup> {
  if (plaintext.length > BACKUP_PLAINTEXT_MAX) throw new BackupError('tooLarge', 'The backup is too large.');
  const keys = await newBackupKeys(code, opts);
  return { envelope: await keys.seal(plaintext, opts.now), fpKey: keys.fpKey, fpRaw: keys.fpRaw };
}

export interface OpenedBackup extends Omit<BackupKeys, 'enc'> { plaintext: Uint8Array; at: number }

/** Opens an untrusted envelope with a typed code. Throws `BackupError`. */
export async function openBackup(envelope: unknown, code: string): Promise<OpenedBackup> {
  if (!isBackupEnvelope(envelope)) throw new BackupError('invalid', 'This is not a backup.');
  if (envelope.v > BACKUP_SCHEMA) throw new BackupError('tooNew', 'This backup was made by a newer version of the app.');
  const bytes = codeBytes(code);
  const keys = await deriveKeys(bytes, fromBase64(envelope.s), envelope.i);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: aad(envelope.v, envelope.i, envelope.s, envelope.at) },
      keys.enc, fromBase64(envelope.ct),
    );
  } catch {
    throw new BackupError('wrongCode', 'The recovery code does not open this backup.');
  }
  return { plaintext: new Uint8Array(plain), at: envelope.at, fpKey: keys.fpKey, fpRaw: keys.fpRaw };
}
