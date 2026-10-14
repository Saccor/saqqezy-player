import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryStorage } from '../../storage/src/memoryStorage.ts';
import { SourceService } from '../src/service/sourceService.ts';
import { SourceAuthError, SourceNetworkError } from '../src/errors.ts';
import { applyOps, emptyLayout } from '../src/layout/index.ts';
import type { FetchFn } from '../src/types.ts';

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
  service = new SourceService({ storage, fetch: fetchFn, now: () => NOW, newId: () => `id${++n}` });
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
    expect(await storage.getMeta(key)).toBeUndefined();
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
    const svc = new SourceService({ storage: failing, fetch: fetchFn, now: () => NOW, newId: () => 'bad1' });
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
    const svc = new SourceService({ storage, fetch: recording, now: () => NOW, newId: () => 't1' });
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
    const svc = new SourceService({ storage, fetch: fetchFn, now: () => NOW, bodyIdleMs: 30 });
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
    const svc = new SourceService({ storage, fetch: fetchFn, now: () => NOW, bodyIdleMs: 30 });
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

  test('shortEpgFor caps concurrent requests across calls', async () => {
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
    expect(peak).toBe(6);
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
    const { source, channels } = await addX(32);
    const h = holdShortEpg();
    const svc = new SourceService({ storage, fetch: shortRoute(h), now: () => NOW });
    // 6 run, 24 may wait: the 31st and 32nd push out the two oldest waiters (streams 7 and 8).
    const done = svc.shortEpgFor(source.id, channels);
    await new Promise((r) => setTimeout(r, 5));
    expect(h.seen.map((s) => s.stream)).toEqual([1, 2, 3, 4, 5, 6]);
    h.open();
    const found = await done;
    expect(h.seen.map((s) => s.stream).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 32 }, (_, i) => i + 1).filter((n) => n !== 7 && n !== 8));
    expect(found.size).toBe(30);
  });

  test('shortEpgFor sends no request for a lookup that is stale when its turn comes', async () => {
    const { source, channels } = await addX(8);
    const h = holdShortEpg();
    const svc = new SourceService({ storage, fetch: shortRoute(h), now: () => NOW });
    let stale = false;
    const done = svc.shortEpgFor(source.id, channels, { isStale: () => stale });
    await new Promise((r) => setTimeout(r, 5));
    expect(h.seen).toHaveLength(6);
    stale = true;
    h.open();
    expect((await done).size).toBe(6);
    expect(h.seen).toHaveLength(6);
    expect((await svc.shortEpgFor(source.id, channels, { isStale: () => true })).size).toBe(0);
    expect(h.seen).toHaveLength(6);
  });

  test('shortEpgFor uses the stored source config at request time', async () => {
    const { source, channels } = await addX(7);
    const h = holdShortEpg();
    const svc = new SourceService({ storage, fetch: shortRoute(h), now: () => NOW });
    const done = svc.shortEpgFor(source.id, channels);
    await new Promise((r) => setTimeout(r, 5));
    await storage.putSource({ ...source, username: 'renamed' } as typeof source);
    h.open();
    await done;
    expect(h.seen.map((s) => s.user)).toEqual(['u', 'u', 'u', 'u', 'u', 'u', 'renamed']);
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

  const stalledJson = (head: string) => () => new Response(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode(head)); },
    pull: () => new Promise<void>(() => {}),
  }));

  test('a stalled get_live_streams body fails on add and refresh and releases the source lock', async () => {
    const svc = new SourceService({ storage, fetch: fetchFn, now: () => NOW, bodyIdleMs: 30, newId: () => 'sx' });
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
    const svc = new SourceService({ storage, fetch: fetchFn, now: () => NOW, bodyIdleMs: 30 });
    routes['api:get_short_epg'] = stalledJson('{"epg_listings":[');
    expect((await svc.shortEpgFor(source.id, channels.slice(0, 6))).size).toBe(0);
    routes['api:get_short_epg'] = () => json({ epg_listings: [] });
    expect((await svc.shortEpgFor(source.id, channels.slice(6))).size).toBe(1);
  });

  test('an account with no live streams fails on add and on refresh, like an empty playlist', async () => {
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
    routes['api:get_live_categories'] = () => json([]);
    routes['api:get_live_streams'] = () => json([]);
    const err = await service.addSource(xInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceNetworkError);
    expect((err as Error).message).toBe('The account has no live channels.');
    expect(await service.listSources()).toEqual([]);
    routes['api:get_live_streams'] = () => json([{ stream_id: 1, name: 'Channel 1' }]);
    const { source } = await service.addSource(xInput);
    routes['api:get_live_streams'] = () => json([]);
    await expect(service.refreshPlaylist(source.id)).rejects.toThrow('The account has no live channels.');
    expect((await service.loadIndex(source.id)).groupSize('all')).toBe(1);
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
    });
    const saved = await service.saveSettings({ epgOffsetHours: 99, preferredFormat: 'm3u8' });
    expect(saved).toMatchObject({ epgOffsetHours: 12, preferredFormat: 'm3u8', autoRefreshHours: 12 });
    expect(await storage.getMeta('settings')).toEqual(saved);
    const again = await service.saveSettings({ showClock: false });
    expect(again).toMatchObject({ epgOffsetHours: 12, preferredFormat: 'm3u8', showClock: false });
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
    const svc = new SourceService({ storage: st, fetch: fetchFn, now: () => NOW, newId: () => 'q1' });
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
