import { describe, expect, test } from 'vitest';
import type { SourceConfig } from '../../src/types.ts';
import {
  SFP_LENGTH, canonicalSourceIdentity, deriveFingerprintKey, fromSid, sourceFingerprint, toSid,
} from '../../src/sync/ref.ts';

const xt = (server: string, username = 'viewer01', password = 'secret'): SourceConfig =>
  ({ kind: 'xtream', id: 'a1', name: 'Mine', server, username, password });
const m3u = (playlistUrl: string): SourceConfig => ({ kind: 'm3u', id: 'b2', name: 'Mine', playlistUrl });
const sk = (fill: number) => new Uint8Array(32).fill(fill);

describe('canonical source identity', () => {
  test('Xtream: lower-cased host:port with the default port filled in, plus the user name; never the password', () => {
    const c = canonicalSourceIdentity(xt('Panel.Example.TEST'));
    expect(c).toBe('xtream\npanel.example.test:80\nviewer01');
    expect(canonicalSourceIdentity(xt('http://panel.example.test:80/'))).toBe(c);
    expect(canonicalSourceIdentity(xt('  http://PANEL.example.test  '))).toBe(c);
    expect(canonicalSourceIdentity(xt('https://panel.example.test'))).toBe('xtream\npanel.example.test:443\nviewer01');
    expect(canonicalSourceIdentity(xt('panel.example.test:8080'))).toBe('xtream\npanel.example.test:8080\nviewer01');
    expect(canonicalSourceIdentity(xt('panel.example.test', 'viewer01', 'other'))).toBe(c);
    expect(c).not.toContain('secret');
    expect(canonicalSourceIdentity(xt('panel.example.test', 'Viewer01'))).not.toBe(c);
  });

  test('M3U: scheme and host lower-cased, default port and fragment dropped, path and query kept', () => {
    const c = canonicalSourceIdentity(m3u('http://lists.example.test/p.m3u?u=1'));
    expect(c).toBe('m3u\nhttp://lists.example.test/p.m3u?u=1');
    expect(canonicalSourceIdentity(m3u(' HTTP://Lists.Example.test:80/p.m3u?u=1#top '))).toBe(c);
    expect(canonicalSourceIdentity(m3u('http://lists.example.test/p.m3u?u=2'))).not.toBe(c);
    expect(canonicalSourceIdentity(m3u('http://lists.example.test/P.m3u?u=1'))).not.toBe(c);
  });

  test('M3U: a value that is not a URL is kept trimmed', () => {
    expect(canonicalSourceIdentity(m3u('  not a url '))).toBe('m3u\nnot a url');
  });
});

describe('source fingerprint', () => {
  test('HMAC under K_fp: deterministic, 128-bit base64url, per key and per account', async () => {
    const k1 = await deriveFingerprintKey(sk(1));
    const k1again = await deriveFingerprintKey(sk(1));
    const k2 = await deriveFingerprintKey(sk(2));
    const a = await sourceFingerprint(k1, xt('panel.example.test'));
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).toHaveLength(SFP_LENGTH);
    expect(await sourceFingerprint(k1again, xt('http://PANEL.example.test:80'))).toBe(a);
    expect(await sourceFingerprint(k2, xt('panel.example.test'))).not.toBe(a);
    expect(await sourceFingerprint(k1, xt('panel.example.test', 'viewer02'))).not.toBe(a);
    expect(await sourceFingerprint(k1, m3u('http://panel.example.test/'))).not.toBe(a);
  });

  test('the fingerprint key cannot be exported', async () => {
    const k = await deriveFingerprintKey(sk(3));
    expect(k.extractable).toBe(false);
    expect(k.algorithm).toMatchObject({ name: 'HMAC' });
  });

  test('a sync key must be 32 bytes', async () => {
    await expect(deriveFingerprintKey(new Uint8Array(16))).rejects.toThrow('32 bytes');
  });
});

describe('sid', () => {
  test('strips the source prefix of source-scoped ids and adds it back', () => {
    expect(toSid('a1', 'a1:x101')).toBe('x101');
    expect(fromSid('b2', 'x101')).toBe('b2:x101');
    // Group ids carry no source prefix and pass through unchanged.
    expect(toSid('a1', 'g:News')).toBe('g:News');
    expect(toSid('a1', 'a10:x1')).toBe('a10:x1');
  });
});
