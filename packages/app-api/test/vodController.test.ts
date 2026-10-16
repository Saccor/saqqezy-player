import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  SourceService, VodCatalog, VodService,
  type Episode, type FetchFn, type Season, type VodItem, type VodKind, type VodList, type VodUserRecord, type VodUserState,
} from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { startFakeXtream } from '@iptv/fake-xtream';
import {
  VOD_DETAIL_CACHE, VOD_HOME_ROWS_WITH_ITEMS, VOD_ROW_CONTINUE, VOD_ROW_FAVOURITES, VOD_ROW_RECENT, VodController,
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

async function setup(kind: 'xtream' | 'm3u' = 'xtream', now: () => number = () => NOW) {
  const deps = { storage, fetch: fetchFn, now };
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
    expect(recorded).toEqual(['getVodDetail']);
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
    expect(m).toMatchObject({ kind: 'movie', itemId: movieId, resumeMs: 0 });
    expect(m.tracks).toEqual({});
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

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const movieId = (n: number) => `s:movie${n}`;
const showId = (n: number) => `s:series${n}`;
const epId = (show: string, k: number) => `${show}:ep${k}`;
const seasonsOf = (show: string): Season[] => {
  const ep = (season: number, episode: number, k: number): Episode => ({ id: epId(show, k), season, episode, title: `Part ${k}`, runtimeMin: 30 });
  return [
    { number: 1, name: 'Season 1', episodes: [ep(1, 1, 1), ep(1, 2, 2)] },
    { number: 2, name: 'Season 2', episodes: [ep(2, 1, 3)] },
  ];
};
const userState = (over: Partial<VodUserState> = {}): VodUserState => ({ position: 0, duration: 0, watched: false, favourite: false, updatedAt: 0, ...over });

/** A controller over a deterministic fake VodService: `movies` movies and `shows` series, all in category 1. */
function detailFake(movies: number, shows = 0) {
  const users: VodUserRecord[] = [];
  const recorded: string[] = [];
  const catalogs = {
    movie: new VodCatalog('movie', listOf('movie', ...range(movies))),
    series: new VodCatalog('series', listOf('series', ...range(shows))),
  };
  const fake = {
    storedCatalog: vi.fn(async (_id: string, kind: VodKind): Promise<VodCatalog | undefined> => catalogs[kind]),
    needsRefresh: async (): Promise<boolean> => false,
    listUser: vi.fn(async () => users),
    movieDetail: vi.fn(async (_src: string, it: VodItem) => ({ plot: `Plot ${it.id}` })),
    seriesDetail: vi.fn(async (_src: string, it: VodItem) => ({ plot: `Plot ${it.id}`, seasons: seasonsOf(it.id) })),
    streamUrl: vi.fn(async (_src: string, it: { id: string }) => `https://media.invalid/${it.id}`),
  };
  const c = new VodController({
    vod: fake as unknown as VodService,
    emit: () => {},
    record: (where, err) => { recorded.push(where); return err instanceof Error ? err : new Error(String(err)); },
  });
  c.reset('src');
  return { c, fake, users, recorded };
}

describe('VodController detail cache', () => {
  test('keeps at most VOD_DETAIL_CACHE details: the oldest is refetched, the newest is not', async () => {
    const { c, fake } = detailFake(VOD_DETAIL_CACHE + 1);
    for (const n of range(VOD_DETAIL_CACHE + 1)) await c.movie(movieId(n));
    expect(fake.movieDetail).toHaveBeenCalledTimes(VOD_DETAIL_CACHE + 1);
    fake.movieDetail.mockClear();
    await c.movie(movieId(VOD_DETAIL_CACHE + 1));
    expect(fake.movieDetail).not.toHaveBeenCalled();
    await c.movie(movieId(1));
    expect(fake.movieDetail).toHaveBeenCalledTimes(1);
  });

  test('a cache hit refreshes recency: the touched movie survives, the next-oldest is evicted', async () => {
    const { c, fake } = detailFake(VOD_DETAIL_CACHE + 1);
    for (const n of range(VOD_DETAIL_CACHE)) await c.movie(movieId(n));
    await c.movie(movieId(1));
    await c.movie(movieId(VOD_DETAIL_CACHE + 1));
    fake.movieDetail.mockClear();
    await c.movie(movieId(1));
    expect(fake.movieDetail).not.toHaveBeenCalled();
    await c.movie(movieId(2));
    expect(fake.movieDetail).toHaveBeenCalledTimes(1);
  });

  test('reset clears the cache', async () => {
    const { c, fake } = detailFake(2);
    await c.movie(movieId(1));
    await c.movie(movieId(1));
    expect(fake.movieDetail).toHaveBeenCalledTimes(1);
    c.reset('src');
    await c.movie(movieId(1));
    expect(fake.movieDetail).toHaveBeenCalledTimes(2);
  });
});

describe('VodController concurrent detail requests', () => {
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  test('a hero view and a quick play of the same series share one detail fetch', async () => {
    const { c, fake } = detailFake(0, 2);
    const d = deferred<{ plot: string; seasons: Season[] }>();
    fake.seriesDetail.mockImplementationOnce(() => d.promise);
    const view = c.series(showId(1));
    const play = c.playable(epId(showId(1), 1), showId(1));
    await vi.waitFor(() => expect(fake.seriesDetail).toHaveBeenCalledTimes(1));
    d.resolve({ plot: 'Plot', seasons: seasonsOf(showId(1)) });
    expect((await view)?.seasons.length).toBe(2);
    expect((await play)?.kind).toBe('episode');
    expect(fake.seriesDetail).toHaveBeenCalledTimes(1);
  });

  test('a shared failed fetch is recorded once; the view gets null, the playable rejects; the next request fetches again', async () => {
    const { c, fake, recorded } = detailFake(0, 2);
    const d = deferred<{ plot: string; seasons: Season[] }>();
    fake.seriesDetail.mockImplementationOnce(() => d.promise);
    const view = c.series(showId(1));
    const play = c.playable(epId(showId(1), 1), showId(1));
    await vi.waitFor(() => expect(fake.seriesDetail).toHaveBeenCalledTimes(1));
    d.reject(new Error('detail failed'));
    expect((await view)?.detail).toBeNull();
    await expect(play).rejects.toThrow('detail failed');
    expect(recorded).toEqual(['getVodDetail']);
    expect((await c.series(showId(1)))?.detail).not.toBeNull();
    expect(fake.seriesDetail).toHaveBeenCalledTimes(2);
  });

  test('a source switch while a detail loads: the next request does not join the old fetch', async () => {
    const { c, fake } = detailFake(2);
    const d = deferred<{ plot: string }>();
    fake.movieDetail.mockImplementationOnce(() => d.promise);
    const old = c.movie(movieId(1));
    await vi.waitFor(() => expect(fake.movieDetail).toHaveBeenCalledTimes(1));
    c.reset('src');
    const fresh = await c.movie(movieId(1));
    expect(fake.movieDetail).toHaveBeenCalledTimes(2);
    expect(fresh?.detail?.plot).toBe(`Plot ${movieId(1)}`);
    d.resolve({ plot: 'stale' });
    expect(await old).toBeUndefined();
  });
});

describe('VodController detail failures', () => {
  test('a series whose detail fails: detail null, no seasons, no primary, recorded once, not cached', async () => {
    const { c, fake, recorded } = detailFake(0, 2);
    fake.seriesDetail.mockRejectedValueOnce(new Error('detail failed'));
    const view = (await c.series(showId(1)))!;
    expect(view.detail).toBeNull();
    expect(view.seasons).toEqual([]);
    expect(view.primary).toBeUndefined();
    expect(recorded).toEqual(['getVodDetail']);
    const again = (await c.series(showId(1)))!;
    expect(fake.seriesDetail).toHaveBeenCalledTimes(2);
    expect(again.detail).not.toBeNull();
    expect(again.seasons.length).toBe(2);
  });

  test('playable for an episode whose series detail fails: rejects, recorded, nothing cached', async () => {
    const { c, fake, recorded } = detailFake(0, 2);
    fake.seriesDetail.mockRejectedValueOnce(new Error('detail failed'));
    await expect(c.playable(epId(showId(1), 1), showId(1))).rejects.toThrow('detail failed');
    expect(recorded).toEqual(['getVodDetail']);
    expect((await c.playable(epId(showId(1), 1), showId(1)))?.kind).toBe('episode');
    expect(fake.seriesDetail).toHaveBeenCalledTimes(2);
  });
});

describe('VodController series primary', () => {
  const show = showId(1);
  const at = (k: number) => ({ season: k === 3 ? 2 : 1, episode: k === 3 ? 1 : k });
  const pointer = (k: number, next?: number) => ({
    id: show, ...at(k), ...(next === undefined ? {} : { next: { id: epId(show, next), ...at(next) } }),
  });

  test('an episode in progress: continue it at its position', async () => {
    const { c, users } = detailFake(0, 1);
    users.push({ itemId: epId(show, 2), state: userState({ position: 600_000, duration: 1_800_000, updatedAt: 5, series: pointer(2) }) });
    c.reset('src');
    expect((await c.series(show))!.primary).toEqual({ episodeId: epId(show, 2), season: 1, episode: 2, resumeMs: 600_000, mode: 'continue' });
  });

  test('the latest episode watched with a next pointer: continue with the next, from 0', async () => {
    const { c, users } = detailFake(0, 1);
    users.push({ itemId: epId(show, 2), state: userState({ watched: true, duration: 1_800_000, updatedAt: 5, series: pointer(2, 3) }) });
    c.reset('src');
    expect((await c.series(show))!.primary).toEqual({ episodeId: epId(show, 3), season: 2, episode: 1, resumeMs: 0, mode: 'continue' });
  });

  test('two episode records: the later updatedAt wins, whatever the order', async () => {
    const { c, users } = detailFake(0, 1);
    users.push({ itemId: epId(show, 2), state: userState({ position: 300_000, duration: 1_800_000, updatedAt: 9, series: pointer(2) }) });
    users.push({ itemId: epId(show, 1), state: userState({ position: 120_000, duration: 1_800_000, updatedAt: 1, series: pointer(1) }) });
    c.reset('src');
    expect((await c.series(show))!.primary).toMatchObject({ episodeId: epId(show, 2), resumeMs: 300_000, mode: 'continue' });
    users.reverse();
    c.reset('src');
    expect((await c.series(show))!.primary).toMatchObject({ episodeId: epId(show, 2), resumeMs: 300_000, mode: 'continue' });
  });
});

describe('VodController tracks', () => {
  test('a movie without stored tracks has none', async () => {
    const { c } = detailFake(1);
    expect((await c.movie(movieId(1)))!.tracks).toEqual({});
    expect((await c.playable(movieId(1)))!.tracks).toEqual({});
  });

  test('stored tracks and position come back on the view and on playable', async () => {
    const { c, users } = detailFake(1);
    users.push({ itemId: movieId(1), state: userState({ position: 600_000, duration: 3_600_000, audio: 'eng', subtitle: 'swe', updatedAt: 3 }) });
    c.reset('src');
    const p = (await c.playable(movieId(1)))!;
    expect(p.tracks).toEqual({ audio: 'eng', subtitle: 'swe' });
    expect(p.resumeMs).toBe(600_000);
    expect((await c.movie(movieId(1)))!.tracks).toEqual({ audio: 'eng', subtitle: 'swe' });
  });
});

describe('VodController detail views vs reset', () => {
  test('a reset while the catalogue loads: movie resolves undefined and fetches no detail', async () => {
    const { c, fake } = detailFake(2);
    const gate = deferred<VodCatalog | undefined>();
    fake.storedCatalog.mockImplementation(() => gate.promise);
    const view = c.movie(movieId(1));
    await new Promise((r) => setTimeout(r, 0));
    c.reset(undefined);
    gate.resolve(new VodCatalog('movie', listOf('movie', 1, 2)));
    expect(await view).toBeUndefined();
    expect(fake.movieDetail).not.toHaveBeenCalled();
  });
});

describe('VodController user state', () => {
  test('progress and favourites show in home rows, rail counts and tiles', async () => {
    const { c } = await setup();
    await c.refresh('movie');
    const [a, b] = (await c.slice('movie', '1', 'title', 0, 2)).rows;
    await c.saveProgress(a!.id, 10 * 60_000, 60 * 60_000);
    await c.setFavourite(b!.id, true);
    const home = await c.home('movie');
    expect(home.rows.slice(0, 2).map((r) => [r.id, r.total])).toEqual([[VOD_ROW_CONTINUE, 1], [VOD_ROW_FAVOURITES, 1]]);
    // Seven rows: only the first VOD_HOME_ROWS_WITH_ITEMS carry items.
    expect(home.rows).toHaveLength(7);
    home.rows.forEach((r, i) => expect(r.items.length > 0).toBe(i < VOD_HOME_ROWS_WITH_ITEMS));
    expect(home.rows[6]).toMatchObject({ id: '4', total: 6, items: [] });
    expect(home.rows[0]!.items[0]!.progress).toBeCloseTo(1 / 6, 3);
    expect(home.rows[1]!.items[0]).toMatchObject({ id: b!.id, favourite: true });
    const cats = await c.categories('movie');
    expect(cats.slice(0, 2).map((x) => x.count)).toEqual([1, 1]);
    await c.clearProgress(a!.id);
    expect((await c.home('movie')).rows[0]!.id).toBe(VOD_ROW_FAVOURITES);
  });

  test('watching an episode to the end puts the series in Continue watching with the next episode', async () => {
    const { c } = await setup();
    await c.refresh('series');
    const showId = (await c.slice('series', 'all', 'title', 0, 1)).rows[0]!.id;
    const first = (await c.series(showId))!.seasons[0]!.episodes[0]!;
    const p = (await c.playable(first.id, showId))!;
    await c.saveProgress(first.id, 0.95 * 2_700_000, 2_700_000, p.series);
    const home = await c.home('series');
    expect(home.rows[0]).toMatchObject({ id: VOD_ROW_CONTINUE, total: 1 });
    expect(home.rows[0]!.items[0]).toMatchObject({ id: showId, badge: 'S1 · E2' });
    const view = (await c.series(showId))!;
    expect(view.seasons[0]!.episodes[0]!.watched).toBe(true);
    expect(view.primary).toMatchObject({ season: 1, episode: 2, mode: 'continue' });
  });

  test('marking an episode watched with its pointer counts for Continue watching', async () => {
    const { c } = await setup();
    await c.refresh('series');
    const showId = (await c.slice('series', 'all', 'title', 0, 1)).rows[0]!.id;
    const first = (await c.series(showId))!.seasons[0]!.episodes[0]!;
    const p = (await c.playable(first.id, showId))!;
    await c.setWatched(first.id, true, p.series);
    expect((await c.home('series')).rows[0]!.items[0]!.badge).toBe('S1 · E2');
  });

  /** Synthetic Series 03 (third by title) has six episodes per season; a ticking clock orders the records. */
  async function sixEpisodeShow() {
    let t = NOW;
    const { c } = await setup('xtream', () => ++t);
    await c.refresh('series');
    const showId = (await c.slice('series', 'all', 'title', 2, 1)).rows[0]!.id;
    const eps = (await c.series(showId))!.seasons[0]!.episodes;
    expect(eps.length).toBeGreaterThanOrEqual(6);
    const bare = (k: number) => ({ id: showId, season: 1, episode: eps[k]!.episode });
    return { c, showId, eps, bare };
  }

  test('marking a later episode watched from its menu (pointer without next) moves Continue to the one after it', async () => {
    const { c, showId, eps, bare } = await sixEpisodeShow();
    const p4 = (await c.playable(eps[3]!.id, showId))!;
    await c.saveProgress(eps[3]!.id, 5 * 60_000, 45 * 60_000, p4.series);
    expect((await c.home('series')).rows[0]!.items[0]!.badge).toBe('S1 · E4');
    await c.setWatched(eps[4]!.id, true, bare(4));
    expect((await c.home('series')).rows[0]!.items[0]).toMatchObject({ id: showId, badge: 'S1 · E6' });
    expect((await c.series(showId))!.primary).toMatchObject({ episodeId: eps[5]!.id, season: 1, episode: 6, mode: 'continue' });
  });

  test('marking an earlier episode watched keeps Continue where it is', async () => {
    const { c, showId, eps, bare } = await sixEpisodeShow();
    const p4 = (await c.playable(eps[3]!.id, showId))!;
    await c.saveProgress(eps[3]!.id, 5 * 60_000, 45 * 60_000, p4.series);
    await c.setWatched(eps[1]!.id, true, bare(1));
    expect((await c.home('series')).rows[0]!.items[0]).toMatchObject({ id: showId, badge: 'S1 · E4' });
    expect((await c.series(showId))!.primary).toMatchObject({ episodeId: eps[3]!.id, resumeMs: 5 * 60_000, mode: 'continue' });
    expect((await c.series(showId))!.seasons[0]!.episodes[1]!.watched).toBe(true);
    // At or after the Continue point still moves it on.
    await c.setWatched(eps[4]!.id, true, bare(4));
    expect((await c.home('series')).rows[0]!.items[0]).toMatchObject({ id: showId, badge: 'S1 · E6' });
  });

  test('marking an earlier episode watched after the finale keeps the series out of Continue watching', async () => {
    const { c, showId, eps, bare } = await sixEpisodeShow();
    expect(eps).toHaveLength(6);
    await c.setWatched(eps[5]!.id, true, bare(5));
    expect((await c.home('series')).rows[0]?.id).not.toBe(VOD_ROW_CONTINUE);
    await c.setWatched(eps[1]!.id, true, bare(1));
    expect((await c.home('series')).rows[0]?.id).not.toBe(VOD_ROW_CONTINUE);
    expect((await c.series(showId))!.seasons[0]!.episodes[1]!.watched).toBe(true);
  });

  test('marking an earlier episode watched after "Remove from Continue watching" keeps it removed', async () => {
    const { c, showId, eps, bare } = await sixEpisodeShow();
    await c.setWatched(eps[3]!.id, true, bare(3));
    expect((await c.home('series')).rows[0]!.items[0]).toMatchObject({ id: showId, badge: 'S1 · E5' });
    await c.clearSeriesContinue(showId);
    expect((await c.home('series')).rows[0]?.id).not.toBe(VOD_ROW_CONTINUE);
    await c.setWatched(eps[1]!.id, true, bare(1));
    expect((await c.home('series')).rows[0]?.id).not.toBe(VOD_ROW_CONTINUE);
    // A later one still counts: Continue moves on from it.
    await c.setWatched(eps[4]!.id, true, bare(4));
    expect((await c.home('series')).rows[0]!.items[0]).toMatchObject({ id: showId, badge: 'S1 · E6' });
  });

  test('marking the Continue episode itself watched moves Continue to the next one', async () => {
    const { c, showId, eps, bare } = await sixEpisodeShow();
    const p4 = (await c.playable(eps[3]!.id, showId))!;
    await c.saveProgress(eps[3]!.id, 5 * 60_000, 45 * 60_000, p4.series);
    await c.setWatched(eps[3]!.id, true, bare(3));
    expect((await c.home('series')).rows[0]!.items[0]).toMatchObject({ id: showId, badge: 'S1 · E5' });
  });

  test('marking an episode unwatched leaves the series Continue state alone', async () => {
    const { c, showId, eps, bare } = await sixEpisodeShow();
    await c.setWatched(eps[1]!.id, true, bare(1));
    const p4 = (await c.playable(eps[3]!.id, showId))!;
    await c.saveProgress(eps[3]!.id, 5 * 60_000, 45 * 60_000, p4.series);
    await c.setWatched(eps[1]!.id, false, bare(1));
    expect((await c.home('series')).rows[0]!.items[0]).toMatchObject({ id: showId, badge: 'S1 · E4' });
    expect((await c.series(showId))!.primary).toMatchObject({ episodeId: eps[3]!.id, resumeMs: 5 * 60_000, mode: 'continue' });
  });

  test('tracks are remembered per title', async () => {
    const { c } = await setup();
    await c.refresh('movie');
    const id = (await c.slice('movie', '1', 'title', 0, 1)).rows[0]!.id;
    await c.setTracks(id, { audio: 'eng', subtitle: 'swe' });
    expect((await c.movie(id))!.tracks).toEqual({ audio: 'eng', subtitle: 'swe' });
    expect((await c.playable(id))!.tracks).toEqual({ audio: 'eng', subtitle: 'swe' });
  });

  test('writes without an active source are ignored', async () => {
    const { c, vod } = await setup();
    const spy = vi.spyOn(vod, 'saveProgress');
    c.reset(undefined);
    await expect(c.saveProgress('x', 1, 2)).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  test('every write is forwarded to the service for the active source with its arguments', async () => {
    const { c, fake } = writeFake();
    const pointer = { id: 'show', season: 1, episode: 2 };
    await c.saveProgress('m', 5, 10, pointer);
    await c.setFavourite('m', true);
    await c.setWatched('m', true, pointer);
    await c.clearProgress('m');
    await c.setTracks('m', { audio: 'eng' });
    expect(fake.saveProgress).toHaveBeenCalledWith('src', 'm', 5, 10, pointer);
    expect(fake.setFavourite).toHaveBeenCalledWith('src', 'm', true);
    expect(fake.setWatched).toHaveBeenCalledWith('src', 'm', true, pointer);
    expect(fake.clearProgress).toHaveBeenCalledWith('src', 'm');
    expect(fake.setTracks).toHaveBeenCalledWith('src', 'm', { audio: 'eng' });
  });

  test('a write that finishes after a source change does not touch state of the next source', async () => {
    const { c, fake } = writeFake();
    const gate = deferred<VodUserState>();
    fake.setFavourite.mockImplementationOnce(() => gate.promise);
    const write = c.setFavourite('s:movie2', true);
    await new Promise((r) => setTimeout(r, 0));
    c.reset('src2');
    gate.resolve(userState({ favourite: true, updatedAt: 9 }));
    await write;
    expect((await c.slice('movie', VOD_ROW_FAVOURITES, 'title', 0, 5)).total).toBe(0);
  });

  test('a write that finishes after an invalidate of the same source still lands in the user map', async () => {
    const { c, fake } = writeFake();
    const gate = deferred<VodUserState>();
    fake.setFavourite.mockImplementationOnce(() => gate.promise);
    const write = c.setFavourite('s:movie2', true);
    await new Promise((r) => setTimeout(r, 0));
    c.invalidate('src');
    gate.resolve(userState({ favourite: true, updatedAt: 9 }));
    await write;
    const slice = await c.slice('movie', VOD_ROW_FAVOURITES, 'title', 0, 5);
    expect(slice.total).toBe(1);
    expect(slice.rows[0]).toMatchObject({ id: 's:movie2', favourite: true });
  });

  test('a write the service reports as nothing leaves the in-memory state alone', async () => {
    const { c, fake } = writeFake();
    await c.setFavourite('s:movie1', true);
    fake.setFavourite.mockResolvedValueOnce(undefined as unknown as VodUserState);
    await c.setFavourite('s:movie1', false);
    expect((await c.slice('movie', VOD_ROW_FAVOURITES, 'title', 0, 5)).total).toBe(1);
  });
});

/** detailFake plus writes that keep their own records, like the real service. */
function writeFake() {
  const base = detailFake(2);
  const store = new Map<string, VodUserState>();
  const put = (id: string, next: VodUserState) => { store.set(id, next); return Promise.resolve(next); };
  const fake = Object.assign(base.fake, {
    saveProgress: vi.fn(async (_s: string, id: string, position: number, duration: number) => put(id, userState({ position, duration, updatedAt: 1 }))),
    setFavourite: vi.fn(async (_s: string, id: string, on: boolean) => put(id, userState({ favourite: on, updatedAt: 1 }))),
    setWatched: vi.fn(async (_s: string, id: string, on: boolean) => put(id, userState({ watched: on, updatedAt: 1 }))),
    clearProgress: vi.fn(async (_s: string, id: string) => put(id, userState({ updatedAt: 1 }))),
    setTracks: vi.fn(async (_s: string, id: string) => put(id, userState({ updatedAt: 1 }))),
  });
  return { c: base.c, fake, users: base.users };
}

describe('VodController episode playables and series continue', () => {
  const show = showId(1);
  const at = (k: number) => ({ season: k === 3 ? 2 : 1, episode: k === 3 ? 1 : k });
  const pointer = (k: number, next?: number) => ({
    id: show, ...at(k), ...(next === undefined ? {} : { next: { id: epId(show, next), ...at(next) } }),
  });
  const seriesFake = () => {
    const base = detailFake(0, 1);
    const fake = Object.assign(base.fake, {
      clearProgress: vi.fn(async (_s: string, id: string) => {
        const rec = base.users.find((r) => r.itemId === id)!;
        const { next: _n, ...rest } = rec.state.series!;
        rec.state = { ...rec.state, position: 0, series: rest };
        return rec.state;
      }),
    });
    return { ...base, fake };
  };

  test('playable: prev is the previous episode, absent for the first', async () => {
    const { c } = detailFake(0, 1);
    expect((await c.playable(epId(show, 1), show))!.prev).toBeUndefined();
    expect((await c.playable(epId(show, 2), show))!.prev).toEqual({ id: epId(show, 1), label: 'S1 · E1 · Part 1' });
    expect((await c.playable(epId(show, 3), show))!.prev).toEqual({ id: epId(show, 2), label: 'S1 · E2 · Part 2' });
  });

  test('playable: episode tracks come from the series record, else the episode record', async () => {
    const { c, users } = detailFake(0, 1);
    users.push({ itemId: show, state: userState({ audio: 'eng', subtitle: 'swe' }) });
    c.reset('src');
    expect((await c.playable(epId(show, 2), show))!.tracks).toEqual({ audio: 'eng', subtitle: 'swe' });
    users.length = 0;
    users.push({ itemId: epId(show, 2), state: userState({ audio: 'fra' }) });
    c.reset('src');
    expect((await c.playable(epId(show, 2), show))!.tracks).toEqual({ audio: 'fra' });
  });

  test('clearSeriesContinue: an episode in progress leaves Continue watching', async () => {
    const { c, users } = seriesFake();
    users.push({ itemId: epId(show, 1), state: userState({ position: 120_000, duration: 1_800_000, updatedAt: 1, series: pointer(1) }) });
    users.push({ itemId: epId(show, 2), state: userState({ position: 600_000, duration: 1_800_000, updatedAt: 5, series: pointer(2) }) });
    c.reset('src');
    expect((await c.home('series')).rows[0]).toMatchObject({ id: VOD_ROW_CONTINUE, total: 1 });
    await c.clearSeriesContinue(show);
    expect((await c.home('series')).rows.map((r) => r.id)).not.toContain(VOD_ROW_CONTINUE);
  });

  test('clearSeriesContinue: a watched episode with a next pointer leaves Continue watching and stays watched', async () => {
    const { c, users, fake } = seriesFake();
    users.push({ itemId: epId(show, 2), state: userState({ watched: true, duration: 1_800_000, updatedAt: 5, series: pointer(2, 3) }) });
    c.reset('src');
    expect((await c.home('series')).rows[0]).toMatchObject({ id: VOD_ROW_CONTINUE, total: 1 });
    await c.clearSeriesContinue(show);
    expect(fake.clearProgress).toHaveBeenCalledWith('src', epId(show, 2));
    expect((await c.home('series')).rows.map((r) => r.id)).not.toContain(VOD_ROW_CONTINUE);
    expect((await c.series(show))!.seasons[0]!.episodes[1]!.watched).toBe(true);
  });

  test('playable: tracks fall back all-or-nothing, never merged with the episode record', async () => {
    const { c, users } = detailFake(0, 1);
    users.push({ itemId: show, state: userState({ audio: 'eng' }) });
    users.push({ itemId: epId(show, 2), state: userState({ subtitle: 'swe' }) });
    c.reset('src');
    expect((await c.playable(epId(show, 2), show))!.tracks).toEqual({ audio: 'eng' });
  });

  test('clearSeriesContinue: a source switch while the user map loads writes nothing', async () => {
    const { c, fake, users } = seriesFake();
    users.push({ itemId: epId(show, 2), state: userState({ position: 600_000, duration: 1_800_000, updatedAt: 5, series: pointer(2) }) });
    const gate = deferred<VodUserRecord[]>();
    fake.listUser.mockImplementationOnce(() => gate.promise);
    c.reset('src');
    const p = c.clearSeriesContinue(show);
    await new Promise((r) => setTimeout(r, 0));
    c.reset('src2');
    gate.resolve(users);
    await p;
    expect(fake.clearProgress).not.toHaveBeenCalled();
  });

  test('clearSeriesContinue: no record is a no-op', async () => {
    const { c, fake } = seriesFake();
    await expect(c.clearSeriesContinue(show)).resolves.toBeUndefined();
    expect(fake.clearProgress).not.toHaveBeenCalled();
  });
});

describe('VodController invalidate', () => {
  test('drops the resident catalogue and details, keeps the user map, aborts jobs', async () => {
    const { c, fake, users } = detailFake(2);
    users.push({ itemId: movieId(1), state: userState({ favourite: true, updatedAt: 1 }) });
    await c.home('movie');
    await c.movie(movieId(1));
    expect(fake.storedCatalog).toHaveBeenCalledTimes(1);
    expect(fake.listUser).toHaveBeenCalledTimes(1);
    expect(fake.movieDetail).toHaveBeenCalledTimes(1);
    c.invalidate('src');
    await c.movie(movieId(1));
    expect(fake.storedCatalog).toHaveBeenCalledTimes(2);
    expect(fake.movieDetail).toHaveBeenCalledTimes(2);
    expect(fake.listUser).toHaveBeenCalledTimes(1);
    expect((await c.slice('movie', VOD_ROW_FAVOURITES, 'title', 0, 5)).total).toBe(1);
  });

  test('residentKind names the resident catalogue, if any', async () => {
    const { c } = detailFake(2);
    expect(c.residentKind()).toBeUndefined();
    await c.home('movie');
    expect(c.residentKind()).toBe('movie');
    c.invalidate('src');
    expect(c.residentKind()).toBeUndefined();
  });

  test('another source id changes nothing', async () => {
    const { c, fake } = detailFake(2);
    await c.home('movie');
    c.invalidate('other');
    await c.home('movie');
    expect(fake.storedCatalog).toHaveBeenCalledTimes(1);
  });
});

describe('VodController user map load', () => {
  test('a write that joins a slow first load is not lost when the load finishes', async () => {
    const { c, fake } = writeFake();
    const first = deferred<VodUserRecord[]>();
    fake.listUser.mockImplementationOnce(() => first.promise);
    const home = c.home('movie');
    await new Promise((r) => setTimeout(r, 0));
    const write = c.setFavourite(movieId(1), true);
    await new Promise((r) => setTimeout(r, 0));
    first.resolve([]);
    await Promise.all([home, write]);
    expect(fake.listUser).toHaveBeenCalledTimes(1);
    const again = await c.home('movie');
    expect(again.rows[0]!.id).toBe(VOD_ROW_FAVOURITES);
    expect(again.rows[0]!.items[0]).toMatchObject({ id: movieId(1), favourite: true });
  });

  test('reset drops an in-flight load: the next source loads its own', async () => {
    const { c, fake } = writeFake();
    const first = deferred<VodUserRecord[]>();
    fake.listUser.mockImplementationOnce(() => first.promise);
    const home = c.home('movie');
    await new Promise((r) => setTimeout(r, 0));
    c.reset('src2');
    first.resolve([{ itemId: movieId(1), state: userState({ favourite: true, updatedAt: 1 }) }]);
    await home;
    expect((await c.slice('movie', VOD_ROW_FAVOURITES, 'title', 0, 5)).total).toBe(0);
    expect(fake.listUser).toHaveBeenCalledTimes(2);
  });
});

describe('VodController playable vs reset', () => {
  test('a reset while the movie stream URL resolves: undefined', async () => {
    const { c, fake } = detailFake(1);
    const gate = deferred<string>();
    fake.streamUrl.mockImplementationOnce(() => gate.promise);
    const p = c.playable(movieId(1));
    await new Promise((r) => setTimeout(r, 0));
    c.reset('src2');
    gate.resolve('https://media.invalid/x');
    expect(await p).toBeUndefined();
  });

  test('a reset while an episode stream URL resolves: undefined', async () => {
    const { c, fake } = detailFake(0, 1);
    const gate = deferred<string>();
    fake.streamUrl.mockImplementationOnce(() => gate.promise);
    const p = c.playable(epId(showId(1), 1), showId(1));
    await new Promise((r) => setTimeout(r, 0));
    c.reset('src2');
    gate.resolve('https://media.invalid/x');
    expect(await p).toBeUndefined();
  });
});

describe('VodController stale refresh failure', () => {
  test('a stored catalogue whose background refresh fails stays ready, one failure event, no retry', async () => {
    const { c, fake, calls, events } = fakeController();
    fake.storedCatalog = async () => new VodCatalog('movie', listOf('movie', 1, 2));
    fake.needsRefresh = async () => true;
    fake.refresh = async () => { calls.refresh++; throw new Error('fetch failed'); };
    const first = await c.home('movie');
    expect(first.status).toBe('ready');
    expect(first.rows.length).toBeGreaterThan(0);
    await c.idle();
    expect(events.map((e) => e.type)).toEqual(['vodLoading', 'vodRefreshFailed']);
    const second = await c.home('movie');
    expect(second.status).toBe('ready');
    await c.idle();
    expect(calls.refresh).toBe(1);
    expect(events).toHaveLength(2);
  });
});

describe('VodController search', () => {
  const titled = (kind: VodKind, n: number, title: string, extra: Partial<VodItem> = {}): VodItem => ({ id: `${kind}:${n}`, kind, title, categoryId: '1', ...extra });
  const stored = (kind: VodKind, items: VodItem[]): VodList => ({ items, categories: [{ id: '1', kind, name: 'Cat', count: items.length }] });

  async function seeded() {
    const s = await setup();
    await storage.replaceVod(s.sourceId, 'movie', stored('movie', [
      titled('movie', 1, 'Harbour Lights', { year: 2004, poster: 'http://img.example.test/p/1.jpg' }),
      titled('movie', 2, 'The Lighthouse Keeper'),
      titled('movie', 3, 'Night Shift'),
    ]));
    await storage.replaceVod(s.sourceId, 'series', stored('series', [titled('series', 1, 'Lighthouse Stories', { year: 2019 })]));
    return s;
  }

  test('the first search builds both indexes from storage in the background: pending, then searchReady, then hits', async () => {
    const { c, events, sourceId } = await seeded();
    expect(await c.search('light', 20)).toEqual({ movies: [], series: [], pending: true });
    await c.idle();
    expect(events).toEqual([{ type: 'searchReady', sourceId }]);
    const r = await c.search('light', 20);
    expect(r.pending).toBe(false);
    // Ranked by match position: "the lighthouse…" (4) before "harbour lights" (8).
    expect(r.movies.map((t) => t.title)).toEqual(['The Lighthouse Keeper', 'Harbour Lights']);
    // Text-only rows: no poster in search tiles.
    expect(r.movies[1]).toEqual({ id: 'movie:1', kind: 'movie', title: 'Harbour Lights', categoryId: '1', year: 2004, watched: false, favourite: false });
    expect(r.series).toEqual([{ id: 'series:1', kind: 'series', title: 'Lighthouse Stories', categoryId: '1', year: 2019, watched: false, favourite: false }]);
  });

  test('never fetches and never changes which catalogue is resident', async () => {
    const { c, vod, events } = await seeded();
    const refresh = vi.spyOn(vod, 'refresh');
    await c.search('light', 20);
    await c.idle();
    expect(refresh).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['searchReady']);
    expect(c.residentKind()).toBeUndefined();
  });

  test('a resident kind is indexed from memory; only the other kind is read from storage', async () => {
    const { c, vod } = await seeded();
    await c.preload('movie');
    const spy = vi.spyOn(vod, 'storedCatalog');
    await c.search('light', 20);
    await c.idle();
    expect(spy.mock.calls.map((a) => a[1])).toEqual(['series']);
    expect((await c.search('light', 20)).movies).toHaveLength(2);
    expect(c.residentKind()).toBe('movie');
  });

  test('indexes are built once; tiles carry the user state', async () => {
    const { c, vod } = await seeded();
    await c.search('light', 20);
    await c.idle();
    const spy = vi.spyOn(vod, 'storedCatalog');
    await c.setFavourite('movie:2', true);
    await c.saveProgress('movie:1', 600_000, 6_000_000);
    const r = await c.search('LIGHT', 20);
    expect(spy).not.toHaveBeenCalled();
    expect(r.movies[0]).toMatchObject({ id: 'movie:2', favourite: true });
    expect(r.movies[1]).toMatchObject({ id: 'movie:1', progress: 0.1, favourite: false });
  });

  test('ranking as the catalogue search, at most `cap` per kind', async () => {
    const { c, sourceId } = await setup();
    await storage.replaceVod(sourceId, 'movie', stored('movie', Array.from({ length: 30 }, (_, i) => titled('movie', i, `Film ${String(29 - i).padStart(2, '0')}`))));
    await c.search('film', 20);
    await c.idle();
    const r = await c.search('film', 20);
    expect(r.movies.map((t) => t.title)).toEqual(Array.from({ length: 20 }, (_, i) => `Film ${String(i).padStart(2, '0')}`));
    expect(r.series).toEqual([]);
  });

  test('an empty query or no source: nothing, and nothing is built', async () => {
    const { c, vod, events } = await seeded();
    const spy = vi.spyOn(vod, 'storedCatalog');
    expect(await c.search('  ', 20)).toEqual({ movies: [], series: [], pending: false });
    await c.idle();
    expect(spy).not.toHaveBeenCalled();
    c.reset(undefined);
    expect(await c.search('light', 20)).toEqual({ movies: [], series: [], pending: false });
    expect(events).toEqual([]);
  });

  test('nothing stored: no hits and not pending once built (no fetch is started)', async () => {
    const { c, events } = await setup();
    expect((await c.search('light', 20)).pending).toBe(true);
    await c.idle();
    expect(await c.search('light', 20)).toEqual({ movies: [], series: [], pending: false });
    expect(events.map((e) => e.type)).toEqual(['searchReady']);
  });

  test('invalidate drops the indexes: the next search rebuilds from the new stored lists', async () => {
    const { c, sourceId } = await seeded();
    await c.search('light', 20);
    await c.idle();
    await storage.replaceVod(sourceId, 'movie', stored('movie', [titled('movie', 9, 'Lighter Days')]));
    c.invalidate(sourceId);
    expect((await c.search('light', 20)).pending).toBe(true);
    await c.idle();
    expect((await c.search('light', 20)).movies.map((t) => t.title)).toEqual(['Lighter Days']);
  });

  test('a refresh of one kind drops that index only; it is rebuilt from the fresh catalogue', async () => {
    const { c, vod } = await seeded();
    await c.search('synthetic', 20);
    await c.idle();
    await c.refresh('movie');
    const spy = vi.spyOn(vod, 'storedCatalog');
    const r1 = await c.search('synthetic', 20);
    expect(r1.pending).toBe(true);
    await c.idle();
    // Rebuilt from the resident fresh list (no storage read); the series index was kept.
    expect(spy).not.toHaveBeenCalled();
    const r2 = await c.search('synthetic film', 20);
    expect(r2.movies).toHaveLength(20);
    expect(r2.movies[0]!.title).toMatch(/^Synthetic Film /);
  });

  test('a dropped index is announced to an open Search (searchReady), so it re-runs and rebuilds', async () => {
    const { c, events, sourceId } = await seeded();
    c.invalidate(sourceId);
    expect(events).toEqual([]);
    await c.search('light', 20);
    await c.idle();
    events.length = 0;
    c.invalidate(sourceId);
    expect(events).toEqual([{ type: 'searchReady', sourceId }]);
    await c.search('light', 20);
    await c.idle();
    events.length = 0;
    await c.refresh('series');
    expect(events.map((e) => e.type)).toEqual(['vodLoading', 'vodRefreshed', 'searchReady']);
    // An invalidate while a build is in flight still tells Search (that build will never answer).
    events.length = 0;
    c.invalidate(sourceId);
    void c.search('light', 20);
    c.invalidate(sourceId);
    expect(events).toEqual([{ type: 'searchReady', sourceId }, { type: 'searchReady', sourceId }]);
  });

  test('a source switch while an index builds: the old build is dropped, no event for it', async () => {
    const { c, vod, events, sourceId } = await seeded();
    const gate = deferred<VodCatalog | undefined>();
    const real = vod.storedCatalog.bind(vod);
    vi.spyOn(vod, 'storedCatalog').mockImplementationOnce(() => gate.promise);
    await c.search('light', 20);
    c.reset(sourceId);
    gate.resolve(await real(sourceId, 'movie'));
    await c.idle();
    expect(events).toEqual([]);
    expect((await c.search('light', 20)).pending).toBe(true);
  });

  test('a failed storage read is recorded once; that kind has no hits until the next invalidate', async () => {
    const { c, vod, recorded } = await seeded();
    vi.spyOn(vod, 'storedCatalog').mockRejectedValueOnce(new Error('read failed'));
    await c.search('light', 20);
    await c.idle();
    const r = await c.search('light', 20);
    expect(recorded).toEqual(['searchVod']);
    expect(r).toMatchObject({ movies: [], pending: false });
    expect(r.series).toHaveLength(1);
  });
});
