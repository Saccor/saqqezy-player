import { describe, expect, test } from 'vitest';
import {
  fromB64Url,
  newPairingCode,
  newQrSecrets,
  normalizeCode,
  PairingError,
  secretsFromCode,
  secretsFromQrFragment,
  toB64Url,
} from '../src/index.ts';

const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function encryptWith(key: CryptoKey, data: Uint8Array): Promise<{ iv: Uint8Array; ct: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  return { iv, ct };
}

async function decryptWith(key: CryptoKey, iv: Uint8Array, ct: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}

describe('base64url', () => {
  test('round trips every length 0..64 and all byte values', () => {
    for (let n = 0; n <= 64; n++) {
      const b = crypto.getRandomValues(new Uint8Array(n));
      const s = toB64Url(b);
      expect(s).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(Array.from(fromB64Url(s))).toEqual(Array.from(b));
    }
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(Array.from(fromB64Url(toB64Url(all)))).toEqual(Array.from(all));
  });

  test('matches the standard encoding without padding', () => {
    expect(toB64Url(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe('-_-_');
    expect(toB64Url(new TextEncoder().encode('ab'))).toBe('YWI');
  });

  test('rejects invalid characters and impossible lengths', () => {
    expect(() => fromB64Url('ab+c')).toThrow();
    expect(() => fromB64Url('ab/c')).toThrow();
    expect(() => fromB64Url('abc=')).toThrow();
    expect(() => fromB64Url('abcde')).toThrow();
  });
});

describe('pairing code format', () => {
  test('newPairingCode uses Crockford base32 in XXXX-XXXX-XXXX', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = newPairingCode();
      expect(c).toMatch(CROCKFORD);
      seen.add(c);
    }
    expect(seen.size).toBe(200);
  });

  test('normalizeCode handles case, dashes, spaces and I/L/O', () => {
    expect(normalizeCode('7k3m-9qx2-abcd')).toBe('7K3M9QX2ABCD');
    expect(normalizeCode('7K3M9QX2ABCD')).toBe('7K3M9QX2ABCD');
    expect(normalizeCode(' 7k3m 9qx2-abcd ')).toBe('7K3M9QX2ABCD');
    expect(normalizeCode('iLoO-1100-ABCD')).toBe('11001100ABCD');
    expect(normalizeCode('ilo0-ILO0-abcd')).toBe('11001100ABCD');
  });

  test('normalizeCode rejects wrong length and bad characters', () => {
    expect(normalizeCode('')).toBeNull();
    expect(normalizeCode('7K3M-9QX2-ABC')).toBeNull();
    expect(normalizeCode('7K3M-9QX2-ABCDE')).toBeNull();
    expect(normalizeCode('7K3M-9QX2-ABCU')).toBeNull(); // U is not Crockford
    expect(normalizeCode('7K3M-9QX2-AB*D')).toBeNull();
    expect(normalizeCode('7K3M_9QX2_ABCD')).toBeNull();
  });
});

describe('code-mode key derivation', () => {
  test('fixed sessionId test vector', async () => {
    const s = await secretsFromCode('7K3M-9QX2-ABCD');
    // SHA-256("iptv-pair-id" || "7K3M9QX2ABCD")[0..16]
    expect(hex(s.sessionId)).toBe('764eee4eddd56b03930fddae02598156');
    expect(s.sessionIdB64).toBe('dk7uTt3VawOTD92uAlmBVg');
  });

  test('is deterministic: same code (any spelling) gives the same sessionId and key', async () => {
    const a = await secretsFromCode('7K3M-9QX2-ABCD');
    const b = await secretsFromCode('7k3m9qx2abcd');
    expect(hex(a.sessionId)).toBe(hex(b.sessionId));
    const msg = new TextEncoder().encode('synthetic payload');
    const { iv, ct } = await encryptWith(a.key, msg);
    expect(Array.from(await decryptWith(b.key, iv, ct))).toEqual(Array.from(msg));
  });

  test('different codes give different sessionIds and keys', async () => {
    const a = await secretsFromCode('7K3M-9QX2-ABCD');
    const b = await secretsFromCode('7K3M-9QX2-ABCE');
    expect(hex(a.sessionId)).not.toBe(hex(b.sessionId));
    const { iv, ct } = await encryptWith(a.key, new Uint8Array([1, 2, 3]));
    await expect(decryptWith(b.key, iv, ct)).rejects.toThrow();
  });

  test('rejects an invalid code with PairingError', async () => {
    await expect(secretsFromCode('nope')).rejects.toBeInstanceOf(PairingError);
  });

  test('key is not extractable', async () => {
    const a = await secretsFromCode('7K3M-9QX2-ABCD');
    expect(a.key.extractable).toBe(false);
  });
});

describe('QR secrets', () => {
  test('newQrSecrets builds a URL whose fragment parses back to the same secrets', async () => {
    const q = await newQrSecrets();
    expect(q.sessionId.length).toBe(16);
    expect(q.sessionIdB64).toBe(toB64Url(q.sessionId));
    const url = q.url('http://companion.example.test');
    expect(url).toMatch(/^http:\/\/companion\.example\.test\/#s=[A-Za-z0-9_-]{22}&k=[A-Za-z0-9_-]{43}$/);
    expect(q.url('http://companion.example.test/')).toBe(url);
    const frag = url.slice(url.indexOf('#'));
    const p = await secretsFromQrFragment(frag);
    expect(hex(p.sessionId)).toBe(hex(q.sessionId));
    const { iv, ct } = await encryptWith(q.key, new Uint8Array([9, 8, 7]));
    expect(Array.from(await decryptWith(p.key, iv, ct))).toEqual([9, 8, 7]);
  });

  test('accepts s and k in either order, with or without the leading #', async () => {
    const s = toB64Url(new Uint8Array(16).fill(1));
    const k = toB64Url(new Uint8Array(32).fill(2));
    const a = await secretsFromQrFragment(`s=${s}&k=${k}`);
    const b = await secretsFromQrFragment(`#k=${k}&s=${s}`);
    expect(hex(a.sessionId)).toBe(hex(b.sessionId));
    expect(a.sessionIdB64).toBe(s);
    const { iv, ct } = await encryptWith(a.key, new Uint8Array([4]));
    expect(Array.from(await decryptWith(b.key, iv, ct))).toEqual([4]);
  });

  test('rejects bad lengths, missing fields, duplicates and bad base64', async () => {
    const s = toB64Url(new Uint8Array(16));
    const k = toB64Url(new Uint8Array(32));
    const bad = [
      `s=${toB64Url(new Uint8Array(15))}&k=${k}`,
      `s=${toB64Url(new Uint8Array(17))}&k=${k}`,
      `s=${s}&k=${toB64Url(new Uint8Array(31))}`,
      `s=${s}&k=${toB64Url(new Uint8Array(33))}`,
      `s=${s}`,
      `k=${k}`,
      '',
      `s=${s}&k=${k}&s=${s}`,
      `s=${s}&k=${k.slice(0, -1)}+`,
    ];
    for (const f of bad) {
      await expect(secretsFromQrFragment(f)).rejects.toBeInstanceOf(PairingError);
    }
  });
});
