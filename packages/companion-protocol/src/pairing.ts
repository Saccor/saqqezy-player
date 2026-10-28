import { fromB64Url, toB64Url } from '@iptv/core';

/**
 * Pairing secrets. Two ways to pair:
 * - QR: `<origin>/#s=<b64url 16 random bytes>&k=<b64url 32 random bytes>`. The fragment never reaches a server.
 * - Code: 12 Crockford base32 characters, shown as `XXXX-XXXX-XXXX`, normalised before use
 *   (uppercase, `-` and whitespace removed, `I`/`L` -> `1`, `O` -> `0`). One KDF run derives both values:
 *     out       = PBKDF2-SHA256(code, salt = "iptv-pair", 200000 iterations, 48 bytes)
 *     sessionId = out[0..16]
 *     key       = out[16..48], imported as a non-extractable AES-256-GCM key
 *
 * Why one PBKDF2 for both: the sessionId is visible to the relay and to anyone watching the connection.
 * If it came from a cheap hash, an attacker could test code guesses against it at hash speed and then
 * derive the key for the one code that matched. Deriving it from the same slow PBKDF2 output means every
 * guess against the sessionId costs the full 200000 iterations, the same as a guess against the key.
 *
 * The salt is a constant. That is acceptable only because codes are random (60 bits from a CSPRNG),
 * single-use and short-lived (the relay session lives at most 15 minutes): a precomputed table would have
 * to cover the whole code space, and a code is worthless once its session ends.
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
const CODE_SALT = 'iptv-pair';
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
  const base = await crypto.subtle.importKey('raw', codeBytes, { name: 'PBKDF2' }, false, ['deriveBits']);
  codeBytes.fill(0);
  const out = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: utf8(CODE_SALT), iterations: PBKDF2_ITERATIONS },
    base,
    (SESSION_ID_BYTES + KEY_BYTES) * 8,
  ));
  const sessionId = out.slice(0, SESSION_ID_BYTES);
  const raw = out.subarray(SESSION_ID_BYTES, SESSION_ID_BYTES + KEY_BYTES);
  try {
    const key = await importAesKey(raw);
    return { sessionId, key, sessionIdB64: toB64Url(sessionId) };
  } finally {
    out.fill(0);
  }
}
