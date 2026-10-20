import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryStorage } from '../../storage/src/memoryStorage.ts';
import { CATCHUP_GUIDE_DAYS, CATCHUP_HISTORY_BUDGET_MS, SourceService, catchupBackLimits, emptyIfUnsupported } from '../src/service/sourceService.ts';
import { EPG_BACK_MS } from '../src/constants.ts';
import { SourceAuthError, SourceNetworkError, SourceRefusedError } from '../src/errors.ts';
import { applyOps, emptyLayout } from '../src/layout/index.ts';
import type { Channel, FetchFn } from '../src/types.ts';
import { queryTitles } from '../src/search/titleIndex.ts';
import { MAX_PROGRAMME_MS } from '../src/storage.ts';

const detectFlags = vi.hoisted(() => ({ throwOnScore: false }));
vi.mock('../src/sports/detect.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/sports/detect.ts')>();
  return { ...real, scoreProgramme: (...a: Parameters<typeof real.scoreProgramme>) => { if (detectFlags.throwOnScore) throw new Error('boom'); return real.scoreProgramme(...a); } };
});

const m3u = readFileSync(new URL('./fixtures/basic.m3u', import.meta.url), 'utf8');
const xml = readFileSync(new URL('./fixtures/basic.xml', import.meta.url), 'utf8');
const NOW = Date.UTC(2026, 9, 13, 17, 10);
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

let routes: Record<string, () => Response | Promise<Response>>;
let storage: MemoryStorage;
let service: SourceService;
const fetchFn: FetchFn = async (url) => {
  const u = new URL(url);
  const key = u.pathname.endsWith('player_api.php') ? `api:${u.searchParams.get('action') ?? 'auth'}` : u.pathname;
  const r = routes[key];
  if (!r) throw new TypeError(`no route ${key}`);
  return await r();
};

beforeEach(() => {
  routes = { '/p.m3u': () => new Response(m3u), '/epg.xml': () => new Response(xml) };
  storage = new MemoryStorage();
  let n = 0;
  service = new SourceService({ shortEpgGapMs: 0, storage, fetch: fetchFn, now: () => NOW, newId: () => `id${++n}` });
});

const m3uInput = { kind: 'm3u' as const, name: 'Mine', playlistUrl: 'http://example.test/p.m3u', epgUrl: 'http://example.test/epg.xml' };

describe('SourceService – m3u', () => {
  test('addSource ingests, persists, activates and reports progress', async () => {
    const progress: number[] = [];
    const { source, result } = await service.addSource(m3uInput, (p) => progress.push(p.count));
    expect(source).toEqual({ ...m3uInput, id: 'id1' });
    expect(result).toEqual({ channelCount: 4, skipped: 1 });
    expect(progress.at(-1)).toBe(5);
    expect(await service.getActiveSourceId()).toBe('id1');
    expect(await storage.getMeta('playlistAt:id1')).toBe(NOW);
    expect((await service.loadIndex('id1')).groupSize('all')).toBe(4);
  });

  test('failed add leaves storage untouched', async () => {
    routes['/p.m3u'] = () => new Response('nope', { status: 403 });
    await expect(service.addSource(m3uInput)).rejects.toBeInstanceOf(SourceAuthError);
    routes['/p.m3u'] = () => new Response('#EXTM3U\n');
    await expect(service.addSource(m3uInput)).rejects.toThrow('no channels');
    delete routes['/p.m3u'];
    await expect(service.addSource(m3uInput)).rejects.toThrow('Could not reach the provider.');
    expect(await service.listSources()).toEqual([]);
    expect(await service.getActiveSourceId()).toBeUndefined();
  });

  test('layout persists through saveLayout/loadLayout/loadIndex', async () => {
    const { source } = await service.addSource(m3uInput);
    const loaded = await service.loadIndex(source.id);
    const first = loaded.slice('all', 0, 1)[0]!;
    const { layout } = applyOps(loaded.layout(), [{ op: 'addToList', listId: 'fav', channelIds: [first.id] }]);
    await service.saveLayout(source.id, layout);
    expect(await storage.getMeta(`layout:${source.id}`)).toEqual(layout);
    expect(await service.loadLayout(source.id)).toEqual(layout);
    expect((await service.loadIndex(source.id)).groupSize('fav')).toBe(1);
  });

  test('saveLayout stamps the touched registers; a load, a migration or a save without keys stamps nothing', async () => {
    const { source } = await service.addSource(m3uInput);
    const loaded = await service.loadIndex(source.id);
    expect(await storage.listSyncMeta(source.id)).toEqual([]);
    const first = loaded.slice('all', 0, 1)[0]!;
    const res = applyOps(loaded.layout(), [{ op: 'hideChannels', ids: [first.id] }, { op: 'markWatched', id: first.id }]);
    await service.saveLayout(source.id, res.layout, res.touched);
    await service.syncClock.idle(); // stamps are stored after the layout write
    const clocks = await service.syncClock.clocks(source.id);
    expect([...clocks.keys()]).toEqual([`hc:${first.id}`]);
    const zap = applyOps(res.layout, [{ op: 'markWatched', id: 'other' }]);
    await service.saveLayout(source.id, zap.layout, zap.touched);
    await service.syncClock.idle();
    expect((await service.syncClock.clocks(source.id)).size).toBe(1);
  });

  test('deleting a source drops stamps that were still queued for it', async () => {
    const { source } = await service.addSource(m3uInput);
    const loaded = await service.loadIndex(source.id);
    const res = applyOps(loaded.layout(), [{ op: 'setHideNoEpg', value: true }]);
    await service.saveLayout(source.id, res.layout, res.touched);
    await service.deleteSource(source.id);
    await service.syncClock.idle();
    expect(await storage.listSyncMeta(source.id)).toEqual([]);
  });

  test('saveLayout for a removed source stamps nothing', async () => {
    const { source } = await service.addSource(m3uInput);
    await service.deleteSource(source.id);
    await service.saveLayout(source.id, emptyLayout(), ['hc:x']);
    expect(await storage.listSyncMeta(source.id)).toEqual([]);
  });

  test('loadLayout returns an empty layout when nothing is stored', async () => {
    const { source } = await service.addSource(m3uInput);
    expect(await service.loadLayout(source.id)).toEqual(emptyLayout());
    expect(await storage.getMeta(`layout:${source.id}`)).toBeUndefined();
  });

  test('loadLayout migrates v1 flags once and persists the layout', async () => {
    const { source } = await service.addSource(m3uInput);
    const [a, b, c] = (await service.loadIndex(source.id)).slice('all', 0, 3).map((x) => x.id);
    await storage.setMeta(`flags:${source.id}`, { favourites: [a, 'gone:1'], hidden: [b], recent: [c] });
    const layout = await service.loadLayout(source.id);
    expect(layout.lists[0]).toEqual({ id: 'fav', name: 'Favourites', channelIds: [a, 'gone:1'] });
    expect(layout.hiddenChannels).toEqual([b]);
    expect(layout.recent).toEqual([c]);
    expect(await storage.getMeta(`layout:${source.id}`)).toEqual(layout);
    // The stored layout wins from now on.
    await storage.setMeta(`flags:${source.id}`, { favourites: [], hidden: [], recent: [] });
    expect(await service.loadLayout(source.id)).toEqual(layout);
    const idx = await service.loadIndex(source.id);
    expect(idx.groupSize('fav')).toBe(1);
    expect(idx.groupSize('all')).toBe(3);
  });

  test('loadLayout repairs a corrupt stored layout', async () => {
    const { source } = await service.addSource(m3uInput);
    await storage.setMeta(`layout:${source.id}`, { version: -3, lists: 'nope', hiddenChannels: [1, 'x', 'x'], hideNoEpg: 'yes' });
    const layout = await service.loadLayout(source.id);
    expect(layout).toEqual({ ...emptyLayout(), hiddenChannels: ['x'] });
  });

  test('EPG coverage is unknown before the first guide load, then lists the covered epg keys', async () => {
    const { source } = await service.addSource(m3uInput);
    expect(await service.loadEpgCoverage(source.id)).toBeUndefined();
    await service.refreshEpg(source.id);
    expect(await service.loadEpgCoverage(source.id)).toEqual(new Set(['ch1.test', 'ch2.test']));
    expect([...(await storage.getMeta<string[]>(`epgCoverage:${source.id}`))!].sort()).toEqual(['ch1.test', 'ch2.test']);
  });

  test('loadIndex applies hideNoEpg with the stored coverage', async () => {
    const { source } = await service.addSource(m3uInput);
    const { layout } = applyOps(await service.loadLayout(source.id), [{ op: 'setHideNoEpg', value: true }]);
    await service.saveLayout(source.id, layout);
    // Coverage unknown: the filter is skipped instead of hiding everything.
    expect((await service.loadIndex(source.id)).groupSize('all')).toBe(4);
    await service.refreshEpg(source.id);
    expect((await service.loadIndex(source.id)).groupSize('all')).toBe(2);
  });

  test('a failed guide refresh keeps the previous coverage', async () => {
    const { source } = await service.addSource(m3uInput);
    await service.refreshEpg(source.id);
    routes['/epg.xml'] = () => new Response('<html>nope</html>', { status: 500 });
    await expect(service.refreshEpg(source.id)).rejects.toBeInstanceOf(SourceNetworkError);
    expect(await service.loadEpgCoverage(source.id)).toEqual(new Set(['ch1.test', 'ch2.test']));
  });

  test('deleteSource removes layout and coverage', async () => {
    const { source } = await service.addSource(m3uInput);
    await service.refreshEpg(source.id);
    await service.saveLayout(source.id, applyOps(emptyLayout(), [{ op: 'hideChannels', ids: ['x'] }]).layout);
    await service.deleteSource(source.id);
    expect(await storage.getMeta(`layout:${source.id}`)).toBeUndefined();
    expect(await storage.getMeta(`epgCoverage:${source.id}`)).toBeUndefined();
  });

  test('saveLayout for a deleted source writes nothing', async () => {
    const { source } = await service.addSource(m3uInput);
    await service.deleteSource(source.id);
    await service.saveLayout(source.id, emptyLayout());
    expect(await storage.getMeta(`layout:${source.id}`)).toBeUndefined();
  });

  test('a saveLayout racing deleteSource leaves no orphan layout key', async () => {
    const { source } = await service.addSource(m3uInput);
    const key = `layout:${source.id}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inner = storage.setMeta.bind(storage);
    // The layout write is held open after saveLayout has seen the source, while the delete runs.
    storage.setMeta = async (k: string, v: unknown) => {
      if (k === key && v !== null) await gate;
      await inner(k, v);
    };
    const save = service.saveLayout(source.id, applyOps(emptyLayout(), [{ op: 'hideChannels', ids: ['x'] }]).layout);
    await new Promise((r) => setTimeout(r, 5));
    const del = service.deleteSource(source.id);
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([save, del]);
    expect(await storage.listSources()).toEqual([]);
    expect((await storage.getMeta(key)) ?? null).toBeNull(); // cleared (or never written)
  });

  test('a v1 migration cannot overwrite a layout saved meanwhile', async () => {
    const { source } = await service.addSource(m3uInput);
    const key = `layout:${source.id}`;
    await storage.setMeta(`flags:${source.id}`, { favourites: ['a'], hidden: [], recent: [] });
    const inner = storage.getMeta.bind(storage);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held = false;
    // Hold the migration after it has read the (absent) layout, so a save can try to slip in.
    storage.getMeta = (async (k: string) => {
      const v = await inner(k);
      if (k === key && !held) { held = true; await gate; }
      return v;
    }) as typeof storage.getMeta;
    const load = service.loadLayout(source.id);
    await new Promise((r) => setTimeout(r, 5));
    const mine = applyOps(emptyLayout(), [{ op: 'hideChannels', ids: ['x'] }]).layout;
    const save = service.saveLayout(source.id, mine);
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([load, save]);
    storage.getMeta = inner;
    expect(await service.loadLayout(source.id)).toEqual(mine);
  });

  test('refresh timing helpers', async () => {
    const { source } = await service.addSource(m3uInput);
    expect(await service.needsPlaylistRefresh(source.id)).toBe(false);
    expect(await service.needsEpgRefresh(source.id)).toBe(true);
    await storage.setMeta(`playlistAt:${source.id}`, NOW - 13 * 3600_000);
    expect(await service.needsPlaylistRefresh(source.id)).toBe(true);
  });

  test('refreshEpg stores matched in-window programmes; nowNextFor finds them', async () => {
    const { source } = await service.addSource(m3uInput);
    const res = await service.refreshEpg(source.id);
    expect(res).toEqual({ programmes: 2, skipped: 2 });
    expect(await service.needsEpgRefresh(source.id)).toBe(false);
    const channels = (await service.loadIndex(source.id)).slice('all', 0, 10);
    const nn = await service.nowNextFor(source.id, channels);
    const ch1 = channels.find((c) => c.epgId === 'ch1.test')!;
    expect(nn.get(ch1.id)?.now?.title).toBe('Evening Bulletin');
  });

  test('refreshEpg records the longest stored programme with the generation; reads look back only that far', async () => {
    const { source } = await service.addSource(m3uInput);
    await service.refreshEpg(source.id);
    const gen = await storage.getMeta<number>(`epgGen:${source.id}`);
    // Both stored programmes of the fixture last 30 minutes.
    expect(await storage.getMeta(`epgLongest:${source.id}`)).toEqual({ gen, ms: 30 * 60_000 });
    const channels = (await service.loadIndex(source.id)).slice('all', 0, 10);
    const reads = vi.spyOn(storage, 'getProgrammes');
    const lookBack = () => reads.mock.calls.at(-1)![4];
    expect((await service.nowNextFor(source.id, channels)).size).toBe(channels.length);
    expect(lookBack()).toBe(30 * 60_000);
    // Missing, from another generation, or malformed: the 24-hour default. Never more than that.
    for (const [meta, want] of [
      [null, MAX_PROGRAMME_MS], [{ gen: gen! + 1, ms: 60_000 }, MAX_PROGRAMME_MS], [{ gen, ms: 'x' }, MAX_PROGRAMME_MS],
      [{ gen, ms: 3 * MAX_PROGRAMME_MS }, MAX_PROGRAMME_MS], [{ gen, ms: 7_200_000 }, 7_200_000],
    ] as const) {
      await storage.setMeta(`epgLongest:${source.id}`, meta);
      await service.programmesFor(source.id, channels, NOW, NOW + 1);
      expect(lookBack()).toBe(want);
    }
  });

  test('a failed guide import keeps the longest programme of the live generation', async () => {
    const { source } = await service.addSource(m3uInput);
    await service.refreshEpg(source.id);
    const before = await storage.getMeta(`epgLongest:${source.id}`);
    // The download breaks off after the first programmes.
    routes['/epg.xml'] = () => new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(xml.slice(0, xml.indexOf('</programme>') + 12)));
        c.error(new TypeError('connection reset'));
      },
    }));
    await expect(service.refreshEpg(source.id)).rejects.toThrow();
    expect(await storage.getMeta(`epgLongest:${source.id}`)).toEqual(before);
  });

  test('deleteSource removes it and moves active to the next source', async () => {
    const a = await service.addSource(m3uInput);
    const b = await service.addSource({ ...m3uInput, name: 'Second' });
    await service.deleteSource(a.source.id);
    expect((await service.listSources()).map((s) => s.id)).toEqual([b.source.id]);
    expect(await service.getActiveSourceId()).toBe(b.source.id);
    await service.deleteSource(b.source.id);
    expect(await service.getActiveSourceId()).toBeUndefined();
  });
});

const WIDE = [0, 4e12] as const;

describe('SourceService – robustness', () => {
  test('an EPG body that errors mid-stream keeps the previous guide and throws SourceNetworkError', async () => {
    const { source } = await service.addSource(m3uInput);
    await service.refreshEpg(source.id);
    const channels = (await service.loadIndex(source.id)).slice('all', 0, 10);
    const count = async () => [...(await service.programmesFor(source.id, channels, ...WIDE)).values()].flat().length;
    expect(await count()).toBe(2);
    routes['/epg.xml'] = () => {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(xml.slice(0, xml.indexOf('<programme start="20261013173000"'))));
          c.error(new Error('socket reset'));
        },
      });
      return new Response(body);
    };
    const err = await service.refreshEpg(source.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceNetworkError);
    expect((err as Error).message).toBe('The guide download was interrupted.');
    expect(await count()).toBe(2);
  });

  test('a guide that is not XMLTV fails with "could not be read" and keeps the previous guide', async () => {
    const { source } = await service.addSource(m3uInput);
    await service.refreshEpg(source.id);
    const channels = (await service.loadIndex(source.id)).slice('all', 0, 10);
    const count = async () => [...(await service.programmesFor(source.id, channels, ...WIDE)).values()].flat().length;
    for (const body of ['this is not a guide', '<html><body><p>Oops</body>', '{"error":"x"}']) {
      routes['/epg.xml'] = () => new Response(body);
      const err = await service.refreshEpg(source.id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SourceNetworkError);
      expect((err as Error).message).toBe('The TV guide could not be read.');
      expect(await count()).toBe(2);
    }
    // An empty but valid guide is not an error.
    routes['/epg.xml'] = () => new Response('<?xml version="1.0"?><tv></tv>');
    await expect(service.refreshEpg(source.id)).resolves.toEqual({ programmes: 0, skipped: 0 });
  });

  test('concurrent refreshEpg calls for one source leave no duplicate programmes', async () => {
    const { source } = await service.addSource(m3uInput);
    await Promise.all([service.refreshEpg(source.id), service.refreshEpg(source.id)]);
    const channels = (await service.loadIndex(source.id)).slice('all', 0, 10);
    const all = [...(await service.programmesFor(source.id, channels, ...WIDE)).values()].flat();
    expect(all).toHaveLength(2);
  });

  test('deleteSource racing refreshPlaylist leaves nothing behind', async () => {
    const { source } = await service.addSource(m3uInput);
    await service.refreshEpg(source.id);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    routes['/p.m3u'] = async () => { await gate; return new Response(m3u); };
    const refresh = service.refreshPlaylist(source.id);
    const del = service.deleteSource(source.id);
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.allSettled([refresh, del]);
    expect(await storage.listSources()).toEqual([]);
    expect(await storage.getChannels(source.id)).toEqual([]);
    expect(await storage.getMeta(`playlistAt:${source.id}`)).toBeUndefined();
    expect(await storage.getMeta(`epgGen:${source.id}`)).toBeUndefined();
    for (const key of [source.id, `${source.id}@1`, `${source.id}@2`]) {
      expect(await storage.getProgrammes(key, ['ch1.test', 'ch2.test'], ...WIDE)).toEqual([]);
    }
  });

  test('a source without epgUrl is not flagged for EPG refresh after refreshEpg', async () => {
    const { source } = await service.addSource({ kind: 'm3u', name: 'No guide', playlistUrl: m3uInput.playlistUrl });
    expect(await service.needsEpgRefresh(source.id)).toBe(true);
    expect(await service.refreshEpg(source.id)).toEqual({ programmes: 0, skipped: 0 });
    expect(await service.needsEpgRefresh(source.id)).toBe(false);
  });

  test('a failed add leaves no source, channels or active source', async () => {
    class Failing extends MemoryStorage {
      override async replaceChannels(): Promise<void> { throw new Error('disk full'); }
    }
    const failing = new Failing();
    const svc = new SourceService({ shortEpgGapMs: 0, storage: failing, fetch: fetchFn, now: () => NOW, newId: () => 'bad1' });
    await expect(svc.addSource(m3uInput)).rejects.toThrow('disk full');
    expect(await failing.listSources()).toEqual([]);
    expect(await failing.getChannels('bad1')).toEqual([]);
    expect(await svc.getActiveSourceId()).toBeUndefined();
  });
});

describe('SourceService – timeouts', () => {
  test('playlist and guide downloads get 90 s to first byte; API calls 15 s', async () => {
    const seen: [string, number | undefined][] = [];
    const recording: FetchFn = async (url, init) => {
      seen.push([new URL(url).pathname, init?.timeoutMs]);
      return fetchFn(url, init);
    };
    const svc = new SourceService({ shortEpgGapMs: 0, storage, fetch: recording, now: () => NOW, newId: () => 't1' });
    const { source } = await svc.addSource(m3uInput);
    await svc.refreshEpg(source.id);
    expect(seen).toEqual([['/p.m3u', 90_000], ['/epg.xml', 90_000]]);
    seen.length = 0;
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
    routes['api:get_live_categories'] = () => json([]);
    routes['api:get_live_streams'] = () => json([{ stream_id: 1, name: 'Channel 1' }]);
    await svc.addSource({ kind: 'xtream', name: 'X', server: 'http://example.test', username: 'u', password: 'p' });
    expect(seen.map(([, ms]) => ms)).toEqual([15_000, 15_000, 15_000]);
  });

  test('a stalled playlist body fails with a neutral error and releases the source lock', async () => {
    const { source } = await service.addSource(m3uInput);
    const svc = new SourceService({ shortEpgGapMs: 0, storage, fetch: fetchFn, now: () => NOW, bodyIdleMs: 30 });
    routes['/p.m3u'] = () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('#EXTM3U\n')); },
      pull: () => new Promise<void>(() => {}),
    }));
    await expect(svc.refreshPlaylist(source.id)).rejects.toThrow('The provider stopped sending data.');
    routes['/p.m3u'] = () => new Response(m3u);
    await expect(svc.refreshPlaylist(source.id)).resolves.toMatchObject({ channelCount: 4 });
  });

  test('a stalled guide body fails with a neutral error and releases the source lock', async () => {
    const { source } = await service.addSource(m3uInput);
    const svc = new SourceService({ shortEpgGapMs: 0, storage, fetch: fetchFn, now: () => NOW, bodyIdleMs: 30 });
    routes['/epg.xml'] = () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('<tv>')); },
      pull: () => new Promise<void>(() => {}),
    }));
    const err = await svc.refreshEpg(source.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceNetworkError);
    expect((err as Error).message).toBe('The provider stopped sending data.');
    routes['/epg.xml'] = () => new Response(xml);
    await expect(svc.refreshEpg(source.id)).resolves.toMatchObject({ programmes: 2 });
  });
});

describe('SourceService – xtream', () => {
  const xInput = { kind: 'xtream' as const, name: 'X', server: 'http://example.test', username: 'u', password: 'p' };

  test('addSource authenticates and maps streams; short EPG fallback works', async () => {
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
    routes['api:get_live_categories'] = () => json([{ category_id: '1', category_name: 'News' }]);
    routes['api:get_live_streams'] = () => json([{ stream_id: 7, name: 'Channel 007', category_id: '1', epg_channel_id: 'c7.test', num: 7 }]);
    routes['api:get_short_epg'] = () => json({ epg_listings: [
      { title: btoa('Live Now'), start_timestamp: String(NOW / 1000 - 60), stop_timestamp: String(NOW / 1000 + 60) },
    ] });
    const { source, result } = await service.addSource(xInput);
    expect(result).toEqual({ channelCount: 1, skipped: 0 });
    const [c7] = (await service.loadIndex(source.id)).slice('all', 0, 1);
    expect(c7?.url).toBe('http://example.test/live/u/p/7.ts');
    // nowNextFor reads stored programmes only; the short EPG is a separate (background) lookup.
    expect((await service.nowNextFor(source.id, [c7!])).get(c7!.id)).toEqual({});
    const nn = await service.shortEpgFor(source.id, [c7!]);
    expect(nn.get(c7!.id)?.now?.title).toBe('Live Now');
  });

  test('updateSource resets the VOD freshness of an Xtream source', async () => {
    const { source } = await (async () => {
      routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
      routes['api:get_live_categories'] = () => json([{ category_id: '1', category_name: 'News' }]);
      routes['api:get_live_streams'] = () => json([{ stream_id: 1, name: 'Channel 1', category_id: '1', num: 1 }]);
      return service.addSource(xInput);
    })();
    await storage.setMeta(`vodAt:movie:${source.id}`, NOW);
    await storage.setMeta(`vodAt:series:${source.id}`, NOW);
    await service.updateSource({ ...source, name: 'Renamed' });
    expect(await storage.getMeta(`vodAt:movie:${source.id}`)).toBe(0);
    expect(await storage.getMeta(`vodAt:series:${source.id}`)).toBe(0);
  });

  test('updateSource keeps the stored catch-up time when the input has no such field; a value in the input wins', async () => {
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
    routes['api:get_live_categories'] = () => json([{ category_id: '1', category_name: 'News' }]);
    routes['api:get_live_streams'] = () => json([{ stream_id: 1, name: 'Channel 1', category_id: '1', num: 1 }]);
    const { source } = await service.addSource(xInput);
    await service.setCatchupOffset(source.id, 120);
    const { catchupOffsetMin: _drop, ...edited } = { ...source, name: 'Renamed' };
    await service.updateSource(edited);
    expect((await storage.listSources())[0]).toMatchObject({ name: 'Renamed', catchupOffsetMin: 120 });
    await service.updateSource({ ...edited, catchupOffsetMin: -60 });
    expect((await storage.listSources())[0]?.catchupOffsetMin).toBe(-60);
  });

  test('updateSource clears an Xtream source\'s VOD lists when the server or username changes', async () => {
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
    routes['api:get_live_categories'] = () => json([{ category_id: '1', category_name: 'News' }]);
    routes['api:get_live_streams'] = () => json([{ stream_id: 1, name: 'Channel 1', category_id: '1', num: 1 }]);
    const { source } = await service.addSource(xInput);
    const list = { items: [{ id: `${source.id}:m1`, kind: 'movie' as const, title: 'Synthetic Film 001', categoryId: '1' }], categories: [] };
    await storage.replaceVod(source.id, 'movie', list);
    await service.updateSource({ ...source, name: 'Renamed' });
    expect((await storage.getVod(source.id, 'movie'))?.items).toHaveLength(1);
    if (source.kind !== 'xtream') throw new Error('expected an Xtream source');
    await service.updateSource({ ...source, username: 'other' });
    expect((await storage.getVod(source.id, 'movie'))?.items).toEqual([]);
    expect((await storage.getVod(source.id, 'series'))?.items).toEqual([]);
  });

  const addX = async (streams: number) => {
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
    routes['api:get_live_categories'] = () => json([{ category_id: '1', category_name: 'News' }]);
    routes['api:get_live_streams'] = () => json(Array.from({ length: streams }, (_, i) => (
      { stream_id: i + 1, name: `Channel ${i + 1}`, category_id: '1', num: i + 1 })));
    const { source } = await service.addSource(xInput);
    return { source, channels: (await service.loadIndex(source.id)).slice('all', 0, streams) };
  };

  test('nowNextFor never waits for the network', async () => {
    const { source, channels } = await addX(3);
    let calls = 0;
    routes['api:get_short_epg'] = () => { calls++; return new Promise<Response>(() => {}); };
    const nn = await service.nowNextFor(source.id, channels);
    expect([...nn.values()]).toEqual([{}, {}, {}]);
    expect(calls).toBe(0);
  });

  test('shortEpgFor sends one request at a time across calls', async () => {
    const { source, channels } = await addX(20);
    let active = 0;
    let peak = 0;
    routes['api:get_short_epg'] = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return json({ epg_listings: [] });
    };
    await Promise.all([service.shortEpgFor(source.id, channels.slice(0, 10)), service.shortEpgFor(source.id, channels.slice(10))]);
    expect(peak).toBe(1);
  });

  /** Holds every short-EPG request until `open()`; records the requested stream ids and usernames. */
  const holdShortEpg = () => {
    const seen: { stream: number; user: string }[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    return { seen, open: () => open(), gate };
  };
  const shortRoute = (h: ReturnType<typeof holdShortEpg>): FetchFn => async (url, init) => {
    const u = new URL(url);
    if (u.searchParams.get('action') === 'get_short_epg') {
      h.seen.push({ stream: Number(u.searchParams.get('stream_id')), user: u.searchParams.get('username') ?? '' });
      await h.gate;
      return json({ epg_listings: [] });
    }
    return fetchFn(url, init);
  };

  test('shortEpgFor drops the oldest waiters once the queue is past its cap', async () => {
    const { source, channels } = await addX(8);
    const h = holdShortEpg();
    const svc = new SourceService({ shortEpgGapMs: 0, storage, fetch: shortRoute(h), now: () => NOW });
    // 1 runs, 4 may wait: the 6th, 7th and 8th push out the three oldest waiters (streams 2, 3 and 4).
    const done = svc.shortEpgFor(source.id, channels);
    await new Promise((r) => setTimeout(r, 5));
    expect(h.seen.map((s) => s.stream)).toEqual([1]);
    h.open();
    const found = await done;
    expect(h.seen.map((s) => s.stream).sort((a, b) => a - b)).toEqual([1, 5, 6, 7, 8]);
    expect(found.size).toBe(5);
  });

  test('shortEpgFor sends no request for a lookup that is stale when its turn comes', async () => {
    const { source, channels } = await addX(3);
    const h = holdShortEpg();
    const svc = new SourceService({ shortEpgGapMs: 0, storage, fetch: shortRoute(h), now: () => NOW });
    let stale = false;
    const done = svc.shortEpgFor(source.id, channels, { isStale: () => stale });
    await new Promise((r) => setTimeout(r, 5));
    expect(h.seen).toHaveLength(1);
    stale = true;
    h.open();
    expect((await done).size).toBe(1);
    expect(h.seen).toHaveLength(1);
    expect((await svc.shortEpgFor(source.id, channels, { isStale: () => true })).size).toBe(0);
    expect(h.seen).toHaveLength(1);
  });

  test('shortEpgFor uses the stored source config at request time', async () => {
    const { source, channels } = await addX(3);
    const h = holdShortEpg();
    const svc = new SourceService({ shortEpgGapMs: 0, storage, fetch: shortRoute(h), now: () => NOW });
    const done = svc.shortEpgFor(source.id, channels);
    await new Promise((r) => setTimeout(r, 5));
    await storage.putSource({ ...source, username: 'renamed' } as typeof source);
    h.open();
    await done;
    expect(h.seen.map((s) => s.user)).toEqual(['u', 'renamed', 'renamed']);
  });

  test('shortEpgFor is skipped while a guide refresh of the source runs', async () => {
    const { source, channels } = await addX(2);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    routes['/xmltv.php'] = async () => { await gate; return new Response('<tv></tv>'); };
    let calls = 0;
    routes['api:get_short_epg'] = () => { calls++; return json({ epg_listings: [] }); };
    const refresh = service.refreshEpg(source.id);
    await new Promise((r) => setTimeout(r, 5));
    expect(service.isRefreshingEpg(source.id)).toBe(true);
    expect((await service.shortEpgFor(source.id, channels)).size).toBe(0);
    expect(calls).toBe(0);
    release();
    await refresh;
    expect(service.isRefreshingEpg(source.id)).toBe(false);
    expect((await service.shortEpgFor(source.id, channels)).size).toBe(2);
    expect(calls).toBe(2);
  });

  test('shortEpgFor waits the gap between two requests to one source', async () => {
    const { source, channels } = await addX(3);
    const at: number[] = [];
    routes['api:get_short_epg'] = () => { at.push(Date.now()); return json({ epg_listings: [] }); };
    const svc = new SourceService({ shortEpgGapMs: 60, storage, fetch: fetchFn });
    expect((await svc.shortEpgFor(source.id, channels)).size).toBe(3);
    expect(at).toHaveLength(3);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(55);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(55);
  });

  test('a failed short-EPG request answers "nothing found", so callers can cache it', async () => {
    const { source, channels } = await addX(1);
    routes['api:get_short_epg'] = () => new Response('', { status: 500 });
    expect((await service.shortEpgFor(source.id, channels)).get(channels[0]!.id)).toEqual({});
  });

  test('shortEpgFor caps the gap wait when the clock jumps back', async () => {
    const { source, channels } = await addX(2);
    let clock = NOW;
    const at: number[] = [];
    routes['api:get_short_epg'] = () => {
      at.push(Date.now());
      if (at.length === 1) clock -= 3_600_000; // NTP corrects the clock by an hour
      return json({ epg_listings: [] });
    };
    const svc = new SourceService({ shortEpgGapMs: 40, storage, fetch: fetchFn, now: () => clock });
    expect((await svc.shortEpgFor(source.id, channels)).size).toBe(2);
    expect(at[1]! - at[0]!).toBeLessThan(1000);
  });

  test('two concurrent shortEpgFor calls to one source are spaced by the gap', async () => {
    const { source, channels } = await addX(4);
    const at: number[] = [];
    routes['api:get_short_epg'] = () => { at.push(Date.now()); return json({ epg_listings: [] }); };
    const svc = new SourceService({ shortEpgGapMs: 40, storage, fetch: fetchFn });
    await Promise.all([svc.shortEpgFor(source.id, channels.slice(0, 2)), svc.shortEpgFor(source.id, channels.slice(2))]);
    expect(at).toHaveLength(4);
    for (let k = 1; k < at.length; k++) expect(at[k]! - at[k - 1]!).toBeGreaterThanOrEqual(35);
  });

  test('a failed short-EPG request still counts toward the gap', async () => {
    const { source, channels } = await addX(2);
    const at: number[] = [];
    routes['api:get_short_epg'] = () => { at.push(Date.now()); return new Response('', { status: 500 }); };
    const svc = new SourceService({ shortEpgGapMs: 40, storage, fetch: fetchFn });
    expect((await svc.shortEpgFor(source.id, channels)).size).toBe(2);
    expect(at).toHaveLength(2);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(35);
  });

  test('the short-EPG gap is per source: another source is not delayed by it', async () => {
    const a = await addX(1);
    const b = await addX(1);
    expect(b.source.id).not.toBe(a.source.id);
    const at: Record<string, number> = {};
    routes['api:get_short_epg'] = () => { at[String(Object.keys(at).length)] = Date.now(); return json({ epg_listings: [] }); };
    const svc = new SourceService({ shortEpgGapMs: 400, storage, fetch: fetchFn });
    await svc.shortEpgFor(a.source.id, a.channels);
    const t0 = Date.now();
    await svc.shortEpgFor(b.source.id, b.channels);
    expect(Date.now() - t0).toBeLessThan(200);
    const t1 = Date.now();
    await svc.shortEpgFor(a.source.id, a.channels);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(300);
  });

  const stalledJson = (head: string) => () => new Response(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode(head)); },
    pull: () => new Promise<void>(() => {}),
  }));

  test('a stalled get_live_streams body fails on add and refresh and releases the source lock', async () => {
    const svc = new SourceService({ shortEpgGapMs: 0, storage, fetch: fetchFn, now: () => NOW, bodyIdleMs: 30, newId: () => 'sx' });
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
    routes['api:get_live_categories'] = () => json([]);
    routes['api:get_live_streams'] = stalledJson('[');
    await expect(svc.addSource(xInput)).rejects.toThrow('The provider stopped sending data.');
    routes['api:get_live_streams'] = () => json([{ stream_id: 1, name: 'Channel 1' }]);
    const { source } = await svc.addSource(xInput);
    routes['api:get_live_streams'] = stalledJson('[{');
    const err = await svc.refreshPlaylist(source.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceNetworkError);
    expect((err as Error).message).toBe('The provider stopped sending data.');
    routes['api:get_live_streams'] = () => json([{ stream_id: 1, name: 'Channel 1' }, { stream_id: 2, name: 'Channel 2' }]);
    await expect(svc.refreshPlaylist(source.id)).resolves.toMatchObject({ channelCount: 2 });
  });

  test('a stalled short EPG body releases its limiter slot', async () => {
    const { source, channels } = await addX(7);
    const svc = new SourceService({ shortEpgGapMs: 0, storage, fetch: fetchFn, now: () => NOW, bodyIdleMs: 30 });
    routes['api:get_short_epg'] = stalledJson('{"epg_listings":[');
    expect((await svc.shortEpgFor(source.id, channels.slice(0, 6))).size).toBe(5);
    routes['api:get_short_epg'] = () => json({ epg_listings: [] });
    expect((await svc.shortEpgFor(source.id, channels.slice(6))).size).toBe(1);
  });

  test('an account with no live streams and no movies or series fails on add', async () => {
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
    routes['api:get_live_categories'] = () => json([]);
    routes['api:get_live_streams'] = () => json([]);
    routes['api:get_vod_categories'] = () => json([]);
    routes['api:get_series_categories'] = () => json([]);
    const err = await service.addSource(xInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceNetworkError);
    expect((err as Error).message).toBe('The account has no channels, movies or series.');
    expect(await service.listSources()).toEqual([]);
  });

  test('a live-empty account with movie or series categories is kept, and the ingest says it has a catalogue', async () => {
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
    routes['api:get_live_categories'] = () => json([]);
    routes['api:get_live_streams'] = () => json([]);
    routes['api:get_vod_categories'] = () => json([]);
    routes['api:get_series_categories'] = () => json([{ category_id: '1', category_name: 'Synthetic Shows' }]);
    const { source, result } = await service.addSource(xInput);
    expect(result).toEqual({ channelCount: 0, skipped: 0, vodCatalogue: true });
    expect(await storage.getMeta(`parseStats:${source.id}`)).toEqual({ channelCount: 0, skipped: 0, vodCatalogue: true });
    await expect(service.refreshPlaylist(source.id)).resolves.toEqual({ channelCount: 0, skipped: 0, vodCatalogue: true });
  });

  test('a provider without the movie action still gives the clear empty-account message', async () => {
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
    routes['api:get_live_categories'] = () => json([]);
    routes['api:get_live_streams'] = () => json([]);
    routes['api:get_vod_categories'] = () => json({}, 500);
    routes['api:get_series_categories'] = () => json([]);
    const err = await service.addSource(xInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceNetworkError);
    expect((err as Error).message).toBe('The account has no channels, movies or series.');
  });

  test('the VOD probe of a live-empty account rethrows refusals, a rejected login and network failures', async () => {
    const liveEmpty = () => {
      routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
      routes['api:get_live_categories'] = () => json([]);
      routes['api:get_live_streams'] = () => json([]);
      routes['api:get_series_categories'] = () => json([]);
    };
    liveEmpty();
    routes['api:get_vod_categories'] = () => json({}, 403);
    await expect(service.addSource(xInput)).rejects.toBeInstanceOf(SourceAuthError);
    const fresh = () => new SourceService({ shortEpgGapMs: 0, storage: new MemoryStorage(), fetch: fetchFn, now: () => NOW });
    liveEmpty();
    routes['api:get_vod_categories'] = () => json({}, 429);
    const refused = await fresh().addSource(xInput).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(SourceNetworkError);
    expect((refused as SourceNetworkError).status).toBe(429);
    liveEmpty();
    routes['api:get_vod_categories'] = () => { throw new TypeError('fetch failed'); };
    await expect(fresh().addSource(xInput)).rejects.toThrow('Could not reach the provider.');
    expect(await service.listSources()).toEqual([]);
  });

  test('the VOD probe rethrows a cooldown refusal and keeps only "unsupported" answers as empty', () => {
    expect(() => emptyIfUnsupported(new SourceRefusedError())).toThrow(SourceRefusedError);
    expect(() => emptyIfUnsupported(new SourceAuthError())).toThrow(SourceAuthError);
    expect(() => emptyIfUnsupported(new SourceNetworkError('x', 503))).toThrow(SourceNetworkError);
    expect(() => emptyIfUnsupported(new SourceNetworkError('Could not reach the provider.'))).toThrow(SourceNetworkError);
    expect(emptyIfUnsupported(new SourceNetworkError('x', 404))).toEqual([]);
    expect(emptyIfUnsupported(new SourceNetworkError('Unexpected response from the provider.'))).toEqual([]);
  });

  test('a 503 on the VOD probe is a refusal: rethrown and the source cools down', async () => {
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
    routes['api:get_live_categories'] = () => json([{ category_id: '1', category_name: 'News' }]);
    routes['api:get_live_streams'] = () => json([{ stream_id: 1, name: 'Channel 1', category_id: '1' }]);
    const { source } = await service.addSource(xInput);
    routes['api:get_live_streams'] = () => json([]);
    routes['api:get_vod_categories'] = () => json({}, 503);
    routes['api:get_series_categories'] = () => json([]);
    await expect(service.refreshPlaylist(source.id)).rejects.toMatchObject({ status: 503 });
    expect(service.guard.isBlocked(source.id)).toBe(true);
    await expect(service.refreshPlaylist(source.id)).rejects.toBeInstanceOf(SourceRefusedError);
  });

  test('a non-JSON answer to the VOD probe counts as no catalogue', async () => {
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
    routes['api:get_live_categories'] = () => json([]);
    routes['api:get_live_streams'] = () => json([]);
    routes['api:get_vod_categories'] = () => new Response('<html>not here</html>');
    routes['api:get_series_categories'] = () => json([]);
    await expect(service.addSource(xInput)).rejects.toThrow('The account has no channels, movies or series.');
  });

  test('an account with only movies or series is accepted', async () => {
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
    routes['api:get_live_categories'] = () => json([]);
    routes['api:get_live_streams'] = () => json([]);
    routes['api:get_vod_categories'] = () => json([{ category_id: '1', category_name: 'Drama' }]);
    routes['api:get_series_categories'] = () => json([]);
    const { result } = await service.addSource(xInput);
    expect(result.channelCount).toBe(0);
  });

  test('a refresh that finds no live channels keeps the stored ones', async () => {
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
    routes['api:get_live_categories'] = () => json([]);
    routes['api:get_live_streams'] = () => json([{ stream_id: 1, name: 'Channel 1' }]);
    routes['api:get_vod_categories'] = () => json([{ category_id: '1', category_name: 'Drama' }]);
    routes['api:get_series_categories'] = () => json([]);
    const { source } = await service.addSource(xInput);
    routes['api:get_live_streams'] = () => json([]);
    await expect(service.refreshPlaylist(source.id)).rejects.toThrow('The account has no live channels.');
    expect((await service.loadIndex(source.id)).groupSize('all')).toBe(1);
  });

  test('clearing the cache clears movie and series lists but keeps VOD user state', async () => {
    routes['/vod.m3u'] = () => new Response([
      '#EXTM3U', '#EXTINF:-1,Channel 001', 'http://example.test/live/u/p/1.ts',
      '#EXTINF:-1 group-title="Drama",Synthetic Film 001', 'http://example.test/movie/u/p/11.mkv',
    ].join('\n'));
    const { source } = await service.addSource({ kind: 'm3u', name: 'Mine', playlistUrl: 'http://example.test/vod.m3u' });
    const state = { position: 600_000, duration: 3_600_000, watched: false, favourite: true, updatedAt: NOW };
    await storage.putVodUser(source.id, 'x', state);
    await service.clearCachedData(source.id);
    expect((await storage.getVod(source.id, 'movie'))?.items).toEqual([]);
    expect((await storage.getVod(source.id, 'series'))?.items).toEqual([]);
    expect(await storage.getMeta(`vodAt:movie:${source.id}`)).toBe(0);
    expect(await storage.getVodUser(source.id, 'x')).toEqual(state);
  });

  test('clearing the cache also forgets the guide look-back record (epgLongest)', async () => {
    routes['/one.m3u'] = () => new Response(['#EXTM3U', '#EXTINF:-1,Channel 001', 'http://example.test/live/u/p/1.ts'].join('\n'));
    const { source } = await service.addSource({ kind: 'm3u', name: 'Mine', playlistUrl: 'http://example.test/one.m3u' });
    await storage.setMeta(`epgLongest:${source.id}`, { gen: 1, ms: 30 * 3_600_000 });
    await service.clearCachedData(source.id);
    expect(await storage.getMeta(`epgLongest:${source.id}`)).toBeFalsy();
  });

  test('rejected login surfaces SourceAuthError, server error surfaces SourceNetworkError', async () => {
    routes['api:auth'] = () => json({ user_info: { auth: 0 } });
    await expect(service.addSource(xInput)).rejects.toBeInstanceOf(SourceAuthError);
    routes['api:auth'] = () => json({}, 502);
    await expect(service.addSource(xInput)).rejects.toBeInstanceOf(SourceNetworkError);
  });
});

describe('SourceService – settings, cache clearing, EPG commit', () => {
  const countAll = async (id: string) => {
    const channels = (await service.loadIndex(id)).slice('all', 0, 100);
    return [...(await service.programmesFor(id, channels, ...WIDE)).values()].flat().length;
  };

  test('settings default, merge, sanitise and persist under meta key settings', async () => {
    expect(await service.getSettings()).toEqual({
      epgOffsetHours: 0, preferredFormat: 'ts', autoRefreshHours: 12, sleepTimerMinutes: 0, showClock: true,
      liveDelay: 'balanced', subtitleLanguage: 'off', audioLanguage: 'auto', subtitleExactMatch: false,
      combineDuplicates: true, preferredLanguages: [], openOn: 'lastChannel', followedTeams: [], posterSize: 'standard', combineChannels: false,
      regions: { codes: [], mode: 'off' }, combineCategories: false, pinnedCompetitions: [], hiddenCompetitions: [], matchCategories: [],
    });
    const saved = await service.saveSettings({ epgOffsetHours: 99, preferredFormat: 'm3u8' });
    expect(saved).toMatchObject({ epgOffsetHours: 12, preferredFormat: 'm3u8', autoRefreshHours: 12 });
    expect(await storage.getMeta('settings')).toEqual(saved);
    const again = await service.saveSettings({ showClock: false });
    expect(again).toMatchObject({ epgOffsetHours: 12, preferredFormat: 'm3u8', showClock: false });
  });

  test('saving a synced setting that changed stamps its clock; device settings and unchanged values do not', async () => {
    await service.saveSettings({ epgOffsetHours: 2, subtitleLanguage: 'off' });
    await service.syncClock.idle();
    expect(await storage.listSyncMeta('#settings')).toEqual([]);
    await service.saveSettings({ subtitleLanguage: 'sv', preferredLanguages: ['sv'], showClock: false });
    await service.syncClock.idle();
    expect((await storage.listSyncMeta('#settings')).map((e) => e.key).sort()).toEqual(['st:preferredLanguages', 'st:subtitleLanguage']);
    await service.saveSettings({ audioLanguage: 'en' }, { stamp: false });
    await service.syncClock.idle();
    expect((await storage.listSyncMeta('#settings')).length).toBe(2);
  });

  test('autoRefreshHours drives needs*Refresh; 0 means never', async () => {
    const { source } = await service.addSource(m3uInput);
    await storage.setMeta(`playlistAt:${source.id}`, NOW - 7 * 3600_000);
    await storage.setMeta(`epgAt:${source.id}`, NOW - 7 * 3600_000);
    expect(await service.needsPlaylistRefresh(source.id)).toBe(false);
    await service.saveSettings({ autoRefreshHours: 6 });
    expect(await service.needsPlaylistRefresh(source.id)).toBe(true);
    expect(await service.needsEpgRefresh(source.id)).toBe(true);
    await service.saveSettings({ autoRefreshHours: 24 });
    expect(await service.needsPlaylistRefresh(source.id)).toBe(false);
    await storage.setMeta(`playlistAt:${source.id}`, 0);
    await storage.setMeta(`epgAt:${source.id}`, 0);
    await service.saveSettings({ autoRefreshHours: 0 });
    // An empty cache always refreshes, even with "never".
    expect(await service.needsPlaylistRefresh(source.id)).toBe(true);
    expect(await service.needsEpgRefresh(source.id)).toBe(true);
    await storage.setMeta(`playlistAt:${source.id}`, NOW - 1000 * 3600_000);
    await storage.setMeta(`epgAt:${source.id}`, NOW - 1000 * 3600_000);
    expect(await service.needsPlaylistRefresh(source.id)).toBe(false);
    expect(await service.needsEpgRefresh(source.id)).toBe(false);
  });

  test('needs*Refresh is true when the timestamps are missing, even for never', async () => {
    await service.saveSettings({ autoRefreshHours: 0 });
    expect(await service.needsPlaylistRefresh('nope')).toBe(true);
    expect(await service.needsEpgRefresh('nope')).toBe(true);
  });

  test('saveSettings ignores keys whose value is undefined', async () => {
    await service.saveSettings({ autoRefreshHours: 24, showClock: false });
    const saved = await service.saveSettings({ autoRefreshHours: undefined, showClock: undefined, preferredFormat: 'm3u8' });
    expect(saved).toMatchObject({ autoRefreshHours: 24, showClock: false, preferredFormat: 'm3u8' });
  });

  test('clearCachedData on an unknown id throws and writes nothing', async () => {
    const writes: string[] = [];
    const origSet = storage.setMeta.bind(storage);
    storage.setMeta = async (k: string, v: unknown) => { writes.push(k); return origSet(k, v); };
    const origReplace = storage.replaceChannels.bind(storage);
    storage.replaceChannels = async (...a: Parameters<typeof origReplace>) => { writes.push('replaceChannels'); return origReplace(...a); };
    await expect(service.clearCachedData('nope')).rejects.toThrow('Unknown source nope');
    expect(writes).toEqual([]);
  });

  test('clearCachedData empties channels, guide and coverage but keeps source and layout', async () => {
    const { source } = await service.addSource(m3uInput);
    await service.refreshEpg(source.id);
    await service.refreshEpg(source.id);
    const loaded = await service.loadIndex(source.id);
    const favId = loaded.slice('all', 0, 1)[0]!.id;
    await service.saveLayout(source.id, applyOps(loaded.layout(), [{ op: 'addToList', listId: 'fav', channelIds: [favId] }]).layout);
    await storage.setMeta(`epgStaging:${source.id}`, 7);
    await storage.addProgrammes(`${source.id}@7`, [{ epgId: 'ch1.test', start: 1, stop: 2, title: 'x' }]);

    await service.clearCachedData(source.id);

    expect((await service.listSources()).map((s) => s.id)).toEqual([source.id]);
    expect(await storage.getChannels(source.id)).toEqual([]);
    expect(await storage.getMeta(`playlistAt:${source.id}`)).toBe(0);
    expect(await storage.getMeta(`epgAt:${source.id}`)).toBe(0);
    expect(await storage.getMeta(`epgStaging:${source.id}`) ?? null).toBeNull();
    for (const key of [source.id, `${source.id}@1`, `${source.id}@2`, `${source.id}@7`]) {
      expect(await storage.getProgrammes(key, ['ch1.test', 'ch2.test'], ...WIDE)).toEqual([]);
    }
    expect((await service.loadLayout(source.id)).lists[0]!.channelIds).toEqual([favId]);
    expect(await service.loadEpgCoverage(source.id)).toBeUndefined();
    expect(await service.needsPlaylistRefresh(source.id)).toBe(true);
    expect(await service.needsEpgRefresh(source.id)).toBe(true);
    await service.refreshPlaylist(source.id);
    expect((await service.loadIndex(source.id)).groupSize('fav')).toBe(1);
  });

  test('a storage failure during EPG refresh surfaces unchanged and keeps the old guide', async () => {
    class FailingProgrammes extends MemoryStorage {
      fail = false;
      override async addProgrammes(id: string, batch: Parameters<MemoryStorage['addProgrammes']>[1]): Promise<void> {
        if (this.fail) throw new Error('quota exceeded');
        return super.addProgrammes(id, batch);
      }
    }
    const st = new FailingProgrammes();
    const svc = new SourceService({ shortEpgGapMs: 0, storage: st, fetch: fetchFn, now: () => NOW, newId: () => 'q1' });
    const { source } = await svc.addSource(m3uInput);
    await svc.refreshEpg(source.id);
    st.fail = true;
    const err = await svc.refreshEpg(source.id).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SourceNetworkError);
    expect((err as Error).message).toBe('quota exceeded');
    st.fail = false;
    const channels = (await svc.loadIndex(source.id)).slice('all', 0, 10);
    expect([...(await svc.programmesFor(source.id, channels, ...WIDE)).values()].flat()).toHaveLength(2);
  });

  test('stale staging equal to the live generation does not wipe the live guide', async () => {
    const { source } = await service.addSource(m3uInput);
    await service.refreshEpg(source.id);
    expect(await countAll(source.id)).toBe(2);
    // Simulate a crash between "set epgGen" and "clear epgStaging".
    await storage.setMeta(`epgStaging:${source.id}`, 1);
    routes['/epg.xml'] = () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.error(new Error('socket reset')); },
    }));
    await expect(service.refreshEpg(source.id)).rejects.toBeInstanceOf(SourceNetworkError);
    expect(await countAll(source.id)).toBe(2);
    routes['/epg.xml'] = () => new Response(xml);
    await service.refreshEpg(source.id);
    expect(await countAll(source.id)).toBe(2);
    expect(await storage.getMeta(`epgStaging:${source.id}`) ?? null).toBeNull();
  });

  test('refreshEpg without an EPG url clears leftover staging', async () => {
    const { source } = await service.addSource({ kind: 'm3u', name: 'No guide', playlistUrl: m3uInput.playlistUrl });
    await storage.setMeta(`epgStaging:${source.id}`, 3);
    await storage.addProgrammes(`${source.id}@3`, [{ epgId: 'ch1.test', start: 1, stop: 2, title: 'x' }]);
    await storage.setMeta(`epgCoverage:${source.id}`, ['ch1.test']);
    await service.refreshEpg(source.id);
    // No guide configured: coverage is unknown, so a no-EPG filter never hides everything.
    expect(await service.loadEpgCoverage(source.id)).toBeUndefined();
    expect(await storage.getMeta(`epgStaging:${source.id}`) ?? null).toBeNull();
    expect(await storage.getProgrammes(`${source.id}@3`, ['ch1.test'], ...WIDE)).toEqual([]);
  });

  test('service errors for auth, http and network failures contain no credentials or url', async () => {
    const x = { kind: 'xtream' as const, name: 'X', server: 'http://example.test', username: 'zed-user', password: 'zed-pass' };
    const cases: Array<() => Response> = [
      () => { throw new TypeError('fetch failed http://example.test/?username=zed-user&password=zed-pass'); },
      () => json({}, 401),
      () => json({}, 502),
    ];
    for (const c of cases) {
      routes['api:auth'] = c;
      const err = await service.addSource(x).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      for (const bad of ['zed-user', 'zed-pass', 'http']) expect((err as Error).message).not.toContain(bad);
    }
    routes['/p.m3u'] = () => { throw new TypeError('fetch failed http://example.test/p.m3u'); };
    const err = await service.addSource(m3uInput).catch((e: Error) => e);
    for (const bad of ['http']) expect((err as Error).message).not.toContain(bad);
  });
});

describe('SourceService – title index', () => {
  test('refreshEpg stores a title index for the new generation', async () => {
    const { source } = await service.addSource(m3uInput);
    await service.refreshEpg(source.id);
    const rec = await storage.getMeta<{ gen: number; truncated: boolean }>(`titleIndex:${source.id}`);
    expect(rec?.gen).toBe(await storage.getMeta(`epgGen:${source.id}`));
    expect(rec?.truncated).toBe(false);
    const data = (await service.titleIndexFor(source.id))!;
    expect(queryTitles(data, 'bulletin', NOW, 10).map((m) => m.display)).toEqual(['Evening Bulletin']);
    expect(queryTitles(data, 'atta', NOW, 10)[0]!.airings[0]!.epgKey).toBe('ch2.test');
  });

  test('a failed guide refresh keeps the previous index', async () => {
    const { source } = await service.addSource(m3uInput);
    await service.refreshEpg(source.id);
    const before = await storage.getMeta(`titleIndex:${source.id}`);
    routes['/epg.xml'] = () => new Response('<html>nope</html>', { status: 500 });
    await expect(service.refreshEpg(source.id)).rejects.toBeInstanceOf(SourceNetworkError);
    expect(await storage.getMeta(`titleIndex:${source.id}`)).toEqual(before);
    expect(await service.titleIndexFor(source.id)).toBeDefined();
  });

  test('a record from another generation or with a bad shape reads as missing', async () => {
    const { source } = await service.addSource(m3uInput);
    await service.refreshEpg(source.id);
    const rec = (await storage.getMeta<{ gen: number; data: unknown }>(`titleIndex:${source.id}`))!;
    await storage.setMeta(`titleIndex:${source.id}`, { ...rec, gen: rec.gen + 1 });
    expect(await service.titleIndexFor(source.id)).toBeUndefined();
    await storage.setMeta(`titleIndex:${source.id}`, { ...rec, data: { v: 1 } });
    expect(await service.titleIndexFor(source.id)).toBeUndefined();
  });

  test('clearCachedData and a guide-less refresh clear the index; deleteSource removes it', async () => {
    const { source } = await service.addSource(m3uInput);
    await service.refreshEpg(source.id);
    await service.clearCachedData(source.id);
    expect(await storage.getMeta(`titleIndex:${source.id}`)).toBeNull();

    await service.refreshEpg(source.id);
    const { epgUrl: _e, ...noGuide } = source as typeof source & { epgUrl?: string };
    await service.updateSource(noGuide);
    await service.refreshEpg(source.id);
    expect(await service.titleIndexFor(source.id)).toBeUndefined();

    await service.refreshEpg(source.id);
    await service.deleteSource(source.id);
    expect(await storage.getMeta(`titleIndex:${source.id}`)).toBeUndefined();
  });

  test('rebuildTitleIndex recreates the same index from stored programmes', async () => {
    const { source } = await service.addSource(m3uInput);
    await service.refreshEpg(source.id);
    const built = await service.titleIndexFor(source.id);
    await storage.setMeta(`titleIndex:${source.id}`, null);
    await service.rebuildTitleIndex(source.id);
    const rebuilt = (await service.titleIndexFor(source.id))!;
    expect(queryTitles(rebuilt, 'show', NOW, 10)).toEqual(queryTitles(built!, 'show', NOW, 10));
    expect(queryTitles(rebuilt, 'bulletin', NOW, 10)).toEqual(queryTitles(built!, 'bulletin', NOW, 10));
  });

  test('a title index write that throws does not abort the guide import', async () => {
    class FailingTitles extends MemoryStorage {
      override async setMeta(key: string, value: unknown): Promise<void> {
        if (key.startsWith('titleIndex:')) throw new Error('value too large');
        return super.setMeta(key, value);
      }
    }
    const st = new FailingTitles();
    const svc = new SourceService({ shortEpgGapMs: 0, storage: st, fetch: fetchFn, now: () => NOW, newId: () => 't1' });
    const { source } = await svc.addSource(m3uInput);
    const genBefore = await st.getMeta(`epgGen:${source.id}`);
    const r = await svc.refreshEpg(source.id);
    expect(r.programmes).toBeGreaterThan(0);
    const gen = await st.getMeta(`epgGen:${source.id}`);
    expect(typeof gen).toBe('number');
    expect(gen).not.toBe(genBefore);
    expect(await st.getMeta(`titleIndex:${source.id}`) ?? null).toBeNull();
    expect(await svc.titleIndexFor(source.id)).toBeUndefined();
    expect((await svc.programmesFor(source.id, (await svc.loadIndex(source.id)).slice('all', 0, 4), NOW - 86_400_000, NOW + 86_400_000)).size).toBe(4);
  });

  test('rebuildTitleIndex handles a legacy guide stored under the bare source id (no epgGen)', async () => {
    const { source } = await service.addSource({ kind: 'm3u', name: 'Legacy', playlistUrl: m3uInput.playlistUrl });
    expect(await storage.getMeta(`epgGen:${source.id}`)).toBeUndefined();
    await storage.addProgrammes(source.id, [
      { epgId: 'ch1.test', start: NOW - 600_000, stop: NOW + 1_200_000, title: 'Legacy Morning Show' },
    ]);
    expect(await service.titleIndexFor(source.id)).toBeUndefined();
    await service.rebuildTitleIndex(source.id);
    const rec = await storage.getMeta<{ gen: number }>(`titleIndex:${source.id}`);
    expect(rec?.gen).toBe(0);
    const data = (await service.titleIndexFor(source.id))!;
    expect(data).toBeDefined();
    expect(queryTitles(data, 'legacy', NOW, 10).map((m) => m.display)).toEqual(['Legacy Morning Show']);
  });

  test('rebuildTitleIndex is a no-op for a deleted source', async () => {
    const { source } = await service.addSource(m3uInput);
    await service.deleteSource(source.id);
    await service.rebuildTitleIndex(source.id);
    expect(await storage.getMeta(`titleIndex:${source.id}`)).toBeUndefined();
  });
});

describe('SourceService – m3u VOD split', () => {
  const vodM3u = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-chno="1" group-title="News",Channel 001',
    'http://example.test/live/u/p/1.ts',
    '#EXTINF:-1 group-title="Drama" tvg-logo="http://img.test/11.jpg",Synthetic Film 001 (2021)',
    'http://example.test/movie/u/p/11.mkv',
    '#EXTINF:-1 group-title="Shows",Synthetic Show S01E01',
    'http://example.test/series/u/p/101.mp4',
    '#EXTINF:-1 group-title="Shows",Synthetic Show S01E02',
    'http://example.test/series/u/p/102.mp4',
    '#EXTINF:-1 group-title="News",Channel 002',
    'http://example.test/live/u/p/2.ts',
  ].join('\n');
  const input = { kind: 'm3u' as const, name: 'Mine', playlistUrl: 'http://example.test/vod.m3u' };

  test('VOD entries leave the channel list and are stored as catalogues', async () => {
    routes['/vod.m3u'] = () => new Response(vodM3u);
    const { result } = await service.addSource(input);
    expect(result).toEqual({ channelCount: 2, skipped: 0, movieCount: 1, seriesCount: 1 });
    const idx = await service.loadIndex('id1');
    expect(idx.slice('all', 0, 10).map((c) => [c.name, c.number])).toEqual([['Channel 001', 1], ['Channel 002', 2]]);
    const movies = await storage.getVod('id1', 'movie');
    expect(movies?.items.map((m) => m.title)).toEqual(['Synthetic Film 001']);
    const series = await storage.getVod('id1', 'series');
    expect(Object.values(series!.episodes!)[0]).toHaveLength(2);
    expect(await storage.getMeta('vodAt:movie:id1')).toBe(NOW);
    expect(await storage.getMeta('vodAt:series:id1')).toBe(NOW);
  });

  test('a refresh replaces the catalogues', async () => {
    routes['/vod.m3u'] = () => new Response(vodM3u);
    await service.addSource(input);
    routes['/vod.m3u'] = () => new Response('#EXTM3U\n#EXTINF:-1,Channel 001\nhttp://example.test/live/u/p/1.ts\n');
    await service.refreshPlaylist('id1');
    expect((await storage.getVod('id1', 'movie'))?.items).toEqual([]);
  });

  test('updateSource to another playlist URL replaces the stored catalogues', async () => {
    routes['/vod.m3u'] = () => new Response(vodM3u);
    const { source } = await service.addSource(input);
    routes['/other.m3u'] = () => new Response('#EXTM3U\n#EXTINF:-1,Channel 001\nhttp://example.test/live/u/p/1.ts\n');
    await service.updateSource({ ...source, playlistUrl: 'http://example.test/other.m3u' } as typeof source);
    expect((await storage.getVod(source.id, 'movie'))?.items).toEqual([]);
    expect((await storage.getVod(source.id, 'series'))?.items).toEqual([]);
  });

  test('updateSource from M3U to Xtream clears the catalogues and their freshness', async () => {
    routes['/vod.m3u'] = () => new Response(vodM3u);
    const { source } = await service.addSource(input);
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
    routes['api:get_live_categories'] = () => json([{ category_id: '1', category_name: 'News' }]);
    routes['api:get_live_streams'] = () => json([{ stream_id: 1, name: 'Channel 1', category_id: '1', num: 1 }]);
    await service.updateSource({ id: source.id, kind: 'xtream', name: 'X', server: 'http://example.test', username: 'u', password: 'p' });
    for (const kind of ['movie', 'series'] as const) {
      expect((await storage.getVod(source.id, kind))?.items).toEqual([]);
      expect(await storage.getMeta(`vodAt:${kind}:${source.id}`)).toBe(0);
    }
  });

  test('updateSource from Xtream to M3U replaces the Xtream catalogues with the playlist ones', async () => {
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
    routes['api:get_live_categories'] = () => json([{ category_id: '1', category_name: 'News' }]);
    routes['api:get_live_streams'] = () => json([{ stream_id: 1, name: 'Channel 1', category_id: '1', num: 1 }]);
    const { source } = await service.addSource({ kind: 'xtream', name: 'X', server: 'http://example.test', username: 'u', password: 'p' });
    await storage.replaceVod(source.id, 'movie', { items: [{ id: `${source.id}:x1`, kind: 'movie', title: 'Synthetic Film 077', categoryId: '1' }], categories: [] });
    routes['/vod.m3u'] = () => new Response(vodM3u);
    await service.updateSource({ id: source.id, ...input });
    expect((await storage.getVod(source.id, 'movie'))?.items.map((m) => m.title)).toEqual(['Synthetic Film 001']);
  });

  test('a refresh of an M3U playlist that now holds only movies is stored', async () => {
    routes['/vod.m3u'] = () => new Response(vodM3u);
    await service.addSource(input);
    routes['/vod.m3u'] = () => new Response('#EXTM3U\n#EXTINF:-1,Synthetic Film 009\nhttp://example.test/movie/u/p/9.mp4\n');
    await expect(service.refreshPlaylist('id1')).resolves.toMatchObject({ channelCount: 0, movieCount: 1 });
    expect(await storage.getChannels('id1')).toEqual([]);
    expect((await storage.getVod('id1', 'movie'))?.items.map((m) => m.title)).toEqual(['Synthetic Film 009']);
  });

  test('a VOD-only playlist is accepted; an empty one is still rejected', async () => {
    routes['/vod.m3u'] = () => new Response('#EXTM3U\n#EXTINF:-1,Synthetic Film 009\nhttp://example.test/movie/u/p/9.mp4\n');
    const { result } = await service.addSource(input);
    expect(result).toEqual({ channelCount: 0, skipped: 0, movieCount: 1 });
    routes['/vod.m3u'] = () => new Response('#EXTM3U\n');
    await expect(service.addSource(input)).rejects.toThrow('The playlist contains no channels.');
  });
});

describe('SourceService – refusal cooldown', () => {
  const xInput = { kind: 'xtream' as const, name: 'X', server: 'http://example.test', username: 'u', password: 'p' };
  let calls: string[];
  const counting: FetchFn = async (url, init) => {
    calls.push(new URL(url).searchParams.get('action') ?? new URL(url).pathname);
    return fetchFn(url, init);
  };
  const addX = async (svc: SourceService) => {
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
    routes['api:get_live_categories'] = () => json([{ category_id: '1', category_name: 'News' }]);
    routes['api:get_live_streams'] = () => json([{ stream_id: 7, name: 'Channel 007', category_id: '1', num: 7 }]);
    const { source } = await svc.addSource(xInput);
    return { source, channels: (await svc.loadIndex(source.id)).slice('all', 0, 1) };
  };
  beforeEach(() => {
    calls = [];
    service = new SourceService({ storage, fetch: counting, now: () => NOW, newId: () => 'id1' });
  });

  test('a refused request blocks the next one without sending it, across a restart', async () => {
    const { source } = await addX(service);
    routes['api:auth'] = () => new Response('', { status: 403 });
    await expect(service.refreshPlaylist(source.id)).rejects.toBeInstanceOf(SourceAuthError);
    expect(service.guard.isBlocked(source.id)).toBe(true);
    calls = [];
    await expect(service.refreshPlaylist(source.id)).rejects.toBeInstanceOf(SourceRefusedError);
    await expect(service.refreshEpg(source.id)).rejects.toBeInstanceOf(SourceRefusedError);
    const again = new SourceService({ storage, fetch: counting, now: () => NOW });
    await expect(again.refreshPlaylist(source.id)).rejects.toBeInstanceOf(SourceRefusedError);
    expect(calls).toEqual([]);
  });

  test('short EPG sends nothing while blocked', async () => {
    const { source, channels } = await addX(service);
    routes['api:get_short_epg'] = () => json({ epg_listings: [] });
    await service.guard.report(source.id, 'refused');
    calls = [];
    expect((await service.shortEpgFor(source.id, channels)).size).toBe(0);
    expect(calls).toEqual([]);
  });

  test('short EPG refused locally while a probe runs is skipped, not answered as nothing found', async () => {
    const { source, channels } = await addX(service);
    routes['api:get_short_epg'] = () => json({ epg_listings: [] });
    await service.guard.report(source.id, 'refused');
    await service.guard.retry(source.id); // the next request is the one probe
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    routes['api:auth'] = async () => { await gate; return json({ user_info: { auth: 1, status: 'Active' } }); };
    const probe = service.refreshPlaylist(source.id).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    calls = [];
    const found = await service.shortEpgFor(source.id, channels);
    expect(calls).toEqual([]); // nothing reached the source
    expect(found.has(channels[0]!.id)).toBe(false); // skipped: not cached as nothing found
    release();
    await probe;
  });

  test('a 429 on the guide download counts as a refusal', async () => {
    const m = await service.addSource(m3uInput);
    routes['/epg.xml'] = () => new Response('', { status: 429 });
    await expect(service.refreshEpg(m.source.id)).rejects.toBeInstanceOf(SourceNetworkError);
    expect(service.guard.isBlocked(m.source.id)).toBe(true);
  });

  test('deleteSource forgets the record', async () => {
    const { source } = await addX(service);
    await service.guard.report(source.id, 'refused');
    await service.deleteSource(source.id);
    expect(await storage.getMeta(`refusal:${source.id}`)).toBeNull();
  });
});

describe('SourceService – source HTTP settings and account limit', () => {
  const xInput = { kind: 'xtream' as const, name: 'X', server: 'http://example.test', username: 'u', password: 'p' };
  const xRoutes = (info: Record<string, unknown>) => {
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active', ...info } });
    routes['api:get_live_categories'] = () => json([{ category_id: '1', category_name: 'News' }]);
    routes['api:get_live_streams'] = () => json([{ stream_id: 1, name: 'Channel 1', category_id: '1', num: 1 }]);
  };

  test('an Xtream login and refresh store max_connections and active_cons with the source', async () => {
    xRoutes({ max_connections: '2', active_cons: '0' });
    const { source } = await service.addSource(xInput);
    expect(source).toMatchObject({ maxConnections: 2, activeConnections: 0 });
    expect((await service.listSources())[0]).toMatchObject({ maxConnections: 2, activeConnections: 0 });
    xRoutes({ max_connections: '3', active_cons: '1' });
    await service.refreshPlaylist(source.id);
    expect((await service.listSources())[0]).toMatchObject({ maxConnections: 3, activeConnections: 1 });
    xRoutes({});
    await service.updateSource({ ...source, name: 'Renamed' });
    const [stored] = await service.listSources();
    expect(stored).toMatchObject({ name: 'Renamed' });
    expect(stored && 'maxConnections' in stored).toBe(false);
    expect(stored && 'activeConnections' in stored).toBe(false);
  });

  test('add and update keep userAgent and referrer trimmed, at most 512 chars, and drop empty ones', async () => {
    const { source } = await service.addSource({ ...m3uInput, userAgent: '  SyntheticAgent/1.0  ', referrer: '   ' });
    expect(source).toEqual({ ...m3uInput, id: 'id1', userAgent: 'SyntheticAgent/1.0' });
    expect((await service.listSources())[0]).toEqual({ ...m3uInput, id: 'id1', userAgent: 'SyntheticAgent/1.0' });
    await service.updateSource({ ...source, userAgent: 'a'.repeat(600), referrer: ' http://example.test/ ' });
    const [stored] = await service.listSources();
    expect(stored?.userAgent).toHaveLength(512);
    expect(stored?.referrer).toBe('http://example.test/');
    await service.updateSource({ ...source, userAgent: '', referrer: 7 as unknown as string });
    const [cleared] = await service.listSources();
    expect(cleared && ('userAgent' in cleared || 'referrer' in cleared)).toBe(false);
  });

  test('a playlist header is stored on the channel', async () => {
    routes['/p.m3u'] = () => new Response('#EXTM3U\n#EXTINF:-1,Channel 1\n#EXTVLCOPT:http-user-agent=SyntheticAgent/1.0\nhttp://example.test/live/1.ts|Referer=http://example.test/\n');
    const { source } = await service.addSource(m3uInput);
    const [c] = await storage.getChannels(source.id);
    expect(c).toMatchObject({ url: 'http://example.test/live/1.ts', headers: { userAgent: 'SyntheticAgent/1.0', referrer: 'http://example.test/' } });
  });
});

describe('SourceService – refresh backoff', () => {
  const MIN = 60_000;
  const auto = { automatic: true };
  let t: number;
  let svc: SourceService;
  beforeEach(() => {
    t = NOW;
    svc = new SourceService({ shortEpgGapMs: 0, storage, fetch: fetchFn, now: () => t, newId: () => 'b1' });
  });
  /** Adds the M3U source with its guide, then moves the clock past the 12 h auto refresh so both are stale. */
  const staleSource = async () => {
    const { source } = await svc.addSource(m3uInput);
    await svc.refreshEpg(source.id);
    t += 13 * 3600_000;
    return source.id;
  };

  test('a failed playlist refresh waits 15 min, 1 h, then 6 h (capped) before the next automatic one', async () => {
    const id = await staleSource();
    routes['/p.m3u'] = () => new Response('down', { status: 500 });
    const steps = [15 * MIN, 60 * MIN, 360 * MIN, 360 * MIN];
    for (const [i, wait] of steps.entries()) {
      await expect(svc.refreshPlaylist(id, undefined, auto)).rejects.toBeInstanceOf(SourceNetworkError);
      expect(await storage.getMeta(`refreshFail:${id}:playlist`)).toEqual({ count: i + 1, at: t });
      expect(await svc.needsPlaylistRefresh(id)).toBe(false);
      t += wait - 1;
      expect(await svc.needsPlaylistRefresh(id)).toBe(false);
      t += 1;
      expect(await svc.needsPlaylistRefresh(id)).toBe(true);
    }
    // The guide has its own record.
    expect(await svc.needsEpgRefresh(id)).toBe(true);
  });

  test('a success clears the record', async () => {
    const id = await staleSource();
    routes['/p.m3u'] = () => new Response('down', { status: 500 });
    await expect(svc.refreshPlaylist(id, undefined, auto)).rejects.toThrow();
    routes['/p.m3u'] = () => new Response(m3u);
    await svc.refreshPlaylist(id);
    expect(await storage.getMeta(`refreshFail:${id}:playlist`)).toBeFalsy();
  });

  test('a manual refresh always runs, even while backed off', async () => {
    const id = await staleSource();
    routes['/p.m3u'] = () => new Response('down', { status: 500 });
    await expect(svc.refreshPlaylist(id, undefined, auto)).rejects.toThrow();
    routes['/p.m3u'] = () => new Response(m3u);
    await expect(svc.refreshPlaylist(id)).resolves.toMatchObject({ channelCount: 4 });
  });

  test('a refusal is left to the refusal guard: no backoff record', async () => {
    const id = await staleSource();
    for (const status of [403, 429, 503]) {
      routes['/p.m3u'] = () => new Response('no', { status });
      await expect(svc.refreshPlaylist(id, undefined, auto)).rejects.toThrow();
      await svc.guard.forget(id);
    }
    expect(await storage.getMeta(`refreshFail:${id}:playlist`)).toBeFalsy();
    expect(await svc.needsPlaylistRefresh(id)).toBe(true);
  });

  test('a login refused (SourceAuthError) or a request the guard blocked records nothing', async () => {
    const id = await staleSource();
    routes['/p.m3u'] = () => new Response('no', { status: 401 });
    await expect(svc.refreshPlaylist(id, undefined, auto)).rejects.toBeInstanceOf(SourceAuthError);
    await svc.guard.forget(id);
    await svc.guard.report(id, 'refused');
    await expect(svc.refreshPlaylist(id, undefined, auto)).rejects.toBeInstanceOf(SourceRefusedError);
    await expect(svc.refreshEpg(id, undefined, auto)).rejects.toBeInstanceOf(SourceRefusedError);
    expect(await storage.getMeta(`refreshFail:${id}:playlist`)).toBeFalsy();
    expect(await storage.getMeta(`refreshFail:${id}:epg`)).toBeFalsy();
  });

  test('a failed manual refresh records nothing', async () => {
    const id = await staleSource();
    routes['/p.m3u'] = () => new Response('down', { status: 500 });
    routes['/epg.xml'] = () => new Response('down', { status: 500 });
    await expect(svc.refreshPlaylist(id)).rejects.toBeInstanceOf(SourceNetworkError);
    await expect(svc.refreshEpg(id)).rejects.toBeInstanceOf(SourceNetworkError);
    expect(await storage.getMeta(`refreshFail:${id}:playlist`)).toBeFalsy();
    expect(await storage.getMeta(`refreshFail:${id}:epg`)).toBeFalsy();
  });

  test('updateSource clears every record of the source', async () => {
    const id = await staleSource();
    for (const what of ['playlist', 'epg', 'vod:movie', 'vod:series']) {
      await storage.setMeta(`refreshFail:${id}:${what}`, { count: 2, at: t });
    }
    const source = (await svc.listSources()).find((s) => s.id === id)!;
    await svc.updateSource({ ...source, name: 'Renamed' });
    for (const what of ['playlist', 'epg', 'vod:movie', 'vod:series']) {
      expect(await storage.getMeta(`refreshFail:${id}:${what}`)).toBeFalsy();
    }
  });

  test('a failed guide refresh is backed off on its own', async () => {
    const id = await staleSource();
    routes['/epg.xml'] = () => new Response('down', { status: 502 });
    await expect(svc.refreshEpg(id, undefined, auto)).rejects.toBeInstanceOf(SourceNetworkError);
    expect(await storage.getMeta(`refreshFail:${id}:epg`)).toEqual({ count: 1, at: t });
    expect(await svc.needsEpgRefresh(id)).toBe(false);
    expect(await svc.needsPlaylistRefresh(id)).toBe(true);
    t += 15 * MIN;
    expect(await svc.needsEpgRefresh(id)).toBe(true);
    routes['/epg.xml'] = () => new Response(xml);
    await svc.refreshEpg(id);
    expect(await storage.getMeta(`refreshFail:${id}:epg`)).toBeFalsy();
  });

  test('deleting the source removes its records', async () => {
    const id = await staleSource();
    routes['/p.m3u'] = () => new Response('down', { status: 500 });
    await expect(svc.refreshPlaylist(id, undefined, auto)).rejects.toThrow();
    await storage.setMeta(`refreshFail:${id}:vod:movie`, { count: 1, at: t });
    await svc.deleteSource(id);
    for (const what of ['playlist', 'epg', 'vod:movie', 'vod:series']) {
      expect(await storage.getMeta(`refreshFail:${id}:${what}`)).toBeFalsy();
    }
  });
});

describe('SourceService – sports index', () => {
  const sportsXml = (start: string, stop: string) => '<tv><channel id="ch1.test"><display-name>Channel 001</display-name></channel>'
    + `<programme start="${start}" stop="${stop}" channel="ch1.test"><title>Northbridge FC v Eastport</title><category>Sports</category></programme>`
    + `<programme start="${start}" stop="${stop}" channel="ch2.test"><title>Evening Bulletin</title></programme></tv>`;

  test('refreshEpg stores sports candidates for the new generation', async () => {
    routes['/epg.xml'] = () => new Response(sportsXml('20261013170000 +0000', '20261013190000 +0000'));
    const { source } = await service.addSource(m3uInput);
    await service.refreshEpg(source.id);
    const rec = (await service.sportsIndexFor(source.id))!;
    expect(rec.gen).toBe(await storage.getMeta(`epgGen:${source.id}`));
    expect(rec.candidates.map((c) => [c.epgKey, c.title])).toEqual([['ch1.test', 'Northbridge FC v Eastport']]);
  });

  test('a throwing sports scorer never fails the guide import and leaves no sports record', async () => {
    routes['/epg.xml'] = () => new Response(sportsXml('20261013170000 +0000', '20261013190000 +0000'));
    const { source } = await service.addSource(m3uInput);
    detectFlags.throwOnScore = true;
    try {
      await expect(service.refreshEpg(source.id)).resolves.toMatchObject({ programmes: 2 });
    } finally {
      detectFlags.throwOnScore = false;
    }
    expect(await service.sportsIndexFor(source.id)).toBeUndefined();
    expect(await storage.getMeta(`sportsIndex:${source.id}`)).toBeNull();
  });

  test('a record from another generation reads as missing; clearing the guide clears it', async () => {
    const { source } = await service.addSource(m3uInput);
    await service.refreshEpg(source.id);
    const rec = (await storage.getMeta<{ gen: number }>(`sportsIndex:${source.id}`))!;
    await storage.setMeta(`sportsIndex:${source.id}`, { ...rec, gen: rec.gen + 1 });
    expect(await service.sportsIndexFor(source.id)).toBeUndefined();
    await service.clearCachedData(source.id);
    expect(await storage.getMeta(`sportsIndex:${source.id}`)).toBeNull();
  });
});

describe('SourceService – source headers on list requests (spec 2026-10-20-source-headers §4.2)', () => {
  const xInput = { kind: 'xtream' as const, name: 'X', server: 'http://example.test', username: 'u', password: 'p' };
  const HEADERS = { userAgent: 'SyntheticAgent/1.0', referrer: 'http://ref.example.test/' };
  let seen: { url: string; init: Parameters<FetchFn>[1] }[];

  beforeEach(() => {
    seen = [];
    let n = 0;
    const recording: FetchFn = async (url, init) => {
      seen.push({ url, init });
      return fetchFn(url, init);
    };
    service = new SourceService({ shortEpgGapMs: 0, storage, fetch: recording, now: () => NOW, newId: () => `id${++n}` });
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
    routes['api:get_live_categories'] = () => json([{ category_id: '1', category_name: 'News' }]);
    routes['api:get_live_streams'] = () => json([{ stream_id: 1, name: 'Channel 1', category_id: '1', epg_channel_id: 'c1' }]);
    routes['/xmltv.php'] = () => new Response(xml);
  });

  test('the M3U playlist and XMLTV requests carry the source headers', async () => {
    const { source } = await service.addSource({ ...m3uInput, ...HEADERS });
    await service.refreshEpg(source.id);
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual(['/p.m3u', '/epg.xml']);
    for (const s of seen) expect(s.init?.sourceHeaders).toEqual(HEADERS);
  });

  test('every player_api call and the Xtream XMLTV carry the source headers', async () => {
    const { source } = await service.addSource({ ...xInput, userAgent: HEADERS.userAgent });
    await service.refreshEpg(source.id);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    for (const s of seen) expect(s.init?.sourceHeaders).toEqual({ userAgent: HEADERS.userAgent });
  });

  test('per-channel playlist headers never reach list requests', async () => {
    routes['/p.m3u'] = () => new Response('#EXTM3U\n#EXTINF:-1,Channel 1\n#EXTVLCOPT:http-user-agent=ChannelAgent/1.0\nhttp://example.test/live/1.ts\n');
    const { source } = await service.addSource(m3uInput);
    await service.refreshPlaylist(source.id);
    for (const s of seen) expect(s.init?.sourceHeaders).toBeUndefined();
  });

  test('a source without headers sends exactly today\'s requests: same URLs, no sourceHeaders field', async () => {
    const { source } = await service.addSource(m3uInput);
    await service.refreshEpg(source.id);
    expect(seen.map((s) => s.url)).toEqual(['http://example.test/p.m3u', 'http://example.test/epg.xml']);
    for (const s of seen) expect(s.init && 'sourceHeaders' in s.init).toBe(false);
  });
});

describe('catchupBackLimits: the catch-up channels share a history budget', () => {
  const H = 3_600_000;
  const chans = (n: number, every: number, days = 7): Channel[] => Array.from({ length: n }, (_, i) => ({
    id: `s:${i}`, sourceId: 's', name: `C${i}`, url: `http://s.test/${i}.ts`, epgId: `c${i}`, group: 'G', number: i + 1,
    ...(i % every === 0 ? { cu: { mode: 'xc' as const, days } } : {}),
  }));

  test('a few catch-up channels keep their archive days, capped at 7', () => {
    const back = catchupBackLimits(chans(100, 10, 3));
    expect(back.get('c0')).toBe(3 * 24 * H);
    expect(back.get('c1')).toBeUndefined();
    expect(catchupBackLimits(chans(100, 10, 30)).get('c0')).toBe(CATCHUP_GUIDE_DAYS * 24 * H);
  });

  test('when every channel has catch-up, each keeps 6 h + 30 h of history; at half, 6 h + 60 h', () => {
    expect(catchupBackLimits(chans(100, 1)).get('c0')).toBe(36 * H);
    expect(catchupBackLimits(chans(100, 2)).get('c0')).toBe(66 * H);
    expect(catchupBackLimits(chans(100, 1)).get('c0')).toBe(EPG_BACK_MS + CATCHUP_HISTORY_BUDGET_MS);
  });

  test('no catch-up channels: no limits', () => {
    expect(catchupBackLimits(chans(10, 1000).map(({ cu: _c, ...c }) => c)).size).toBe(0);
  });
});
