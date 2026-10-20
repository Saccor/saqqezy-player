import { describe, expect, test } from 'vitest';
import { serveFeed, type FeedReader } from '../src/serve.ts';

const files = new Map([['trending/v1/movie.sv.json', { body: '{"v":1}', etag: '"abc"' }]]);
const reader: FeedReader = { get: async (key) => files.get(key) ?? null };
const req = (path: string, init?: RequestInit) => new Request(`https://trending.example.test${path}`, init);

describe('serveFeed', () => {
  test('serves a feed with the cache, ETag, type and CORS headers', async () => {
    const res = await serveFeed(req('/trending/v1/movie.sv.json'), reader);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"v":1}');
    expect(res.headers.get('cache-control')).toBe('public, max-age=21600');
    expect(res.headers.get('etag')).toBe('"abc"');
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    // The Worker sets no cookies and asks for nothing back.
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('If-None-Match with the ETag (also weak or in a list) gives 304 without a body', async () => {
    for (const inm of ['"abc"', 'W/"abc"', '"x", "abc"', '*']) {
      const res = await serveFeed(req('/trending/v1/movie.sv.json', { headers: { 'if-none-match': inm } }), reader);
      expect(res.status).toBe(304);
      expect(await res.text()).toBe('');
      expect(res.headers.get('etag')).toBe('"abc"');
    }
    const other = await serveFeed(req('/trending/v1/movie.sv.json', { headers: { 'if-none-match': '"zzz"' } }), reader);
    expect(other.status).toBe(200);
  });

  test('HEAD has the headers and no body', async () => {
    const res = await serveFeed(req('/trending/v1/movie.sv.json', { method: 'HEAD' }), reader);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  test('unknown paths, unknown files and odd languages are 404', async () => {
    for (const p of ['/trending/v1/movie.en.json', '/trending/v1/music.sv.json', '/trending/v1/movie.SV.json',
      '/trending/v1/movie.sv.json/x', '/trending/v2/movie.sv.json', '/cache/state.json', '/']) {
      expect((await serveFeed(req(p), reader)).status, p).toBe(404);
    }
  });

  test('other methods are 405; OPTIONS answers CORS', async () => {
    expect((await serveFeed(req('/trending/v1/movie.sv.json', { method: 'POST', body: 'x' }), reader)).status).toBe(405);
    const pre = await serveFeed(req('/trending/v1/movie.sv.json', { method: 'OPTIONS' }), reader);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS');
  });

  test('/healthz', async () => {
    const res = await serveFeed(req('/healthz'), reader);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});
