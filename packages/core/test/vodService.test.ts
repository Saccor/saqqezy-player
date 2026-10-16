import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryStorage } from '../../storage/src/memoryStorage.ts';
import { VodService } from '../src/service/vodService.ts';
import { VodFetchCancelled } from '../src/vod/fetchXtream.ts';
import { SourceNetworkError, SourceRefusedError } from '../src/errors.ts';
import { RefusalGuard } from '../src/net/refusalGuard.ts';
import type { FetchFn, SourceConfig } from '../src/types.ts';

const NOW = Date.UTC(2026, 9, 15, 12, 0);
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const xs: SourceConfig = { kind: 'xtream', id: 'x', name: 'X', server: 'example.test', username: 'u', password: 'p' };
const ms: SourceConfig = { kind: 'm3u', id: 'm', name: 'M', playlistUrl: 'http://example.test/p.m3u' };

let storage: MemoryStorage;
let svc: VodService;
let now = NOW;
let calls: string[];
/** When set, the get_vod_streams answer waits for it. */
let hold: Promise<void> | undefined;
let api: Record<string, (q: URLSearchParams) => unknown>;

const fetchFn: FetchFn = async (url) => {
  const u = new URL(url);
  const action = u.searchParams.get('action') ?? 'auth';
  calls.push(action + (u.searchParams.get('category_id') ? `:${u.searchParams.get('category_id')}` : ''));
  if (hold && action === 'get_vod_streams') await hold;
  const h = api[action];
  if (!h) throw new TypeError(`no route ${action}`);
  return json(h(u.searchParams));
};

beforeEach(async () => {
  storage = new MemoryStorage();
  await storage.putSource(xs);
  await storage.putSource(ms);
  now = NOW;
  calls = [];
  hold = undefined;
  api = {
    get_vod_categories: () => [{ category_id: '1', category_name: 'Drama' }, { category_id: '2', category_name: 'Comedy' }],
    get_vod_streams: (q) => [{ stream_id: Number(q.get('category_id')) * 10, name: `Synthetic Film ${q.get('category_id')}`, category_id: q.get('category_id'), container_extension: 'mkv' }],
    get_series_categories: () => [],
    get_series: () => [{ series_id: 5, name: 'Synthetic Series 01' }],
    get_vod_info: () => ({ info: { plot: 'A synthetic plot.' } }),
    get_series_info: () => ({ episodes: { '1': [{ id: 501, episode_num: 1, title: 'Pilot', container_extension: 'mp4' }] } }),
  };
  svc = new VodService({ storage, fetch: fetchFn, now: () => now });
});

describe('VodService catalogues', () => {
  test('refresh fetches per category, stores, stamps; loadCatalog reads it', async () => {
    expect(await svc.needsRefresh('x', 'movie')).toBe(true);
    expect(await svc.refresh('x', 'movie')).toMatchObject({ count: 2, truncated: false });
    expect(calls).toEqual(['get_vod_categories', 'get_vod_streams:1', 'get_vod_streams:2']);
    expect(await svc.fetchedAt('x', 'movie')).toBe(NOW);
    expect(await svc.needsRefresh('x', 'movie')).toBe(false);
    now = NOW + 13 * 3600_000;
    expect(await svc.needsRefresh('x', 'movie')).toBe(true);
    const cat = await svc.loadCatalog('x', 'movie');
    expect(cat.size).toBe(2);
    expect(cat.categories().map((c) => c.name)).toEqual(['Drama', 'Comedy']);
  });

  test('with the refusal guard, a cooling source is not asked for its catalogue', async () => {
    const guard = new RefusalGuard({ storage, now: () => now });
    const guarded = new VodService({ storage, fetch: fetchFn, now: () => now, guard });
    await guard.report('x', 'refused');
    await expect(guarded.refresh('x', 'movie')).rejects.toBeInstanceOf(SourceRefusedError);
    expect(calls).toEqual([]);
  });

  test('with the guard, an unreachable source is not asked either, and the error says why', async () => {
    const guard = new RefusalGuard({ storage, now: () => now });
    const guarded = new VodService({ storage, fetch: fetchFn, now: () => now, guard });
    for (let i = 0; i < 3; i++) await guard.report('x', 'failed');
    await expect(guarded.refresh('x', 'movie')).rejects.toMatchObject({
      name: 'SourceRefused', reason: 'unreachable', message: "Your source isn't answering. The app is waiting so it doesn't flood it.",
    });
    expect(calls).toEqual([]);
  });

  test('autoRefreshHours 0 means never stale once fetched', async () => {
    await storage.setMeta('settings', { autoRefreshHours: 0 });
    await svc.refresh('x', 'movie');
    now = NOW + 1000 * 3600_000;
    expect(await svc.needsRefresh('x', 'movie')).toBe(false);
  });

  test('M3U sources never need a VOD refresh; refresh reports the stored count', async () => {
    await storage.replaceVod('m', 'movie', { items: [{ id: 'm:v1', kind: 'movie', title: 'A', categoryId: 'g:G', url: 'http://example.test/movie/u/p/1.mp4' }], categories: [] });
    expect(await svc.needsRefresh('m', 'movie')).toBe(false);
    expect(await svc.refresh('m', 'movie')).toMatchObject({ count: 1, truncated: false });
    expect(calls).toEqual([]);
  });

  test('an empty catalogue loads for a source with nothing stored', async () => {
    expect((await svc.loadCatalog('x', 'series')).size).toBe(0);
  });

  test('cancel stores nothing', async () => {
    const ac = new AbortController();
    api.get_vod_streams = (q) => {
      ac.abort();
      return [{ stream_id: 1, name: 'A', category_id: q.get('category_id') }];
    };
    await expect(svc.refresh('x', 'movie', { signal: ac.signal })).rejects.toBeInstanceOf(VodFetchCancelled);
    expect(await storage.getVod('x', 'movie')).toBeUndefined();
  });

  test('an empty answer never replaces a stored catalogue or stamps it', async () => {
    await svc.refresh('x', 'movie');
    const before = await storage.getVod('x', 'movie');
    api.get_vod_categories = () => [];
    api.get_vod_streams = () => [];
    now = NOW + 99 * 3600_000;
    await expect(svc.refresh('x', 'movie')).rejects.toBeInstanceOf(SourceNetworkError);
    await expect(svc.refresh('x', 'movie')).rejects.toThrow('Unexpected response from the provider.');
    expect(await storage.getVod('x', 'movie')).toEqual(before);
    expect(await svc.fetchedAt('x', 'movie')).toBe(NOW);
  });

  test('an empty answer with nothing stored is stored (a source with no movies)', async () => {
    api.get_vod_categories = () => [];
    api.get_vod_streams = () => [];
    expect(await svc.refresh('x', 'movie')).toMatchObject({ count: 0, truncated: false });
    expect(await svc.fetchedAt('x', 'movie')).toBe(NOW);
  });

  test('an abort during the last answer rejects and stores nothing', async () => {
    const ac = new AbortController();
    api.get_vod_categories = () => [{ category_id: '1', category_name: 'Drama' }];
    api.get_vod_streams = (q) => {
      ac.abort();
      return [{ stream_id: 1, name: 'A', category_id: q.get('category_id') }];
    };
    await expect(svc.refresh('x', 'movie', { signal: ac.signal })).rejects.toBeInstanceOf(VodFetchCancelled);
    expect(await storage.getVod('x', 'movie')).toBeUndefined();
    expect(await svc.fetchedAt('x', 'movie')).toBe(0);
  });

  test('a source deleted during the fetch stores nothing and cancels', async () => {
    api.get_vod_streams = (q) => {
      void storage.deleteSource('x');
      return [{ stream_id: 1, name: 'A', category_id: q.get('category_id') }];
    };
    await expect(svc.refresh('x', 'movie')).rejects.toBeInstanceOf(VodFetchCancelled);
    expect(await storage.getVod('x', 'movie')).toBeUndefined();
  });

  test('an account change during the fetch cancels and stores nothing', async () => {
    let release!: () => void;
    hold = new Promise<void>((r) => { release = r; });
    const running = svc.refresh('x', 'movie');
    const outcome = running.then(() => 'resolved', (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 0));
    await storage.putSource({ ...xs, username: 'other' });
    release();
    expect(await outcome).toBeInstanceOf(VodFetchCancelled);
    expect(await storage.getVod('x', 'movie')).toBeUndefined();
    expect(await svc.fetchedAt('x', 'movie')).toBe(0);
  });

  test('a server change during the fetch cancels; a trailing slash alone does not', async () => {
    await storage.putSource({ ...xs, server: 'http://example.test' });
    let release!: () => void;
    hold = new Promise<void>((r) => { release = r; });
    const same = svc.refresh('x', 'movie').catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 0));
    await storage.putSource({ ...xs, server: 'http://example.test/' });
    release();
    expect(await same).toMatchObject({ count: 2 });
    await storage.replaceVod('x', 'movie', { items: [], categories: [] });
    hold = new Promise<void>((r) => { release = r; });
    const moved = svc.refresh('x', 'movie').then(() => 'resolved', (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 0));
    await storage.putSource({ ...xs, server: 'http://other.test' });
    release();
    expect(await moved).toBeInstanceOf(VodFetchCancelled);
  });
});

describe('VodService details and URLs', () => {
  test('movie detail and URL (Xtream)', async () => {
    await svc.refresh('x', 'movie');
    const item = (await svc.loadCatalog('x', 'movie')).byId('x:m10')!;
    expect(await svc.movieDetail('x', item)).toEqual({ plot: 'A synthetic plot.' });
    expect(await svc.streamUrl('x', item)).toBe('http://example.test/movie/u/p/10.mkv');
  });

  test('series detail and episode URL (Xtream); ext defaults to mp4', async () => {
    await svc.refresh('x', 'series');
    const item = (await svc.loadCatalog('x', 'series')).byId('x:s5')!;
    const d = await svc.seriesDetail('x', item);
    const ep = d.seasons[0]!.episodes[0]!;
    expect(ep.id).toBe('x:e501');
    expect(await svc.streamUrl('x', ep)).toBe('http://example.test/series/u/p/501.mp4');
    expect(await svc.streamUrl('x', { ...ep, ext: undefined })).toBe('http://example.test/series/u/p/501.mp4');
  });

  test('M3U: no detail fetch, series from stored episodes, URL from the entry', async () => {
    const ep = { id: 'm:e1', season: 1, episode: 1, title: 'Pilot', url: 'http://example.test/series/u/p/1.mp4' };
    await storage.replaceVod('m', 'series', {
      items: [{ id: 'm:s1', kind: 'series', title: 'Show', categoryId: 'g:G' }], categories: [], episodes: { 'm:s1': [ep] },
    });
    const show = (await svc.loadCatalog('m', 'series')).byId('m:s1')!;
    expect(await svc.movieDetail('m', { id: 'm:v1', kind: 'movie', title: 'A', categoryId: 'g:G' })).toEqual({});
    expect((await svc.seriesDetail('m', show)).seasons.map((s) => s.name)).toEqual(['Season 1']);
    expect(await svc.streamUrl('m', ep)).toBe(ep.url);
    expect(calls).toEqual([]);
  });

  test('a series item itself is not playable', async () => {
    await expect(svc.streamUrl('x', { id: 'x:s5', kind: 'series', title: 'S', categoryId: '1', xid: 5 })).rejects.toThrow('not playable');
  });
});

describe('VodService user state', () => {
  test('progress, favourite, watched, clear, tracks', async () => {
    const s = await svc.saveProgress('x', 'x:m10', 10 * 60_000, 3600_000);
    expect(s).toMatchObject({ position: 600_000, updatedAt: NOW });
    await svc.setFavourite('x', 'x:m10', true);
    await svc.setTracks('x', 'x:m10', { audio: 'eng' });
    expect(await svc.getUser('x', 'x:m10')).toMatchObject({ favourite: true, audio: 'eng', position: 600_000 });
    await svc.clearProgress('x', 'x:m10');
    expect((await svc.getUser('x', 'x:m10'))?.position).toBe(0);
    await svc.setWatched('x', 'x:m10', true);
    expect((await svc.listUser('x'))[0]).toMatchObject({ itemId: 'x:m10', state: { watched: true } });
  });

  test('writes for a removed source are dropped', async () => {
    await storage.deleteSource('x');
    expect(await svc.saveProgress('x', 'x:m10', 600_000, 3600_000)).toBeUndefined();
    await svc.setFavourite('x', 'x:m10', true);
    expect(await svc.listUser('x')).toEqual([]);
  });

  test('concurrent writes to one item do not lose each other', async () => {
    await Promise.all([
      svc.saveProgress('x', 'x:m10', 600_000, 3600_000),
      svc.setFavourite('x', 'x:m10', true),
      svc.setTracks('x', 'x:m10', { subtitle: 'swe' }),
    ]);
    expect(await svc.getUser('x', 'x:m10')).toMatchObject({ position: 600_000, favourite: true, subtitle: 'swe' });
  });
});

describe('VodService for the worker', () => {
  test('storedCatalog: undefined when nothing is stored, a catalogue once stored', async () => {
    expect(await svc.storedCatalog('x', 'movie')).toBeUndefined();
    await svc.refresh('x', 'movie');
    expect((await svc.storedCatalog('x', 'movie'))?.size).toBe(2);
  });

  test('refresh returns the stored list so callers need not read it back', async () => {
    const r = await svc.refresh('x', 'movie');
    expect(r.list.items.map((i) => i.id)).toEqual(['x:m10', 'x:m20']);
    expect(r.list).toEqual(await storage.getVod('x', 'movie'));
  });

  test('setters return the new state', async () => {
    expect(await svc.setFavourite('x', 'x:m10', true)).toMatchObject({ favourite: true });
    expect(await svc.setTracks('x', 'x:m10', { audio: 'eng' })).toMatchObject({ audio: 'eng', favourite: true });
    expect(await svc.clearProgress('x', 'x:m10')).toMatchObject({ position: 0 });
    const pointer = { id: 'x:s5', season: 1, episode: 1, next: { id: 'x:e2', season: 1, episode: 2 } };
    expect(await svc.setWatched('x', 'x:e1', true, pointer)).toMatchObject({ watched: true, series: pointer });
  });
});

describe('VodService refresh backoff', () => {
  const MIN = 60_000;

  test('a failed catalogue fetch waits 15 min, then 1 h, before the next automatic one; a success clears it', async () => {
    delete api.get_vod_categories;
    await expect(svc.refresh('x', 'movie')).rejects.toBeInstanceOf(SourceNetworkError);
    expect(await storage.getMeta('refreshFail:x:vod:movie')).toEqual({ count: 1, at: NOW });
    expect(await svc.needsRefresh('x', 'movie')).toBe(false);
    expect(await svc.needsRefresh('x', 'series')).toBe(true);
    now = NOW + 15 * MIN;
    expect(await svc.needsRefresh('x', 'movie')).toBe(true);
    await expect(svc.refresh('x', 'movie')).rejects.toBeInstanceOf(SourceNetworkError);
    expect(await storage.getMeta('refreshFail:x:vod:movie')).toEqual({ count: 2, at: now });
    now += 60 * MIN - 1;
    expect(await svc.needsRefresh('x', 'movie')).toBe(false);
    // A manual refresh (Try again) is never gated.
    api.get_vod_categories = () => [{ category_id: '1', category_name: 'Drama' }];
    await expect(svc.refresh('x', 'movie')).resolves.toMatchObject({ count: 1 });
    expect(await storage.getMeta('refreshFail:x:vod:movie')).toBeFalsy();
  });

  test('a cancelled fetch or a refusal records nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(svc.refresh('x', 'series', { signal: ac.signal })).rejects.toBeInstanceOf(VodFetchCancelled);
    const guard = new RefusalGuard({ storage, now: () => now });
    const guarded = new VodService({ storage, fetch: fetchFn, now: () => now, guard });
    await guard.report('x', 'refused');
    await expect(guarded.refresh('x', 'movie')).rejects.toBeInstanceOf(SourceRefusedError);
    expect(await storage.getMeta('refreshFail:x:vod:series')).toBeFalsy();
    expect(await storage.getMeta('refreshFail:x:vod:movie')).toBeFalsy();
  });
});
