/**
 * The recovery code of a backup (§6.4): 128 random bits written as 26 Crockford base32 symbols (the first one carries
 * only 3 bits, so it is 0–7). Shown once, in groups (`formatRecoveryCode`); typed back on the phone or a keyboard.
 * Crockford's alphabet has no I, L, O or U, and parsing reads I and L as 1 and O as 0.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_CODE_BYTES = 16;
export const RECOVERY_CODE_LENGTH = 26;

/** Writes 16 bytes as 26 symbols, most significant first. */
export function encodeRecoveryCode(bytes: Uint8Array): string {
  if (bytes.length !== RECOVERY_CODE_BYTES) throw new Error('A recovery code holds 16 bytes.');
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
    out = ALPHABET[Number(n & 31n)]! + out;
    n >>= 5n;
  }
  return out;
}

/** A fresh code from 128 random bits. */
export function newRecoveryCode(): string {
  const bytes = new Uint8Array(RECOVERY_CODE_BYTES);
  crypto.getRandomValues(bytes);
  return encodeRecoveryCode(bytes);
}

/** `XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX`: four groups of five, then six. */
export function formatRecoveryCode(code: string): string {
  const c = code.replace(/[\s-]/g, '').toUpperCase();
  return [c.slice(0, 5), c.slice(5, 10), c.slice(10, 15), c.slice(15, 20), c.slice(20)].filter(Boolean).join('-');
}

/** The 16 bytes of a typed code (case, spaces, dashes and look-alikes forgiven), or undefined when it is not one. */
export function parseRecoveryCode(input: string): Uint8Array | undefined {
  if (typeof input !== 'string') return undefined;
  const c = input.replace(/[\s-]/g, '').toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
  if (c.length !== RECOVERY_CODE_LENGTH) return undefined;
  let n = 0n;
  for (const ch of c) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return undefined;
    n = (n << 5n) | BigInt(v);
  }
  if (n >> 128n) return undefined;
  const out = new Uint8Array(RECOVERY_CODE_BYTES);
  for (let i = RECOVERY_CODE_BYTES - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}
