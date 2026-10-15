import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { SourceService, VodCatalog, VodService, type FetchFn, type VodItem, type VodKind, type VodList } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { startFakeXtream } from '@iptv/fake-xtream';
import {
  VOD_HOME_ROWS_WITH_ITEMS, VOD_ROW_CONTINUE, VOD_ROW_FAVOURITES, VOD_ROW_RECENT, VodController,
} from '../src/vodController.ts';
import type { AppEvent } from '../src/types.ts';

const NOW = Date.UTC(2026, 9, 15, 18, 0);
let server: Awaited<ReturnType<typeof startFakeXtream>>;
beforeAll(async () => { server = await startFakeXtream({ port: 0, channels: 4, movies: 24, series: 6, now: () => NOW }); });
afterAll(async () => { await server.close(); });

let storage: MemoryStorage;
let failVod: boolean;
beforeEach(() => {
  storage = new MemoryStorage();
  failVod = false;
});

const fetchFn: FetchFn = async (u, i) => {
  if (failVod && /action=get_(vod|series)/.test(u)) throw new TypeError('fetch failed');
  return fetch(u, i);
};

async function setup(kind: 'xtream' | 'm3u' = 'xtream') {
  const deps = { storage, fetch: fetchFn, now: () => NOW };
  const sources = new SourceService(deps);
  const vod = new VodService(deps);
  const { source } = await sources.addSource(kind === 'xtream'
    ? { kind: 'xtream', name: 'Fake', server: server.url, username: 'test', password: 'test' }
    : { kind: 'm3u', name: 'Fake M3U', playlistUrl: `${server.url}/get.php?username=test&password=test&type=m3u_plus` });
  const events: AppEvent[] = [];
  const recorded: string[] = [];
  const c = new VodController({
    vod,
    emit: (e) => events.push(e),
    record: (where, err) => {
      recorded.push(where);
      return err instanceof Error ? err : new Error(String(err));
    },
  });
  c.reset(source.id);
  return { c, vod, sources, sourceId: source.id, events, recorded };
}

describe('VodController home', () => {
  test('a stored but emptied catalogue that is being refetched reads as loading', async () => {
    const { c, sourceId } = await setup();
    await storage.replaceVod(sourceId, 'movie', { items: [], categories: [] });
    expect(await c.home('movie')).toEqual({ status: 'loading', rows: [], truncated: false });
    await c.idle();
    expect((await c.home('movie')).status).toBe('ready');
  });

  test('a stored empty catalogue whose fetch failed reads as error, not empty', async () => {
    const { c, sourceId } = await setup();
    await storage.replaceVod(sourceId, 'movie', { items: [], categories: [] });
    failVod = true;
    expect((await c.home('movie')).status).toBe('loading');
    await c.idle();
    const h = await c.home('movie');
    expect(h.status).toBe('error');
    expect(h.rows).toEqual([]);
    expect(h.error?.message).toBeTruthy();
  });

  test('Xtream, nothing stored: loading, then ready with recent and category rows', async () => {
    const { c, events, sourceId } = await setup();
    expect(await c.home('movie')).toEqual({ status: 'loading', rows: [], truncated: false });
    await c.idle();
    expect(events.map((e) => e.type)).toEqual(['vodLoading', 'vodRefreshed']);
    expect(events[1]).toMatchObject({ sourceId, kind: 'movie', count: 24, truncated: false });
    const home = await c.home('movie');
    expect(home.status).toBe('ready');
    expect(home.rows.map((r) => [r.id, r.total])).toEqual([[VOD_ROW_RECENT, 24], ['1', 6], ['2', 6], ['3', 6], ['4', 6]]);
    expect(home.rows.map((r) => r.title)).toEqual(['Recently added', 'Drama', 'Comedy', 'Documentary', 'Family']);
    expect(home.rows[1]!.items[0]).toMatchObject({ kind: 'movie', watched: false, favourite: false });
    expect(home.rows[1]!.items[0]!.poster).toMatch(/\/poster\/m\d+\.svg$/);
  });

  test('stored and fresh: ready at once, no fetch', async () => {
    const { c, events } = await setup();
    await c.refresh('movie');
    events.length = 0;
    expect((await c.home('movie')).status).toBe('ready');
    await c.idle();
    expect(events).toEqual([]);
  });

  test('M3U: ready from the playlist without any fetch; a kind with nothing is empty', async () => {
    const { c, events } = await setup('m3u');
    expect((await c.home('movie')).rows.map((r) => r.total)).toEqual([2, 2, 1, 1]);
    expect(events).toEqual([]);
    await storage.replaceVod((await storage.listSources())[0]!.id, 'series', { items: [], categories: [] });
    expect(await c.home('series')).toEqual({ status: 'empty', rows: [], truncated: false });
  });

  test('a failed first fetch: error status, one failure event, no automatic retry until refresh', async () => {
    const { c, events, recorded } = await setup();
    failVod = true;
    await c.home('movie');
    await c.idle();
    expect(events.map((e) => e.type)).toEqual(['vodLoading', 'vodRefreshFailed']);
    expect(recorded).toEqual(['refreshVod']);
    const h = await c.home('movie');
    expect(h.status).toBe('error');
    expect(h.error?.message).toBeTruthy();
    await c.idle();
    expect(events).toHaveLength(2);
    failVod = false;
    await c.refresh('movie');
    expect((await c.home('movie')).status).toBe('ready');
  });
});

describe('VodController residency and source changes', () => {
  test('one kind resident: switching kinds reloads, the same kind does not', async () => {
    const { c, vod } = await setup();
    await c.refresh('movie');
    await c.refresh('series');
    const spy = vi.spyOn(vod, 'storedCatalog');
    c.reset((await storage.listSources())[0]!.id);
    await c.home('movie');
    await c.home('movie');
    await c.home('series');
    await c.home('movie');
    expect(spy.mock.calls.map((a) => a[1])).toEqual(['movie', 'series', 'movie']);
  });

  test('preload loads the stored movie catalogue once, without a fetch', async () => {
    const { c, vod, events } = await setup();
    const spy = vi.spyOn(vod, 'storedCatalog');
    await c.preload('movie');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    await c.refresh('movie');
    spy.mockClear();
    c.reset((await storage.listSources())[0]!.id);
    await c.preload('movie');
    await c.preload('movie');
    await c.home('movie');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('reset cancels an in-flight fetch: no refreshed event, nothing stored', async () => {
    const { c, events, sourceId } = await setup();
    await c.home('movie');
    c.reset(undefined);
    await c.idle();
    expect(events.map((e) => e.type)).toEqual(['vodLoading']);
    expect(await storage.getVod(sourceId, 'movie')).toBeUndefined();
  });

  test('no active source: empty home and categories', async () => {
    const { c } = await setup();
    c.reset(undefined);
    expect(await c.home('movie')).toEqual({ status: 'empty', rows: [], truncated: false });
    expect(await c.categories('movie')).toEqual([]);
  });
});

describe('VodController categories and slices', () => {
  test('rail: pseudo-categories, then source categories', async () => {
    const { c } = await setup();
    await c.refresh('movie');
    const cats = await c.categories('movie');
    expect(cats.map((x) => [x.id, x.name, x.count])).toEqual([
      [VOD_ROW_CONTINUE, 'Continue watching', 0], [VOD_ROW_FAVOURITES, 'Favourites', 0], [VOD_ROW_RECENT, 'Recently added', 24],
      ['all', 'All movies', 24], ['1', 'Drama', 6], ['2', 'Comedy', 6], ['3', 'Documentary', 6], ['4', 'Family', 6],
    ]);
  });

  test('slices: categories with sort, recent capped, empty pseudo-rows', async () => {
    const { c } = await setup();
    await c.refresh('movie');
    const drama = await c.slice('movie', '1', 'title', 0, 3);
    expect(drama.total).toBe(6);
    expect(drama.rows.map((t) => t.title)).toEqual([...drama.rows.map((t) => t.title)].sort());
    const recent = await c.slice('movie', VOD_ROW_RECENT, 'title', 0, 5);
    expect(recent.total).toBe(24);
    expect(recent.rows[0]!.title).toMatch(/^Synthetic Film 001\b/);
    expect(await c.slice('movie', VOD_ROW_CONTINUE, 'title', 0, 5)).toEqual({ total: 0, rows: [] });
  });
});

describe('VodController user state on slices', () => {
  test('a cold Recently added slice carries favourite state', async () => {
    const { c, sourceId } = await setup();
    await c.refresh('movie');
    const newest = (await c.slice('movie', VOD_ROW_RECENT, 'title', 0, 1)).rows[0]!;
    await storage.putVodUser(sourceId, newest.id, { position: 0, duration: 0, watched: false, favourite: true, updatedAt: 0 });
    c.reset(sourceId);
    const page = await c.slice('movie', VOD_ROW_RECENT, 'title', 0, 1);
    expect(page.rows[0]).toMatchObject({ id: newest.id, favourite: true });
  });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const item = (kind: VodKind, n: number): VodItem => ({ id: `s:${kind}${n}`, kind, title: `Synthetic ${kind} ${n}`, categoryId: '1' });
const listOf = (kind: VodKind, ...ns: number[]): VodList => ({ items: ns.map((n) => item(kind, n)), categories: [{ id: '1', kind, name: 'Cat', count: ns.length }] });

function fakeController() {
  const calls = { stored: [] as VodKind[], refresh: 0 };
  const fake = {
    storedCatalog: async (_id: string, kind: VodKind): Promise<VodCatalog | undefined> => { calls.stored.push(kind); return undefined; },
    needsRefresh: async (): Promise<boolean> => false,
    refresh: async (_id: string, kind: VodKind) => { calls.refresh++; return { count: 0, truncated: false, list: listOf(kind) }; },
    listUser: async () => [],
  };
  const events: AppEvent[] = [];
  const c = new VodController({ vod: fake as unknown as VodService, emit: (e) => events.push(e), record: (_w, err) => (err instanceof Error ? err : new Error(String(err))) });
  c.reset('src');
  return { c, fake, calls, events };
}

describe('VodController races', () => {
  test('a reset during needsRefresh starts no fetch for the old source', async () => {
    const { c, fake, calls, events } = fakeController();
    const gate = deferred<boolean>();
    fake.needsRefresh = () => gate.promise;
    const home = c.home('movie');
    await new Promise((r) => setTimeout(r, 0));
    c.reset(undefined);
    gate.resolve(true);
    expect(await home).toEqual({ status: 'empty', rows: [], truncated: false });
    await c.idle();
    expect(events).toEqual([]);
    expect(calls.refresh).toBe(0);
  });

  test('a finished fetch wins over an older stored read of the same kind', async () => {
    const { c, fake } = fakeController();
    const fetchGate = deferred<{ count: number; truncated: boolean; list: VodList }>();
    const storedGate = deferred<VodCatalog | undefined>();
    fake.refresh = () => fetchGate.promise;
    fake.storedCatalog = () => storedGate.promise;
    const fetching = c.refresh('movie');
    const firstSlice = c.slice('movie', 'all', 'title', 0, 10);
    await new Promise((r) => setTimeout(r, 0));
    fetchGate.resolve({ count: 2, truncated: false, list: listOf('movie', 1, 2) });
    await fetching;
    storedGate.resolve(new VodCatalog('movie', listOf('movie', 1)));
    expect((await firstSlice).rows.map((t) => t.id)).toEqual(['s:movie1', 's:movie2']);
    const page = await c.slice('movie', 'all', 'title', 0, 10);
    expect(page.rows.map((t) => t.id)).toEqual(['s:movie1', 's:movie2']);
  });

  test('a fetch does not become resident while a load of the other kind is in flight', async () => {
    const { c, fake, calls } = fakeController();
    const fetchGate = deferred<{ count: number; truncated: boolean; list: VodList }>();
    const seriesGate = deferred<VodCatalog | undefined>();
    fake.refresh = () => fetchGate.promise;
    fake.storedCatalog = (_id: string, kind: VodKind) => { calls.stored.push(kind); return kind === 'series' ? seriesGate.promise : Promise.resolve(undefined); };
    const fetching = c.refresh('movie');
    const seriesHome = c.home('series');
    await new Promise((r) => setTimeout(r, 0));
    fetchGate.resolve({ count: 1, truncated: false, list: listOf('movie', 1) });
    await fetching;
    calls.stored.length = 0;
    await c.home('movie');
    expect(calls.stored).toContain('movie');
    seriesGate.resolve(undefined);
    await seriesHome;
  });
});

describe('VodController detail views and playable', () => {
  test('movie view: list fields, detail, more in category without itself; detail cached', async () => {
    const { c, vod } = await setup();
    await c.refresh('movie');
    const spy = vi.spyOn(vod, 'movieDetail');
    const id = (await c.slice('movie', '1', 'title', 0, 1)).rows[0]!.id;
    const view = (await c.movie(id))!;
    expect(view.tile.id).toBe(id);
    expect(view.detail?.plot).toMatch(/^Synthetic plot for /);
    expect(view.resumeMs).toBe(0);
    expect(view.tracks).toEqual({});
    expect(view.more.map((t) => t.id)).not.toContain(id);
    expect(view.more.length).toBe(5);
    await c.movie(id);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await c.movie('nope')).toBeUndefined();
  });

  test('a failed detail fetch: detail null, recorded, not cached', async () => {
    const { c, recorded } = await setup();
    await c.refresh('movie');
    const id = (await c.slice('movie', '1', 'title', 0, 1)).rows[0]!.id;
    failVod = true;
    expect((await c.movie(id))!.detail).toBeNull();
    expect(recorded).toContain('getMovie');
    failVod = false;
    expect((await c.movie(id))!.detail).not.toBeNull();
  });

  test('series view: seasons with episode state, primary is S1 E1 to start', async () => {
    const { c } = await setup();
    await c.refresh('series');
    const id = (await c.slice('series', 'all', 'title', 0, 1)).rows[0]!.id;
    const view = (await c.series(id))!;
    expect(view.seasons.length).toBeGreaterThan(0);
    expect(view.seasons[0]!.episodes[0]).toMatchObject({ season: 1, episode: 1, watched: false });
    expect(view.primary).toMatchObject({ season: 1, episode: 1, mode: 'start', resumeMs: 0 });
  });

  test('playable: movie URL, episode URL with series pointer and next', async () => {
    const { c } = await setup();
    await c.refresh('movie');
    const movieId = (await c.slice('movie', '1', 'title', 0, 1)).rows[0]!.id;
    const m = (await c.playable(movieId))!;
    expect(m).toMatchObject({ kind: 'movie', itemId: movieId, resumeMs: 0, tracks: {} });
    expect(m.url).toMatch(/\/movie\/test\/test\/\d+\.m3u8$/);

    await c.refresh('series');
    const showId = (await c.slice('series', 'all', 'title', 0, 1)).rows[0]!.id;
    const first = (await c.series(showId))!.seasons[0]!.episodes[0]!;
    const e = (await c.playable(first.id, showId))!;
    expect(e).toMatchObject({ kind: 'episode', itemId: first.id, series: { id: showId, season: 1, episode: 1 } });
    expect(e.url).toMatch(/\/series\/test\/test\/\d+\.m3u8$/);
    expect(e.episodeLabel).toMatch(/^S1 · E1 · /);
    expect(e.next?.label).toMatch(/^S1 · E2 · /);
    expect(e.series?.next).toMatchObject({ season: 1, episode: 2 });
    expect(await c.playable('nope', showId)).toBeUndefined();
  });
});
