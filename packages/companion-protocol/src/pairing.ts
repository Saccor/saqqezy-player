import { fromB64Url, toB64Url } from './b64.ts';

/**
 * Pairing secrets. Two ways to pair:
 * - QR: `<origin>/#s=<b64url 16 random bytes>&k=<b64url 32 random bytes>`. The fragment never reaches a server.
 * - Code: 12 Crockford base32 characters, shown as `XXXX-XXXX-XXXX`, normalised before use
 *   (uppercase, `-` and whitespace removed, `I`/`L` -> `1`, `O` -> `0`).
 *   sessionId = SHA-256("iptv-pair-id" || code)[0..16]
 *   key       = PBKDF2-SHA256(code, salt = "iptv-pair-key", 200000 iterations, 32 bytes)
 *
 * Keys are imported or derived as non-extractable AES-256-GCM keys. Never log codes, keys or fragments.
 */

export interface PairingSecrets {
  sessionId: Uint8Array;
  key: CryptoKey;
  sessionIdB64: string;
}

export class PairingError extends Error {
  constructor(message = 'invalid') {
    super(message);
    this.name = 'PairingError';
  }
}

export const SESSION_ID_BYTES = 16;
export const KEY_BYTES = 32;
export const CODE_LENGTH = 12;
export const PBKDF2_ITERATIONS = 200000;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_PREFIX = 'iptv-pair-id';
const KEY_SALT = 'iptv-pair-key';
const KEY_USAGES: KeyUsage[] = ['encrypt', 'decrypt'];

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, KEY_USAGES);
}

export async function newQrSecrets(): Promise<PairingSecrets & { url: (origin: string) => string }> {
  const sessionId = crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTES));
  const raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const key = await importAesKey(raw);
  const sessionIdB64 = toB64Url(sessionId);
  // The raw key lives only inside this closure so the URL can be rendered as a QR code.
  const fragment = `s=${sessionIdB64}&k=${toB64Url(raw)}`;
  raw.fill(0);
  return {
    sessionId,
    key,
    sessionIdB64,
    url: (origin: string) => `${origin.replace(/\/+$/, '')}/#${fragment}`,
  };
}

export async function secretsFromQrFragment(fragment: string): Promise<PairingSecrets> {
  const body = fragment.charAt(0) === '#' ? fragment.slice(1) : fragment;
  let s: string | undefined;
  let k: string | undefined;
  for (const part of body.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (name === 's') {
      if (s !== undefined) throw new PairingError();
      s = value;
    } else if (name === 'k') {
      if (k !== undefined) throw new PairingError();
      k = value;
    }
  }
  if (s === undefined || k === undefined) throw new PairingError();
  let sessionId: Uint8Array;
  let raw: Uint8Array;
  try {
    sessionId = fromB64Url(s);
    raw = fromB64Url(k);
  } catch {
    throw new PairingError();
  }
  if (sessionId.length !== SESSION_ID_BYTES || raw.length !== KEY_BYTES) throw new PairingError();
  const key = await importAesKey(raw);
  raw.fill(0);
  return { sessionId, key, sessionIdB64: toB64Url(sessionId) };
}

export function newPairingCode(): string {
  const rnd = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += CROCKFORD[rnd[i]! & 31]!; // 256 is a multiple of 32, so this is unbiased
  }
  rnd.fill(0);
  return out;
}

/** Canonical 12-character form (no dashes), or null if the input cannot be a pairing code. */
export function normalizeCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[-\s]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (s.length !== CODE_LENGTH) return null;
  for (let i = 0; i < s.length; i++) {
    if (CROCKFORD.indexOf(s.charAt(i)) < 0) return null;
  }
  return s;
}

export async function secretsFromCode(code: string): Promise<PairingSecrets> {
  const norm = normalizeCode(code);
  if (norm === null) throw new PairingError();
  const codeBytes = utf8(norm);
  const prefix = utf8(ID_PREFIX);
  const idInput = new Uint8Array(prefix.length + codeBytes.length);
  idInput.set(prefix, 0);
  idInput.set(codeBytes, prefix.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', idInput));
  const sessionId = digest.slice(0, SESSION_ID_BYTES);

  const base = await crypto.subtle.importKey('raw', codeBytes, { name: 'PBKDF2' }, false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: utf8(KEY_SALT), iterations: PBKDF2_ITERATIONS },
    base,
    { name: 'AES-GCM', length: KEY_BYTES * 8 },
    false,
    KEY_USAGES,
  );
  codeBytes.fill(0);
  idInput.fill(0);
  return { sessionId, key, sessionIdB64: toB64Url(sessionId) };
}
