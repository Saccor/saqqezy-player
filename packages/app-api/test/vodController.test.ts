import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { SourceService, VodService, type FetchFn } from '@iptv/core';
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
    await new Promise((r) => setTimeout(r, 50));
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
