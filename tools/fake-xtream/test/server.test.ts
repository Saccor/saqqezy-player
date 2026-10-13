import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SourceService, SourceAuthError } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { startFakeXtream } from '../src/server.ts';

const NOW = Date.UTC(2026, 9, 13, 18, 10);
let server: Awaited<ReturnType<typeof startFakeXtream>>;
beforeAll(async () => { server = await startFakeXtream({ port: 0, channels: 40, now: () => NOW }); });
afterAll(async () => { await server.close(); });

const svc = () => new SourceService({ storage: new MemoryStorage(), fetch: (u, i) => fetch(u, i), now: () => NOW });
const x = (username: string, password = 'test') =>
  ({ kind: 'xtream' as const, name: 'Fake', server: server.url, username, password });

describe('fake xtream + SourceService end to end', () => {
  test('xtream login, channels, epg and now/next', async () => {
    const s = svc();
    const { source, result } = await s.addSource(x('test'));
    expect(result.channelCount).toBe(40);
    const idx = await s.loadIndex(source.id);
    expect(idx.groups().map((g) => g.name)).toEqual(['Favourites', 'All channels', 'News', 'Movies', 'Kids', 'Music']);
    const epg = await s.refreshEpg(source.id);
    expect(epg.programmes).toBeGreaterThan(40 * 40);
    const first = idx.slice('all', 0, 1);
    const nn = await s.nowNextFor(source.id, first);
    expect(nn.get(first[0]!.id)?.now?.title).toMatch(/^Programme /);
  });

  test('m3u_plus playlist works through the m3u path', async () => {
    const s = svc();
    const { result } = await s.addSource({
      kind: 'm3u', name: 'Fake M3U',
      playlistUrl: `${server.url}/get.php?username=test&password=test&type=m3u_plus`,
      epgUrl: `${server.url}/xmltv.php?username=test&password=test`,
    });
    expect(result.channelCount).toBe(40);
  });

  test('failure modes', async () => {
    await expect(svc().addSource(x('test', 'wrong'))).rejects.toBeInstanceOf(SourceAuthError);
    await expect(svc().addSource(x('expired'))).rejects.toThrow('expired');
    await expect(svc().addSource(x('error500'))).rejects.toMatchObject({ status: 500 });
  });

  test('stream urls redirect to the licensed test stream', async () => {
    const res = await fetch(`${server.url}/live/test/test/1.ts`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8');
  });

  test('CORS headers on responses, redirects, 404s and OPTIONS', async () => {
    const api = await fetch(`${server.url}/player_api.php?username=test&password=test`);
    expect(api.headers.get('access-control-allow-origin')).toBe('*');
    const redirect = await fetch(`${server.url}/live/test/test/1.ts`, { redirect: 'manual' });
    expect(redirect.headers.get('access-control-allow-origin')).toBe('*');
    const missing = await fetch(`${server.url}/nope`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('access-control-allow-origin')).toBe('*');
    const opts = await fetch(`${server.url}/player_api.php`, { method: 'OPTIONS' });
    expect(opts.status).toBe(204);
    expect(opts.headers.get('access-control-allow-origin')).toBe('*');
    expect(opts.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    expect(opts.headers.get('access-control-allow-headers')).toBe('*');
  });
});
