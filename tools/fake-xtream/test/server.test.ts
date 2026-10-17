import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SourceService, SourceAuthError, VodService } from '@iptv/core';
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

  test('movie 1 plays the generated multi-track title when present, served with its playlists and cues', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-media-'));
    mkdirSync(join(dir, 'multitrack'));
    writeFileSync(join(dir, 'multitrack', 'master.m3u8'), '#EXTM3U\n');
    writeFileSync(join(dir, 'multitrack', 'subs_eng.vtt'), 'WEBVTT\n');
    const withMedia = await startFakeXtream({ port: 0, channels: 1, mediaDir: dir, now: () => NOW });
    try {
      const movie1 = await fetch(`${withMedia.url}/movie/test/test/1.m3u8`, { redirect: 'manual' });
      expect(movie1.headers.get('location')).toBe(`${withMedia.url}/media/multitrack/master.m3u8`);
      const movie2 = await fetch(`${withMedia.url}/movie/test/test/2.m3u8`, { redirect: 'manual' });
      expect(movie2.headers.get('location')).toBe('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8');
      const master = await fetch(`${withMedia.url}/media/multitrack/master.m3u8`);
      expect(master.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
      expect(master.headers.get('access-control-allow-origin')).toBe('*');
      expect(await master.text()).toBe('#EXTM3U\n');
      expect((await fetch(`${withMedia.url}/media/multitrack/subs_eng.vtt`)).headers.get('content-type')).toBe('text/vtt');
      expect((await fetch(`${withMedia.url}/media/multitrack/missing.ts`)).status).toBe(404);
      expect((await fetch(`${withMedia.url}/media/multitrack/..%2F..%2Fsecret`)).status).toBe(404);
    } finally {
      await withMedia.close();
    }
    const noMedia = await startFakeXtream({ port: 0, channels: 1, mediaDir: join(dir, 'none'), now: () => NOW });
    try {
      const movie1 = await fetch(`${noMedia.url}/movie/test/test/1.m3u8`, { redirect: 'manual' });
      expect(movie1.headers.get('location')).toBe('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8');
    } finally {
      await noMedia.close();
    }
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

describe('fake xtream options', () => {
  test('epgChannels limits the XMLTV guide to the first N channels', async () => {
    const partial = await startFakeXtream({ port: 0, channels: 10, epgChannels: 3, now: () => NOW });
    try {
      const xml = await (await fetch(`${partial.url}/xmltv.php?username=test&password=test`)).text();
      const ids = new Set([...xml.matchAll(/channel="([^"]+)"/g)].map((m) => m[1]));
      expect([...ids].sort()).toEqual(['c1.test', 'c2.test', 'c3.test']);
      expect(xml.match(/<channel id=/g)).toHaveLength(3);
      const streams = await (await fetch(`${partial.url}/player_api.php?username=test&password=test&action=get_live_streams`)).json();
      expect(streams).toHaveLength(10);
    } finally {
      await partial.close();
    }
  });

  test('refusal mode answers 403 to everything and counts it', async () => {
    const ctl = (q = '') => fetch(`${server.url}/__control/refuse${q}`).then((r) => r.json());
    expect(await ctl('?on=1')).toEqual({ refusing: true, refused: 0 });
    expect((await fetch(`${server.url}/player_api.php?username=test&password=test`)).status).toBe(403);
    expect((await fetch(`${server.url}/live/test/test/1.ts`, { redirect: 'manual' })).status).toBe(403);
    expect(await ctl()).toEqual({ refusing: true, refused: 2 });
    expect(await ctl('?on=0')).toEqual({ refusing: false, refused: 0 });
    expect((await fetch(`${server.url}/player_api.php?username=test&password=test`)).status).toBe(200);
  });
});

describe('fake xtream source-retry test users', () => {
  const stream = (user: string, kind = 'live', ext = 'ts') => fetch(`${server.url}/${kind}/${user}/test/1.${ext}`, { redirect: 'manual' });

  test('refuse403: streams answer 403, the login works like test', async () => {
    expect((await stream('refuse403')).status).toBe(403);
    expect((await stream('refuse403', 'movie', 'mp4')).status).toBe(403);
    const { result } = await svc().addSource(x('refuse403'));
    expect(result.channelCount).toBe(40);
  });

  test('limit429: streams answer 429 with a readable Retry-After of 90 s', async () => {
    const res = await stream('limit429');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('90');
    expect(res.headers.get('access-control-expose-headers')).toMatch(/retry-after/i);
    expect((await svc().addSource(x('limit429'))).result.channelCount).toBe(40);
  });

  test('gone404: streams answer 404, the login works like test', async () => {
    expect((await stream('gone404')).status).toBe(404);
    expect((await stream('gone404', 'series', 'mp4')).status).toBe(404);
    expect((await svc().addSource(x('gone404'))).result.channelCount).toBe(40);
  });

  test('down500: player_api answers 500, its streams still redirect', async () => {
    expect((await fetch(`${server.url}/player_api.php?username=down500&password=test`)).status).toBe(500);
    await expect(svc().addSource(x('down500'))).rejects.toMatchObject({ status: 500 });
    expect((await stream('down500')).status).toBe(302);
    expect((await fetch(`${server.url}/get.php?username=down500&password=test`)).status).toBe(200);
  });
});

describe('fake xtream VOD end to end', () => {
  const both = () => {
    const storage = new MemoryStorage();
    const deps = { storage, fetch: (u: string, i?: RequestInit) => fetch(u, i), now: () => NOW };
    return { storage, sources: new SourceService(deps), vod: new VodService(deps) };
  };

  test('movies and series via Xtream, per category', async () => {
    const { sources, vod } = both();
    const { source } = await sources.addSource(x('test'));
    expect(await vod.refresh(source.id, 'movie')).toMatchObject({ count: 120, truncated: false });
    const movies = await vod.loadCatalog(source.id, 'movie');
    expect(movies.categories().map((c) => [c.name, c.count])).toEqual([['Drama', 30], ['Comedy', 30], ['Documentary', 30], ['Family', 30]]);
    const first = movies.slice('all', 'added', 0, 1).rows[0]!;
    expect(first.poster).toMatch(/\/poster\/m\d+\.svg$/);
    expect((await vod.movieDetail(source.id, first)).plot).toMatch(/^Synthetic plot/);
    const url = await vod.streamUrl(source.id, first);
    expect((await fetch(url, { redirect: 'manual' })).status).toBe(302);
    expect((await fetch(first.poster!)).headers.get('content-type')).toBe('image/svg+xml');

    expect((await vod.refresh(source.id, 'series')).count).toBe(12);
    const show = (await vod.loadCatalog(source.id, 'series')).slice('all', 'title', 0, 1).rows[0]!;
    const detail = await vod.seriesDetail(source.id, show);
    expect(detail.seasons.length).toBeGreaterThan(0);
    const ep = detail.seasons[0]!.episodes[0]!;
    expect((await fetch(await vod.streamUrl(source.id, ep), { redirect: 'manual' })).status).toBe(302);
  });

  test('a server that ignores category_id gives the same catalogue', async () => {
    const { sources, vod } = both();
    const { source } = await sources.addSource(x('vodall'));
    expect(await vod.refresh(source.id, 'movie')).toMatchObject({ count: 120, truncated: false });
  });

  test('M3U: movie and series entries are split out of the channel list', async () => {
    const { sources, vod } = both();
    const { source, result } = await sources.addSource({
      kind: 'm3u', name: 'Fake M3U', playlistUrl: `${server.url}/get.php?username=test&password=test&type=m3u_plus`,
    });
    expect(result).toEqual({ channelCount: 40, skipped: 0, movieCount: 6, seriesCount: 1 });
    const show = (await vod.loadCatalog(source.id, 'series')).slice('all', 'title', 0, 1).rows[0]!;
    expect((await vod.seriesDetail(source.id, show)).seasons.map((s) => s.episodes.length)).toEqual([3, 3]);
  });
});
