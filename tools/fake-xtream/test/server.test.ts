import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SourceService, SourceAuthError, VodService, buildTrendingIndex, groupVod, matchTrending, parseTrendingFeed } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { startFakeXtream } from '../src/server.ts';
import { ABSENT_MOVIE, ABSENT_SERIES } from '../src/trending.ts';

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

  test('movie 3 plays the generated two-audio movie as the container the URL asks for, mkv by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-media-'));
    mkdirSync(join(dir, 'multiaudio'));
    writeFileSync(join(dir, 'multiaudio', 'film.mkv'), 'mkv');
    writeFileSync(join(dir, 'multiaudio', 'film.ts'), 'ts');
    const withMedia = await startFakeXtream({ port: 0, channels: 1, mediaDir: dir, now: () => NOW });
    try {
      for (const [ext, file] of [['mkv', 'film.mkv'], ['ts', 'film.ts'], ['mp4', 'film.mkv'], ['m3u8', 'film.mkv']]) {
        const r = await fetch(`${withMedia.url}/movie/test/test/3.${ext}`, { redirect: 'manual' });
        expect(r.headers.get('location'), ext).toBe(`${withMedia.url}/media/multiaudio/${file}`);
      }
      const list = await (await fetch(`${withMedia.url}/player_api.php?username=test&password=test&action=get_vod_streams`)).json() as
        { stream_id: number; container_extension: string }[];
      expect(list.find((m) => m.stream_id === 3)?.container_extension).toBe('mkv');
      expect(list.find((m) => m.stream_id === 4)?.container_extension).toBe('m3u8');
      const mkv = await fetch(`${withMedia.url}/media/multiaudio/film.mkv`);
      expect(mkv.headers.get('content-type')).toBe('video/x-matroska');
      expect(await mkv.text()).toBe('mkv');
      expect((await fetch(`${withMedia.url}/media/multiaudio/film.mp4`)).status).toBe(404);
    } finally {
      await withMedia.close();
    }
    const noMedia = await startFakeXtream({ port: 0, channels: 1, mediaDir: join(dir, 'none'), now: () => NOW });
    try {
      const movie3 = await fetch(`${noMedia.url}/movie/test/test/3.mkv`, { redirect: 'manual' });
      expect(movie3.headers.get('location')).toBe('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8');
    } finally {
      await noMedia.close();
    }
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

  test('movie 2 is the generated AC-3 file when present: listed as mkv, redirected to it and served', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-media-'));
    mkdirSync(join(dir, 'ac3'));
    writeFileSync(join(dir, 'ac3', 'film.mkv'), 'MKV');
    const withMedia = await startFakeXtream({ port: 0, channels: 1, mediaDir: dir, now: () => NOW });
    const api = (q: string) => fetch(`${withMedia.url}/player_api.php?username=test&password=test&${q}`).then((r) => r.json());
    try {
      const list = (await api('action=get_vod_streams')) as { stream_id: number; container_extension: string }[];
      expect(list.find((m) => m.stream_id === 2)?.container_extension).toBe('mkv');
      expect(list.find((m) => m.stream_id === 3)?.container_extension).toBe('m3u8');
      const info = (await api('action=get_vod_info&vod_id=2')) as { movie_data: { container_extension: string } };
      expect(info.movie_data.container_extension).toBe('mkv');
      const movie2 = await fetch(`${withMedia.url}/movie/test/test/2.mkv`, { redirect: 'manual' });
      expect(movie2.headers.get('location')).toBe(`${withMedia.url}/media/ac3/film.mkv`);
      const file = await fetch(`${withMedia.url}/media/ac3/film.mkv`);
      expect(file.headers.get('content-type')).toBe('video/x-matroska');
      expect(await file.text()).toBe('MKV');
    } finally {
      await withMedia.close();
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
    expect(opts.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
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

  test('categoryOrder reverse: live groups follow the category list, numbers stay', async () => {
    const rev = await startFakeXtream({ port: 0, channels: 8, categoryOrder: 'reverse', now: () => NOW });
    try {
      const s = svc();
      const { source } = await s.addSource({ kind: 'xtream', name: 'Fake', server: rev.url, username: 'test', password: 'test' });
      const idx = await s.loadIndex(source.id);
      expect(idx.groups().map((g) => g.name)).toEqual(['Favourites', 'All channels', 'Music', 'Kids', 'Movies', 'News']);
      expect(idx.slice('all', 0, 8).map((c) => c.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(idx.byNumber(1)?.name).toBe('Channel 001');
    } finally {
      await rev.close();
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

  test('poster and backdrop art is readable cross-origin, so the TV canvas can draw it untainted', async () => {
    for (const path of ['/poster/m1.svg', '/poster/s3.svg', '/poster/b2.svg', '/poster/e1010101.svg']) {
      const res = await fetch(`${server.url}${path}`, { headers: { origin: 'http://localhost:5173' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/svg+xml');
      // '*' (no credentials): what an <img crossOrigin="anonymous"> needs; the Lightning renderer loads SVGs that way.
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(await res.text()).toMatch(/^<svg /);
    }
    const missing = await fetch(`${server.url}/poster/nope.svg`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('access-control-allow-origin')).toBe('*');
  });

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

describe('fake OpenSubtitles service', () => {
  const OS = () => `${server.url}/opensubtitles/api/v1`;
  const key = { 'Api-Key': 'fake-key', 'X-User-Agent': 'Test v0' };

  test('movies and series carry synthetic TMDB ids', async () => {
    const api = (q: string) => fetch(`${server.url}/player_api.php?username=test&password=test&${q}`).then((r) => r.json());
    expect((await api('action=get_vod_info&vod_id=3')).info.tmdb_id).toBe('900003');
    expect((await api('action=get_series_info&series_id=2')).info.tmdb).toBe('800002');
  });

  test('search lists synthetic subtitles in several languages for any title; languages filter them', async () => {
    const all = await (await fetch(`${OS()}/subtitles?tmdb_id=900003`, { headers: key })).json();
    const langs = all.data.map((d: { attributes: { language: string } }) => d.attributes.language);
    expect(new Set(langs)).toEqual(new Set(['en', 'sv', 'de', 'fr', 'es']));
    expect(all.data[0].attributes.files[0].file_id).toEqual(expect.any(Number));
    const sv = await (await fetch(`${OS()}/subtitles?languages=sv&tmdb_id=900003`, { headers: key })).json();
    expect(sv.data.every((d: { attributes: { language: string } }) => d.attributes.language === 'sv')).toBe(true);
  });

  test('download gives a link to a synthetic SRT; a wrong key is 401; file id 999 is over the quota', async () => {
    const res = await fetch(`${OS()}/download`, { method: 'POST', headers: { ...key, 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: 3002 }) });
    const body = await res.json();
    expect(body.link).toBe(`${server.url}/opensubtitles/file/3002.srt`);
    const file = await (await fetch(body.link)).text();
    expect(file).toMatch(/^1\n00:00:01,000 --> /);
    expect(file).toContain('Synthetic subtitle');
    expect((await fetch(`${OS()}/subtitles?tmdb_id=1`, { headers: { 'Api-Key': 'wrong' } })).status).toBe(401);
    const over = await fetch(`${OS()}/download`, { method: 'POST', headers: { ...key, 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: 999 }) });
    expect(over.status).toBe(406);
  });

  test('preflight allows POST and the key headers', async () => {
    const pre = await fetch(`${OS()}/download`, { method: 'OPTIONS' });
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
    expect(pre.headers.get('access-control-allow-headers')).toBe('*');
  });
});

test('sports option: synthetic matches on numbered channels, with a highlight show, a replay and a non-sports "vs" film', async () => {
  const s = await startFakeXtream({ port: 0, channels: 40, sports: true, now: () => Date.UTC(2026, 9, 19, 18, 10) });
  try {
    const xml = await (await fetch(`${s.url}/xmltv.php?username=test&password=test`)).text();
    expect(xml).toContain('<title>LIVE: Northbridge FC v Eastport</title>');
    expect(xml).toContain('<title>Eastport - Northbridge FC</title>');
    expect(xml).toContain('<category lang="en">Sports</category>');
    expect(xml).toContain('Highlights');
    expect(xml).toContain('<previously-shown/>');
    expect(xml).toContain('<title>Hollis vs Hollis</title>');
  } finally {
    await s.close();
  }
});

describe('fake trending feed', () => {
  const both = () => {
    const storage = new MemoryStorage();
    const deps = { storage, fetch: (u: string, i?: RequestInit) => fetch(u, i), now: () => NOW };
    return { sources: new SourceService(deps), vod: new VodService(deps) };
  };
  const feedUrl = (kind: string, lang = 'en') => `${server.url}/__trending/v1/${kind}.${lang}.json`;

  test('movie and series feeds in English, with CORS; other languages are 404', async () => {
    const res = await fetch(feedUrl('movie'));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const feed = await res.json();
    expect(feed).toMatchObject({ v: 1, kind: 'movie', lang: 'en' });
    expect(feed.items.map((i: { rank: number }) => i.rank)).toEqual(feed.items.map((_: unknown, k: number) => k + 1));
    expect(feed.items.every((i: { wd: string }) => /^Q9\d{6}$/.test(i.wd))).toBe(true);
    expect((await fetch(feedUrl('series', 'sv'))).status).toBe(404);
    expect((await fetch(feedUrl('music'))).status).toBe(404);
  });

  test('every third title carries a tmdb id in the lists, the same id as in the feed', async () => {
    const api = (q: string) => fetch(`${server.url}/player_api.php?username=test&password=test&${q}`).then((r) => r.json());
    const movies: { stream_id: number; tmdb?: string }[] = await api('action=get_vod_streams');
    expect(movies.find((m) => m.stream_id === 3)?.tmdb).toBe('900003');
    expect(movies.find((m) => m.stream_id === 4)?.tmdb).toBeUndefined();
    const series: { series_id: number; tmdb?: string }[] = await api('action=get_series');
    expect(series.find((s) => s.series_id === 6)?.tmdb).toBe('800006');
  });

  test('matched against the fake catalogue: most feed titles are found, the absent ones never', async () => {
    const { sources, vod } = both();
    const { source } = await sources.addSource(x('test'));
    for (const kind of ['movie', 'series'] as const) {
      await vod.refresh(source.id, kind);
      const catalog = await vod.loadCatalog(source.id, kind);
      const groups = groupVod(catalog.source).groups;
      const feed = parseTrendingFeed(await (await fetch(feedUrl(kind))).json(), kind)!;
      const hits = matchTrending(feed, kind, buildTrendingIndex(groups), 150).map((g) => groups[g]!.display);
      expect(hits).not.toContain(kind === 'movie' ? ABSENT_MOVIE : ABSENT_SERIES);
      expect(hits).toHaveLength(feed.items.length - 1);
      expect(feed.items.some((i) => i.tmdb === undefined && i.year === undefined)).toBe(kind === 'series');
    }
  });
});

describe('showcase mode', () => {
  test('lists only invented names with generated artwork, never the numbered placeholders', async () => {
    const sc = await startFakeXtream({ port: 0, channels: 12, now: () => NOW, showcase: true });
    try {
      const api = (action: string) => fetch(`${sc.url}/player_api.php?username=test&password=test&action=${action}`).then((r) => r.json());
      const live = await api('get_live_streams') as { name: string; stream_icon: string }[];
      expect(live[0]).toMatchObject({ name: 'Northbridge News', stream_icon: `${sc.url}/logo/c1.svg` });
      const vod = await api('get_vod_streams') as { name: string }[];
      const series = await api('get_series') as { name: string }[];
      expect([...live, ...vod, ...series].map((x) => x.name).join('|')).not.toMatch(/Synthetic|Channel \d/);
      const guide = await fetch(`${sc.url}/xmltv.php?username=test&password=test`).then((r) => r.text());
      expect(guide).not.toMatch(/Programme \d|Synthetic/);
      const poster = await fetch(`${sc.url}/poster/m1.svg`).then((r) => r.text());
      expect(poster).toContain('THE QUIET');
      expect(await fetch(`${sc.url}/logo/c1.svg`).then((r) => r.text())).toContain('>NN<');
    } finally {
      await sc.close();
    }
  });
});

describe('deadLive: a live stream variant that never plays (failover testing)', () => {
  test('streams whose name ends with the suffix answer 404; the others still redirect', async () => {
    const dead = await startFakeXtream({ port: 0, channels: 8, versions: true, deadLive: ' 4K', now: () => NOW });
    try {
      const list = await (await fetch(`${dead.url}/player_api.php?username=test&password=test&action=get_live_streams`)).json() as
        { stream_id: number; name: string }[];
      const k4 = list.find((c) => c.name.endsWith(' 4K'))!;
      const hd = list.find((c) => c.name.endsWith(' HD'))!;
      const get = (id: number) => fetch(`${dead.url}/live/test/test/${id}.ts`, { redirect: 'manual' });
      expect((await get(k4.stream_id)).status).toBe(404);
      expect((await get(hd.stream_id)).status).toBe(302);
    } finally {
      await dead.close();
    }
  });
});

describe('connection limit mode', () => {
  const sidOf = (location: string | null) => /\/__mv\/(s\d+)\/live\.m3u8$/.exec(location ?? '')?.[1];

  test('refuse: a live open past N answers 403 while the first session is read; reset frees it', async () => {
    const s = await startFakeXtream({ port: 0, channels: 4, now: () => NOW, connections: { max: 1, mode: 'refuse' } });
    try {
      const first = await fetch(`${s.url}/live/test/test/1.ts`, { redirect: 'manual' });
      expect(first.status).toBe(302);
      const sid = sidOf(first.headers.get('location'));
      expect(first.headers.get('location')).toBe(`${s.url}/__mv/${sid}/live.m3u8`);
      const list = await fetch(`${s.url}/__mv/${sid}/live.m3u8`);
      expect(list.status).toBe(200);
      expect(list.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
      expect(await list.text()).toContain(`/__mv/${sid}/`);
      const seg = await fetch(`${s.url}/__mv/${sid}/5.ts`, { redirect: 'manual' });
      expect(seg.status).toBe(302);
      expect((await fetch(`${s.url}/live/test/test/2.ts`, { redirect: 'manual' })).status).toBe(403);
      expect(await (await fetch(`${s.url}/__control/connections`)).json()).toMatchObject({ max: 1, mode: 'refuse', refused: 1, open: { test: 1 } });
      await fetch(`${s.url}/__control/connections?reset=1`);
      expect((await fetch(`${s.url}/live/test/test/2.ts`, { redirect: 'manual' })).status).toBe(302);
      // Movies are not counted.
      expect((await fetch(`${s.url}/movie/test/test/4.m3u8`, { redirect: 'manual' })).status).toBe(302);
    } finally {
      await s.close();
    }
  });

  test('kick: the open past N plays and the oldest session answers 403 from then on', async () => {
    const s = await startFakeXtream({ port: 0, channels: 4, now: () => NOW, connections: { max: 1, mode: 'kick' } });
    try {
      const a = sidOf((await fetch(`${s.url}/live/test/test/1.m3u8`, { redirect: 'manual' })).headers.get('location'));
      const b = await fetch(`${s.url}/live/test/test/2.m3u8`, { redirect: 'manual' });
      expect(b.status).toBe(302);
      expect((await fetch(`${s.url}/__mv/${a}/live.m3u8`)).status).toBe(403);
      expect((await fetch(`${s.url}/__mv/${a}/1.ts`, { redirect: 'manual' })).status).toBe(403);
      expect((await fetch(`${s.url}/__mv/${sidOf(b.headers.get('location'))}/live.m3u8`)).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  test('off by default: no wrapper, and the control route says so', async () => {
    expect(await (await fetch(`${server.url}/__control/connections`)).json()).toEqual({ off: true });
  });
});
