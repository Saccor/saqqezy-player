import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  MAX_OPS_PER_BATCH, OpenSubtitlesClient, RefusalGuard, SourceService, SourceAuthError, SourceNetworkError, SourceRefusedError, SubtitleService, VodService, unreachableError, type Channel, type FetchFn, type LayoutOp, type Programme,
} from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { startFakeXtream } from '@iptv/fake-xtream';
import { APP_API_METHODS, AppApi, LIVE_AUDIO_MAX, MOVIE_HASH_RETRY_MS, SUBTITLE_SEARCH_PAGE_SIZE, scrub, sourceSubtitleName } from '../src/appApi.ts';
import { worseCooldown } from '../src/index.ts';
import { VodController } from '../src/vodController.ts';
import type { AppEvent } from '../src/types.ts';

const NOW = Date.UTC(2026, 9, 13, 18, 10);
let server: Awaited<ReturnType<typeof startFakeXtream>>;
beforeAll(async () => { server = await startFakeXtream({ port: 0, channels: 40, now: () => NOW }); });
afterAll(async () => { await server.close(); });

/** Every AppApi created by a test; afterEach waits until their background work has finished. */
const live: AppApi[] = [];
afterEach(async () => { await Promise.all(live.splice(0).map((a) => a.idle())); });

let storage: MemoryStorage;
beforeEach(() => { storage = new MemoryStorage(); });

const make = (st: MemoryStorage = storage, Svc: typeof SourceService = SourceService, fetchFn: FetchFn = (u, i) => fetch(u, i)) => {
  const events: AppEvent[] = [];
  const service = new Svc({ storage: st, fetch: fetchFn, now: () => NOW, shortEpgGapMs: 0 });
  const api = new AppApi({ service, storage: st, emit: (e) => events.push(e), now: () => NOW, appVersion: '1.2.3' });
  live.push(api);
  return { api, events };
};

const makeVod = (st: MemoryStorage = storage, fetchFn: FetchFn = (u, i) => fetch(u, i)) => {
  const events: AppEvent[] = [];
  const deps = { storage: st, fetch: fetchFn, now: () => NOW };
  const service = new SourceService(deps);
  const vod = new VodService(deps);
  const api = new AppApi({ service, storage: st, vod, emit: (e) => events.push(e), now: () => NOW, appVersion: '1.2.3' });
  live.push(api);
  return { api, events, vod };
};
const xt = (username = 'test', password = 'test') =>
  ({ kind: 'xtream' as const, name: 'Fake', server: server.url, username, password });
const settle = () => new Promise((r) => setTimeout(r, 50));
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => { open = r; });
  return { p, open };
};
/** Runs one search and waits for the title index load it starts, so later searches have programme hits. */
const warm = async (api: AppApi) => {
  await api.search('x', 1);
  await api.idle();
};
/** A SourceService whose `titleIndexFor` waits for `open()` and counts its calls. */
const deferredTitles = () => {
  const g = gate();
  const state = { calls: 0 };
  class Deferred extends SourceService {
    override async titleIndexFor(id: string) {
      state.calls++;
      await g.p;
      return super.titleIndexFor(id);
    }
  }
  return { Svc: Deferred, open: g.open, state };
};
/** A source that has finished its own post-add background refresh. */
const seeded = async (st: MemoryStorage = storage) => {
  const { api } = make(st);
  const { sourceId } = await api.addSource(xt());
  await api.idle();
  return { seed: api, sourceId };
};

describe('AppApi', () => {
  test('init with no sources', async () => {
    const s = await make().api.init();
    expect(s.sources).toEqual([]);
    expect(s.activeSourceId).toBeUndefined();
    expect(s.groups).toEqual([]);
    expect(s.settings.preferredFormat).toBe('ts');
  });

  test('add xtream source, browse, playable, neighbour wrap-around', async () => {
    const { api } = make();
    const { sourceId, channelCount } = await api.addSource(xt());
    expect(channelCount).toBe(40);
    const groups = await api.getGroups();
    expect(groups.map((g) => g.name)).toEqual(['Favourites', 'All channels', 'News', 'Movies', 'Kids', 'Music']);
    await api.refresh('epg');
    const slice = await api.getChannelSlice('all', 0, 5);
    expect(slice.total).toBe(40);
    expect(slice.rows).toHaveLength(5);
    expect(slice.rows[0]!.now?.title).toMatch(/^Programme /);
    expect(slice.rows[0]!.next).toBeDefined();
    expect((await api.listSources())[0]).toEqual({ id: sourceId, name: 'Fake', kind: 'xtream', active: true });

    const p = (await api.getPlayable(slice.rows[0]!.id))!;
    expect(p.url).toMatch(/\.ts$/);
    expect(p.alternateUrl).toMatch(/\.m3u8$/);
    const last = (await api.getChannelSlice('all', 39, 1)).rows[0]!;
    const wrapped = (await api.neighbour('all', last.id, 1))!;
    expect(wrapped.id).toBe(slice.rows[0]!.id);
    expect((await api.neighbour('all', slice.rows[0]!.id, -1))!.id).toBe(last.id);
    expect((await api.byNumber(slice.rows[0]!.number))!.id).toBe(slice.rows[0]!.id);
    expect(await api.byNumber(9999)).toBeUndefined();
  });

  test('rows never start a short-EPG lookup; getPlayable starts one without waiting, answered as nowNextUpdated', async () => {
    const g = gate();
    let shortCalls = 0;
    const gated: FetchFn = async (u, i) => {
      // No stored guide at all, so every channel needs the short-EPG fallback.
      if (u.includes('/xmltv.php')) return new Response('', { status: 500 });
      if (u.includes('action=get_short_epg')) { shortCalls++; await g.p; }
      return fetch(u, i);
    };
    const { api, events } = make(storage, SourceService, gated);
    await api.addSource(xt());
    await api.idle().catch(() => undefined);
    const slice = await api.getChannelSlice('all', 0, 3);
    await settle();
    expect(shortCalls).toBe(0);
    expect(slice.rows[0]!.now).toBeUndefined();
    const p = await api.getPlayable(slice.rows[0]!.id);
    expect(p?.now).toBeUndefined();
    await settle();
    expect(shortCalls).toBe(1);
    g.open();
    await api.idle();
    const updated = events.filter((e): e is Extract<AppEvent, { type: 'nowNextUpdated' }> => e.type === 'nowNextUpdated');
    expect(updated.flatMap((e) => e.channelIds)).toEqual([slice.rows[0]!.id]);
    const again = await api.getChannelSlice('all', 0, 3);
    expect(again.rows[0]!.now?.title).toMatch(/^Programme /);
    expect(again.rows[1]!.now).toBeUndefined();
    expect((await api.getPlayable(slice.rows[0]!.id))?.next).toBeDefined();
  });

  test('a slow guide read never holds the rows: names now, now/next later as nowNextUpdated', async () => {
    const { seed } = await seeded();
    await seed.refresh('epg');
    await seed.idle();
    const g = gate();
    const state = { held: true, reads: 0 };
    class SlowGuide extends SourceService {
      override async programmesFor(...args: Parameters<SourceService['programmesFor']>) {
        state.reads++;
        if (state.held) await g.p;
        return super.programmesFor(...args);
      }
    }
    const events: AppEvent[] = [];
    const service = new SlowGuide({ storage, fetch: (u, i) => fetch(u, i), now: () => NOW, shortEpgGapMs: 0 });
    const api = new AppApi({ service, storage, emit: (e) => events.push(e), now: () => NOW, appVersion: '1.2.3', nowNextWaitMs: 20 });
    live.push(api);
    await api.init();
    const slice = await api.getChannelSlice('all', 0, 3);
    expect(slice.total).toBe(40);
    expect(slice.rows.map((r) => r.name)).toHaveLength(3);
    expect(slice.rows[0]!.now).toBeUndefined();
    // Rows asked again while the first read still waits: answered at once, without a second guide read.
    const before = state.reads;
    await api.getChannelSlice('all', 0, 3);
    expect(state.reads).toBe(before);
    state.held = false;
    g.open();
    await api.idle();
    const updated = events.filter((e): e is Extract<AppEvent, { type: 'nowNextUpdated' }> => e.type === 'nowNextUpdated');
    expect(updated.flatMap((e) => e.channelIds)).toEqual(slice.rows.map((r) => r.id));
    const again = await api.getChannelSlice('all', 0, 3);
    expect(again.rows[0]!.now?.title).toMatch(/^Programme /);
  });

  test('preferredFormat m3u8 swaps url and alternateUrl', async () => {
    const { api } = make();
    await api.addSource(xt());
    await api.saveSettings({ preferredFormat: 'm3u8' });
    const id = (await api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    const p = (await api.getPlayable(id))!;
    expect(p.url).toMatch(/\.m3u8$/);
    expect(p.alternateUrl).toMatch(/\.ts$/);
  });

  test('favourites show in fav group and survive a new instance', async () => {
    const { api } = make();
    await api.addSource(xt());
    const id = (await api.getChannelSlice('all', 2, 1)).rows[0]!.id;
    expect(await api.toggleFavourite(id)).toBe(true);
    const fav = await api.getChannelSlice('fav', 0, 10);
    expect(fav.rows.map((r) => r.id)).toEqual([id]);
    expect(fav.rows[0]!.favourite).toBe(true);
    await api.idle();

    const { api: again } = make();
    const state = await again.init();
    expect(state.groups.find((g) => g.id === 'fav')?.count).toBe(1);
    expect(await again.toggleFavourite(id)).toBe(false);
  });

  test('indexOf finds a channel position in a group (-1 when absent)', async () => {
    const { api } = make();
    await api.addSource(xt());
    const row = (await api.getChannelSlice('all', 7, 1)).rows[0]!;
    expect(await api.indexOf('all', row.id)).toBe(7);
    expect(await api.indexOf('fav', row.id)).toBe(-1);
    expect(await api.indexOf('all', 'nope')).toBe(-1);
  });

  test('indexOf skips hidden channels: later positions shift up and the hidden one is -1', async () => {
    const { api } = make();
    await api.addSource(xt());
    const rows = (await api.getChannelSlice('all', 0, 10)).rows;
    const hidden = rows[3]!.id;
    const later = rows[7]!.id;
    expect(await api.indexOf('all', later)).toBe(7);
    await api.toggleHidden(hidden);
    expect(await api.indexOf('all', hidden)).toBe(-1);
    expect(await api.indexOf('all', later)).toBe(6);
    expect(await api.indexOf('all', rows[2]!.id)).toBe(2);
    await api.toggleHidden(hidden);
    expect(await api.indexOf('all', later)).toBe(7);
  });

  test('hidden channels', async () => {
    const { api } = make();
    await api.addSource(xt());
    const id = (await api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    expect(await api.toggleHidden(id)).toBe(true);
    expect((await api.getChannelSlice('all', 0, 100)).total).toBe(39);
    expect((await api.hiddenChannels()).map((r) => r.id)).toEqual([id]);
    expect(await api.toggleHidden(id)).toBe(false);
  });

  describe('guideStatus', () => {
    const playlist = ['#EXTM3U', '#EXTINF:-1 group-title="News",Channel 001', 'http://example.test/live/1.ts', ''].join('\n');
    const m3uFetch: FetchFn = async (u, i) => (u === 'http://example.test/p.m3u' ? new Response(playlist) : fetch(u, i));

    test('no active source: nothing known, no guide URL', async () => {
      const { api } = make();
      await api.init();
      expect(await api.guideStatus()).toEqual({ coverageKnown: false, hasGuideUrl: false });
    });

    test('an M3U source without a guide URL never has coverage', async () => {
      const { api } = make(storage, SourceService, m3uFetch);
      await api.addSource({ kind: 'm3u', name: 'Plain', playlistUrl: 'http://example.test/p.m3u' });
      await api.idle();
      expect(await api.guideStatus()).toEqual({ coverageKnown: false, hasGuideUrl: false });
      expect((await api.getCompanionState()).coverageKnown).toBe(false);
    });

    test('a source with a guide URL knows its coverage only after the guide download', async () => {
      const gated = gate();
      const fetchFn: FetchFn = async (u, i) => {
        if (u.includes('/xmltv.php')) await gated.p;
        return m3uFetch(u, i);
      };
      const { api } = make(storage, SourceService, fetchFn);
      await api.addSource({
        kind: 'm3u', name: 'Guided', playlistUrl: 'http://example.test/p.m3u',
        epgUrl: `${server.url}/xmltv.php?username=test&password=test`,
      });
      expect(await api.guideStatus()).toEqual({ coverageKnown: false, hasGuideUrl: true });
      expect((await api.getCompanionState()).coverageKnown).toBe(false);
      gated.open();
      await api.idle();
      expect(await api.guideStatus()).toEqual({ coverageKnown: true, hasGuideUrl: true });
      expect((await api.getCompanionState()).coverageKnown).toBe(true);
    });

    test('an Xtream source always has a guide URL', async () => {
      const { api } = make();
      await api.addSource(xt());
      expect((await api.guideStatus()).hasGuideUrl).toBe(true);
    });
  });

  test('toggleFavourite and toggleHidden report the real state when the change is refused', async () => {
    const { api } = make();
    await api.addSource(xt());
    const id = (await api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    const spy = vi.spyOn(api as unknown as { applyLayoutLocked: () => Promise<unknown> }, 'applyLayoutLocked')
      .mockResolvedValue({ version: 1, rejected: [{ index: 0, reason: 'cap' }] });
    expect(await api.toggleFavourite(id)).toBe(false);
    expect(await api.toggleHidden(id)).toBe(false);
    spy.mockRestore();
    expect(await api.toggleFavourite(id)).toBe(true);
    expect(await api.toggleHidden(id)).toBe(true);
  });

  test('live audio choice: remembered per channel of the active source, survives a restart, cleared with undefined', async () => {
    const { api } = make();
    await api.addSource(xt());
    const [a, b] = (await api.getChannelSlice('g:Movies', 0, 2)).rows.map((r) => r.id);
    expect(await api.getLiveAudio(a!)).toBeUndefined();
    await api.setLiveAudio(a!, 'swe:Svenska');
    await api.setLiveAudio(b!, 'eng:English');
    expect(await api.getLiveAudio(a!)).toBe('swe:Svenska');
    expect(await api.getLiveAudio(b!)).toBe('eng:English');
    await api.idle();
    const again = make().api;
    await again.init();
    expect(await again.getLiveAudio(a!)).toBe('swe:Svenska');
    await again.setLiveAudio(a!, undefined);
    expect(await again.getLiveAudio(a!)).toBeUndefined();
    expect(await again.getLiveAudio(b!)).toBe('eng:English');
  });

  test('live audio choice keeps the latest LIVE_AUDIO_MAX channels and nothing without an active source', async () => {
    expect(await make().api.getLiveAudio('c1')).toBeUndefined();
    const { api } = make();
    await api.addSource(xt());
    for (let i = 0; i < LIVE_AUDIO_MAX + 5; i++) await api.setLiveAudio(`c${i}`, 'eng:English');
    expect(await api.getLiveAudio('c0')).toBeUndefined();
    expect(await api.getLiveAudio('c4')).toBeUndefined();
    expect(await api.getLiveAudio('c5')).toBe('eng:English');
    expect(await api.getLiveAudio(`c${LIVE_AUDIO_MAX + 4}`)).toBe('eng:English');
    // Setting a known channel again moves it to the newest end rather than adding a copy.
    await api.setLiveAudio('c5', 'swe:Svenska');
    await api.setLiveAudio('new', 'eng:English');
    expect(await api.getLiveAudio('c5')).toBe('swe:Svenska');
    expect(await api.getLiveAudio('c6')).toBeUndefined();
  });

  test('markWatched creates recent group and sets last channel on next init', async () => {
    const { api } = make();
    await api.addSource(xt());
    const id = (await api.getChannelSlice('g:Movies', 0, 1)).rows[0]!.id;
    await api.markWatched(id, 'g:Movies');
    expect((await api.getGroups()).some((g) => g.id === 'recent')).toBe(true);
    await api.idle();
    const state = await make().api.init();
    expect(state.lastChannelId).toBe(id);
    expect(state.lastGroupId).toBe('g:Movies');
  });

  test('epgOffsetHours: now is the stored programme whose shifted slot contains the current time', async () => {
    const { api } = make();
    await api.addSource(xt());
    await api.refresh('epg');
    const before = (await api.getChannelSlice('all', 0, 1)).rows[0]!;
    const n = Number(/^Programme (\d+)$/.exec(before.now!.title)![1]);
    await api.saveSettings({ epgOffsetHours: 1 });
    const after = (await api.getChannelSlice('all', 0, 1)).rows[0]!;
    expect(after.now!.start).toBeLessThanOrEqual(NOW);
    expect(after.now!.stop).toBeGreaterThan(NOW);
    // 30-minute slots: the programme that aired one hour earlier is two slots back.
    expect(after.now!.title).toBe(`Programme ${n - 2}`);
    expect(after.next!.title).toBe(`Programme ${n - 1}`);
    expect(after.next!.start).toBe(after.now!.stop);
  });

  test('getEpgRows returns programmes inside the window', async () => {
    const { api } = make();
    await api.addSource(xt());
    await api.refresh('epg');
    const r = await api.getEpgRows('all', 0, 3, NOW, NOW + 3 * 3600_000);
    expect(r.total).toBe(40);
    expect(r.rows).toHaveLength(3);
    for (const row of r.rows) {
      expect(row.programmes.length).toBeGreaterThan(0);
      for (const p of row.programmes) expect(p.stop > NOW && p.start < NOW + 3 * 3600_000).toBe(true);
    }
  });

  test('getEpgRows reads the stored guide once per page (the window), with lite rows without now/next', async () => {
    let reads = 0;
    class Counting extends SourceService {
      override async programmesFor(id: string, channels: Channel[], from: number, to: number): Promise<Map<string, Programme[]>> {
        reads++;
        return super.programmesFor(id, channels, from, to);
      }
    }
    const { api } = make(storage, Counting);
    await api.addSource(xt());
    await api.refresh('epg');
    reads = 0;
    const r = await api.getEpgRows('all', 0, 3, NOW, NOW + 3 * 3600_000);
    expect(reads).toBe(1);
    expect(r.rows.map((row) => row.channel.name)).toHaveLength(3);
    for (const row of r.rows) {
      expect(row.programmes.length).toBeGreaterThan(0);
      expect(row.channel.now).toBeUndefined();
      expect(row.channel.next).toBeUndefined();
      expect(typeof row.channel.favourite).toBe('boolean');
    }
  });

  test('search: channels only when nothing in the guide matches', async () => {
    const { api } = make();
    await api.addSource(xt());
    await api.refresh('epg');
    await warm(api);
    const r = await api.search('channel 007', 5);
    expect(r.channels.map((c) => c.name)).toEqual(['Channel 007']);
    expect(r.onNow).toEqual([]);
    expect(r.later).toEqual([]);
    expect(r.guidePending).toBe(false);
    expect(await api.search('', 5)).toEqual({ channels: [], onNow: [], later: [], guidePending: false, folders: [], movies: [], series: [], vodPending: false });
    // Without movies and series support: no VOD sections, never pending.
    expect(r.movies).toEqual([]);
    expect(r.series).toEqual([]);
    expect(r.vodPending).toBe(false);
  });

  test('searchChannels: matching channels only, limited, empty for a blank query', async () => {
    const { api } = make();
    await api.addSource(xt());
    const one = await api.searchChannels('channel 007', 5);
    expect(one.map((c) => c.name)).toEqual(['Channel 007']);
    const many = await api.searchChannels('channel', 3);
    expect(many).toHaveLength(3);
    expect(await api.searchChannels('   ', 5)).toEqual([]);
    expect(await api.searchChannels('zzzz nothing', 5)).toEqual([]);
  });

  test('search: on now (capped at 20) and coming up, one row per title', async () => {
    const { api } = make();
    await api.addSource(xt());
    await api.refresh('epg');
    await warm(api);
    const r = await api.search('programme 1', 50);
    expect(r.channels).toEqual([]);
    expect(r.onNow).toHaveLength(20);
    expect(new Set(r.onNow.map((h) => h.title))).toEqual(new Set(['Programme 12']));
    expect(r.onNow[0]!.start).toBeLessThanOrEqual(NOW);
    expect(r.onNow[0]!.stop).toBeGreaterThan(NOW);
    expect(r.later.map((h) => h.title)).toEqual(['Programme 13', 'Programme 14', 'Programme 15', 'Programme 16', 'Programme 17', 'Programme 18', 'Programme 19']);
    expect(r.later[0]!.more).toBe(39);
    expect(r.later[0]!.start).toBeGreaterThan(NOW);
    expect(r.guidePending).toBe(false);
  });

  /** An AppApi whose title index was rebuilt from a stored guide read back in `order` (by epgId). */
  const rebuiltIn = async (order: 1 | -1) => {
    class OrderedStorage extends MemoryStorage {
      override async forEachProgramme(sourceId: string, fn: (p: Programme) => void) {
        const all: Programme[] = [];
        await super.forEachProgramme(sourceId, (p) => all.push(p));
        all.sort((a, b) => (a.epgId < b.epgId ? -order : a.epgId > b.epgId ? order : a.start - b.start));
        for (const p of all) fn(p);
      }
    }
    const st = new OrderedStorage();
    const { seed, sourceId } = await seeded(st);
    await seed.refresh('epg');
    await st.setMeta(`titleIndex:${sourceId}`, null);
    const { api } = make(st);
    await api.init();
    await warm(api);
    return api;
  };

  test('search: on-now hits of one title follow channel number, not epgId order', async () => {
    // IndexedDB's `byChannel` cursor yields the stored guide in epgId order (c1, c10, c11, …, c2, …).
    const api = await rebuiltIn(1);
    const r = await api.search('programme 12', 50);
    expect(r.onNow.map((h) => h.channel.number)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  test('search: a coming-up row whose next airings tie on start shows the lowest channel number', async () => {
    // Every channel airs Programme 13 next at the same start; the airings arrive as c9, c8, …, c40, c4, …
    const api = await rebuiltIn(-1);
    const r = await api.search('programme 13', 50);
    expect(r.later.map((h) => h.channel.number)).toEqual([1]);
  });

  test('search: channel hits are capped at 10 when programmes match too; total stays within limit', async () => {
    const { api } = make();
    await api.addSource(xt());
    await api.refresh('epg');
    const rows = (await api.getChannelSlice('all', 0, 12)).rows;
    await api.applyLayoutOps(rows.map((r, i) => ({ op: 'renameChannel' as const, id: r.id, name: `Programme Channel ${i + 1}` })));
    await warm(api);
    const r = await api.search('programme', 12);
    expect(r.channels).toHaveLength(10);
    expect(r.channels.length + r.onNow.length + r.later.length).toBeLessThanOrEqual(12);
  });

  test('search: a failed rebuild reports guidePending once, emits searchReady, then clears and records the error', async () => {
    const { seed, sourceId } = await seeded();
    await seed.refresh('epg');
    await storage.setMeta(`titleIndex:${sourceId}`, null);
    class Failing extends SourceService {
      override async rebuildTitleIndex(): Promise<void> { throw new Error('boom'); }
    }
    const { api, events } = make(storage, Failing);
    await api.init();
    expect((await api.search('programme 12', 50)).guidePending).toBe(true);
    await api.idle();
    // searchReady lets the TV re-run the query and drop its "being prepared" note.
    expect(events.some((e) => e.type === 'searchReady' && e.sourceId === sourceId)).toBe(true);
    const second = await api.search('programme 12', 50);
    expect(second.guidePending).toBe(false);
    expect(second.onNow).toEqual([]);
    expect((await api.diagnostics()).lastErrors.some((e) => e.message.includes('boom'))).toBe(true);
  });

  test('search: the guide offset decides what is on now', async () => {
    const { api } = make();
    await api.addSource(xt());
    await api.refresh('epg');
    await api.saveSettings({ epgOffsetHours: 1 });
    await warm(api);
    // Displayed = stored + 1 h, so at 18:10 the stored 17:00 slot (Programme 10) is on now.
    const r = await api.search('programme 10', 50);
    expect(r.onNow.map((h) => h.title)).toContain('Programme 10');
    expect(r.onNow[0]!.start).toBeLessThanOrEqual(NOW);
  });

  test('search: a missing index reports guidePending, rebuilds once and emits searchReady', async () => {
    const { seed, sourceId } = await seeded();
    await seed.refresh('epg');
    await storage.setMeta(`titleIndex:${sourceId}`, null);
    const { api, events } = make();
    await api.init();
    const first = await api.search('programme 12', 50);
    expect(first.guidePending).toBe(true);
    expect(first.onNow).toEqual([]);
    await api.idle();
    expect(events.some((e) => e.type === 'searchReady' && e.sourceId === sourceId)).toBe(true);
    const second = await api.search('programme 12', 50);
    expect(second.guidePending).toBe(false);
    expect(second.onNow.length).toBeGreaterThan(0);
  });

  test('search: the first search returns channels at once with guidePending, loads the index in the background and emits searchReady', async () => {
    const { seed, sourceId } = await seeded();
    await seed.refresh('epg');
    const d = deferredTitles();
    const { api, events } = make(storage, d.Svc);
    await api.init();
    // The load is held open: the search must not wait on it.
    const first = await api.search('channel 007', 50);
    expect(first.channels.map((c) => c.name)).toEqual(['Channel 007']);
    expect(first.guidePending).toBe(true);
    expect(first.onNow).toEqual([]);
    expect(events.some((e) => e.type === 'searchReady')).toBe(false);
    d.open();
    await api.idle();
    expect(events.some((e) => e.type === 'searchReady' && e.sourceId === sourceId)).toBe(true);
    const second = await api.search('programme 12', 50);
    expect(second.guidePending).toBe(false);
    expect(second.onNow.length).toBeGreaterThan(0);
    expect(d.state.calls).toBe(1);
  });

  test('search: concurrent searches share one title index load', async () => {
    const { seed } = await seeded();
    await seed.refresh('epg');
    const d = deferredTitles();
    const { api } = make(storage, d.Svc);
    await api.init();
    const rs = await Promise.all([api.search('p', 50), api.search('pr', 50), api.search('pro', 50)]);
    expect(rs.every((r) => r.guidePending)).toBe(true);
    expect(d.state.calls).toBe(1);
    d.open();
    await api.idle();
    expect((await api.search('programme 12', 50)).onNow.length).toBeGreaterThan(0);
    expect(d.state.calls).toBe(1);
  });

  test('search: a source switch during the title index load neither caches nor emits for the old source', async () => {
    const { seed, sourceId: first } = await seeded();
    await seed.refresh('epg');
    const { sourceId: second } = await seed.addSource(xt());
    await seed.idle();
    const d = deferredTitles();
    const { api, events } = make(storage, d.Svc);
    await api.init();
    await api.setActiveSource(first);
    expect((await api.search('programme 12', 50)).guidePending).toBe(true);
    await api.setActiveSource(second);
    d.open();
    await api.idle();
    expect(events.some((e) => e.type === 'searchReady' && e.sourceId === first)).toBe(false);
    expect(d.state.calls).toBe(1);
  });

  test('search: a title index that cannot be read still returns channels, records the error name and rebuilds once', async () => {
    const { seed, sourceId } = await seeded();
    await seed.refresh('epg');
    const state = { reads: 0, rebuilds: 0 };
    class Throwing extends SourceService {
      override async titleIndexFor(id: string) {
        if (++state.reads === 1) throw new RangeError('secret detail http://example.test/x?password=p');
        return super.titleIndexFor(id);
      }
      override async rebuildTitleIndex(id: string): Promise<void> {
        state.rebuilds++;
        return super.rebuildTitleIndex(id);
      }
    }
    const { api, events } = make(storage, Throwing);
    await api.init();
    const r = await api.search('channel 007', 50);
    expect(r.channels.map((c) => c.name)).toEqual(['Channel 007']);
    expect(r.guidePending).toBe(true);
    await api.idle();
    expect(state.rebuilds).toBe(1);
    expect(events.some((e) => e.type === 'searchReady' && e.sourceId === sourceId)).toBe(true);
    const errors = (await api.diagnostics()).lastErrors;
    expect(errors.some((e) => e.message.includes('RangeError'))).toBe(true);
    expect(errors.some((e) => e.message.includes('secret') || e.message.includes('example.test'))).toBe(false);
    expect((await api.search('programme 12', 50)).onNow.length).toBeGreaterThan(0);
  });

  test('clearCache keeps sources and favourites', async () => {
    const { api } = make();
    await api.addSource(xt());
    const id = (await api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    await api.toggleFavourite(id);
    const state = await api.clearCache();
    expect(state.sources).toHaveLength(1);
    expect(state.groups.find((g) => g.id === 'all')?.count ?? 0).toBe(0);
    await api.refresh('playlist');
    expect((await api.getChannelSlice('fav', 0, 10)).rows.map((r) => r.id)).toEqual([id]);
  });

  test('updateSource, setActiveSource, deleteSource', async () => {
    const { api } = make();
    const a = await api.addSource(xt());
    const b = await api.addSource({ ...xt(), name: 'Second' });
    expect((await api.getSource(a.sourceId))?.kind).toBe('xtream');
    expect((await api.updateSource({ ...(await api.getSource(b.sourceId))!, name: 'Renamed' })).channelCount).toBe(40);
    expect((await api.setActiveSource(b.sourceId)).activeSourceId).toBe(b.sourceId);
    const after = await api.deleteSource(b.sourceId);
    expect(after.sources.map((s) => s.id)).toEqual([a.sourceId]);
    expect(after.activeSourceId).toBe(a.sourceId);
    expect(after.groups.length).toBeGreaterThan(0);
  });

  test('diagnostics never contains the password and keeps errors', async () => {
    const { api } = make();
    await expect(api.addSource(xt('test', 'hunter2-secret'))).rejects.toBeInstanceOf(SourceAuthError);
    await api.addSource(xt('test', 'test'));
    const d = await api.diagnostics();
    expect(d.appVersion).toBe('1.2.3');
    expect(d.sources[0]).toMatchObject({ name: 'Fake', kind: 'xtream', channels: 40 });
    expect(d.lastErrors.length).toBeGreaterThanOrEqual(1);
    expect(d.lastErrors[0]!.where).toBe('addSource');
    const text = JSON.stringify(d);
    expect(text).not.toContain('hunter2-secret');
    expect(text).not.toMatch(/password/i);
  });

  test('background refresh from init emits progress and refreshed', async () => {
    const { sourceId } = await seeded();
    await storage.setMeta(`playlistAt:${sourceId}`, 0);
    await storage.setMeta(`epgAt:${sourceId}`, 0);
    const { api, events } = make();
    const state = await api.init();
    expect(state.groups.length).toBeGreaterThan(0);
    await api.idle();
    expect(events.some((e) => e.type === 'refreshed' && e.what === 'playlist')).toBe(true);
    expect(events.some((e) => e.type === 'refreshed' && e.what === 'epg')).toBe(true);
    expect(events.some((e) => e.type === 'progress')).toBe(true);
  });

  test('init with empty cache returns at once and loads channels in background', async () => {
    const { sourceId } = await seeded();
    await storage.replaceChannels(sourceId, []);
    const { api, events } = make();
    const state = await api.init();
    expect(state.groups.find((g) => g.id === 'all')?.count).toBe(0);
    expect(state.activeSourceId).toBe(sourceId);
    await api.idle();
    expect(events.some((e) => e.type === 'refreshed' && e.what === 'playlist')).toBe(true);
    expect((await api.getGroups()).find((g) => g.id === 'all')?.count).toBe(40);
  });

  test('a VOD-only M3U source: hasVod, and no playlist refetch on a second init within the refresh window', async () => {
    const vodOnly = '#EXTM3U\n#EXTINF:-1 group-title="Drama",Synthetic Film A (2020)\nhttp://example.test/movie/u/p/1.mp4\n';
    let gets = 0;
    const fetchFn: FetchFn = async (u, i) => {
      if (u.includes('/vod-only.m3u')) { gets++; return new Response(vodOnly); }
      return fetch(u, i);
    };
    const seed = make(storage, SourceService, fetchFn).api;
    const { channelCount } = await seed.addSource({ kind: 'm3u', name: 'V', playlistUrl: `${server.url}/vod-only.m3u` });
    expect(channelCount).toBe(0);
    await seed.idle();
    const before = gets;
    const { api, events } = make(storage, SourceService, fetchFn);
    const state = await api.init();
    expect(state.hasVod).toBe(true);
    await api.idle();
    expect(gets).toBe(before);
    expect(events.some((e) => e.type === 'refreshed' && e.what === 'playlist')).toBe(false);
  });

  test('a VOD-only Xtream account: hasVod before the Movies tab was opened, and no playlist refetch on a second init', async () => {
    let liveGets = 0;
    const fetchFn: FetchFn = async (u, i) => {
      if (u.includes('action=get_live_streams')) { liveGets++; return new Response('[]'); }
      if (u.includes('action=get_live_categories')) return new Response('[]');
      return fetch(u, i);
    };
    const seed = make(storage, SourceService, fetchFn).api;
    const { sourceId, channelCount } = await seed.addSource(xt());
    expect(channelCount).toBe(0);
    await seed.idle();
    expect(await storage.getMeta(`vodAt:movie:${sourceId}`)).toBeFalsy();
    const before = liveGets;
    const { api } = make(storage, SourceService, fetchFn);
    expect((await api.init()).hasVod).toBe(true);
    await api.idle();
    expect(liveGets).toBe(before);
  });

  test('a source with channels and movies whose channel cache was lost is refetched at start', async () => {
    const { api: seed } = makeVod();
    const { sourceId } = await seed.addSource({ kind: 'm3u', name: 'Fake M3U', playlistUrl: `${server.url}/get.php?username=test&password=test&type=m3u_plus` });
    await seed.idle();
    await storage.replaceChannels(sourceId, []);
    const { api, events } = make();
    const state = await api.init();
    expect(state.hasVod).toBe(true);
    await api.idle();
    expect(events.some((e) => e.type === 'refreshed' && e.what === 'playlist')).toBe(true);
    expect((await api.getGroups()).find((g) => g.id === 'all')?.count).toBeGreaterThan(0);
  });

  test('hasVod: false for a live-only source; true once an Xtream catalogue was fetched', async () => {
    const { sourceId } = await seeded();
    expect((await make().api.init()).hasVod).toBe(false);
    await storage.setMeta(`vodAt:movie:${sourceId}`, NOW);
    expect((await make().api.init()).hasVod).toBe(true);
  });

  test('a cache whose channels are all hidden is not treated as empty', async () => {
    const { seed } = await seeded();
    for (const r of (await seed.getChannelSlice('all', 0, 100)).rows) await seed.toggleHidden(r.id);
    const { api, events } = make();
    await api.init();
    await api.idle();
    expect(events.some((e) => e.type === 'refreshed' && e.what === 'playlist')).toBe(false);
  });

  test('refresh failure emits refreshFailed and rethrows', async () => {
    const { sourceId } = await seeded();
    const { api, events } = make();
    await api.init();
    await api.idle();
    const src = (await api.getSource(sourceId))!;
    await storage.putSource({ ...src, password: 'wrong' } as typeof src);
    await expect(api.refresh('playlist')).rejects.toBeInstanceOf(SourceAuthError);
    expect(events.find((e) => e.type === 'refreshFailed' && e.what === 'playlist'))
      .toMatchObject({ sourceId, error: { name: 'SourceAuthError' } });
  });

  test('explicit refresh waits for the running background refresh, then runs its own steps', async () => {
    const { sourceId } = await seeded();
    await storage.setMeta(`playlistAt:${sourceId}`, 0);
    await storage.setMeta(`epgAt:${sourceId}`, 0);
    const { api, events } = make();
    await api.init();
    await api.refresh('playlist');
    await api.idle();
    const done = events.filter((e) => e.type === 'refreshed').map((e) => (e as { what: string }).what);
    expect(done).toEqual(['playlist', 'epg', 'playlist']);
  });

  test('clearCache while a background refresh runs reruns it so the channels come back', async () => {
    const { sourceId } = await seeded();
    await storage.setMeta(`epgAt:${sourceId}`, 0);
    const g = gate();
    let entered!: () => void;
    const hit = new Promise<void>((r) => { entered = r; });
    class Gated extends SourceService {
      override async refreshEpg(id: string, p?: Parameters<SourceService['refreshEpg']>[1]) {
        entered();
        await g.p;
        return super.refreshEpg(id, p);
      }
    }
    const { api } = make(storage, Gated);
    await api.init();
    await hit;
    const state = await api.clearCache();
    expect(state.groups.find((x) => x.id === 'all')?.count ?? 0).toBe(0);
    g.open();
    await api.idle();
    expect((await api.getGroups()).find((x) => x.id === 'all')?.count).toBe(40);
  });

  test('deleteSource waits for the running background task of that source', async () => {
    const { sourceId } = await seeded();
    await storage.setMeta(`epgAt:${sourceId}`, 0);
    const g = gate();
    let entered!: () => void;
    const hit = new Promise<void>((r) => { entered = r; });
    class Gated extends SourceService {
      override async refreshEpg(id: string, p?: Parameters<SourceService['refreshEpg']>[1]) {
        entered();
        await g.p;
        return super.refreshEpg(id, p);
      }
    }
    const { api, events } = make(storage, Gated);
    await api.init();
    await hit;
    let done = false;
    const deleting = api.deleteSource(sourceId).then((s) => { done = true; return s; });
    await settle();
    expect(done).toBe(false);
    g.open();
    const after = await deleting;
    expect(after.sources).toEqual([]);
    await api.idle();
    expect(events.some((e) => e.type === 'refreshFailed')).toBe(false);
    expect(events.some((e) => e.type === 'refreshed' && e.what === 'epg')).toBe(true);
  });

  test('toggleFavourite during a background playlist rebuild keeps the favourite', async () => {
    class GatedStorage extends MemoryStorage {
      armed = false;
      readonly g = gate();
      private entered!: () => void;
      readonly hit = new Promise<void>((r) => { this.entered = r; });
      override async getChannels(sourceId: string): Promise<Channel[]> {
        if (this.armed) {
          this.armed = false;
          this.entered();
          await this.g.p;
        }
        return super.getChannels(sourceId);
      }
    }
    const st = new GatedStorage();
    const { seed, sourceId } = await seeded(st);
    const id = (await seed.getChannelSlice('all', 3, 1)).rows[0]!.id;
    await st.setMeta(`playlistAt:${sourceId}`, 0);
    class Arming extends SourceService {
      override async refreshPlaylist(sid: string, p?: Parameters<SourceService['refreshPlaylist']>[1]) {
        const r = await super.refreshPlaylist(sid, p);
        st.armed = true;
        return r;
      }
    }
    const { api } = make(st, Arming);
    await api.init();
    await st.hit;
    const toggled = api.toggleFavourite(id);
    await settle();
    st.g.open();
    expect(await toggled).toBe(true);
    await api.idle();
    expect((await api.getChannelSlice('fav', 0, 10)).rows.map((r) => r.id)).toEqual([id]);
    const { api: again } = make(st);
    expect((await again.init()).groups.find((x) => x.id === 'fav')?.count).toBe(1);
  });

  test('background setup errors are recorded and emitted as refreshFailed', async () => {
    await seeded();
    class Broken extends SourceService {
      override needsPlaylistRefresh(): Promise<boolean> { return Promise.reject(new Error('disk unavailable')); }
    }
    const { api, events } = make(storage, Broken);
    await api.init();
    await api.idle();
    expect(events.find((e) => e.type === 'refreshFailed'))
      .toMatchObject({ what: 'playlist', error: { message: 'disk unavailable' } });
    expect((await api.diagnostics()).lastErrors.some((e) => e.message === 'disk unavailable')).toBe(true);
  });

  test('a failed channel refresh still lets the guide step run, and both failures are recorded', async () => {
    const { sourceId } = await seeded();
    await storage.setMeta(`playlistAt:${sourceId}`, 0);
    await storage.setMeta(`epgAt:${sourceId}`, 0);
    let epgCalls = 0;
    class PlaylistDown extends SourceService {
      override async refreshPlaylist(): Promise<never> { throw new SourceNetworkError('Could not reach the provider.', 500); }
      override async refreshEpg(id: string, p?: Parameters<SourceService['refreshEpg']>[1]) {
        epgCalls++;
        return super.refreshEpg(id, p);
      }
    }
    const { api, events } = make(storage, PlaylistDown);
    await api.init();
    await api.idle();
    expect(epgCalls).toBe(1);
    expect(events.find((e) => e.type === 'refreshFailed' && e.what === 'playlist')).toMatchObject({ sourceId });
    expect(events.some((e) => e.type === 'refreshed' && e.what === 'epg')).toBe(true);
  });

  test('a channel step that left the source cooling skips the guide in that pass', async () => {
    const { sourceId } = await seeded();
    await storage.setMeta(`playlistAt:${sourceId}`, 0);
    await storage.setMeta(`epgAt:${sourceId}`, 0);
    let epgCalls = 0;
    class Refusing extends SourceService {
      override async refreshPlaylist(id: string): Promise<never> {
        await this.guard.report(id, 'refused');
        throw new SourceRefusedError();
      }
      override async refreshEpg(id: string, p?: Parameters<SourceService['refreshEpg']>[1]) {
        epgCalls++;
        return super.refreshEpg(id, p);
      }
    }
    const { api, events } = make(storage, Refusing);
    await api.init();
    await api.idle();
    expect(events.find((e) => e.type === 'refreshFailed' && e.what === 'playlist')).toMatchObject({ sourceId });
    expect(epgCalls).toBe(0);
  });

  /** A seeded source whose channel step fails with `err` and whose guide step is counted (and runs for real). */
  const channelStepFails = async (err: () => Error) => {
    const { sourceId } = await seeded();
    await storage.setMeta(`playlistAt:${sourceId}`, 0);
    await storage.setMeta(`epgAt:${sourceId}`, 0);
    const state = { epgCalls: 0 };
    class Failing extends SourceService {
      override async refreshPlaylist(): Promise<never> { throw err(); }
      override async refreshEpg(id: string, p?: Parameters<SourceService['refreshEpg']>[1]) {
        state.epgCalls++;
        return super.refreshEpg(id, p);
      }
    }
    const { api, events } = make(storage, Failing);
    await api.init();
    await api.idle();
    return { state, events, offline: events.some((e) => e.type === 'offline' && e.value) };
  };

  test('a channel step whose request never reached the source skips the guide in that pass', async () => {
    const r = await channelStepFails(unreachableError);
    expect(r.offline).toBe(true);
    expect(r.state.epgCalls).toBe(0);
  });

  test('a stalled live list still runs the guide, and is not offline', async () => {
    const r = await channelStepFails(() => new SourceNetworkError('The provider stopped sending data.'));
    expect(r.state.epgCalls).toBe(1);
    expect(r.events.some((e) => e.type === 'refreshed' && e.what === 'epg')).toBe(true);
    expect(r.offline).toBe(false);
  });

  test('a channel step that timed out still runs the guide', async () => {
    const r = await channelStepFails(() => new SourceNetworkError('The provider did not respond in time.'));
    expect(r.state.epgCalls).toBe(1);
    expect(r.offline).toBe(false);
  });

  test('"no channels" runs the guide and does not mark the app offline', async () => {
    const r = await channelStepFails(() => new SourceNetworkError('The playlist contains no channels.'));
    expect(r.state.epgCalls).toBe(1);
    expect(r.offline).toBe(false);
  });

  test('an M3U whose guide is on another host still runs the guide when the playlist host is unreachable', async () => {
    // The playlist lives on lists.test (served by the fake server while up); the guide on the fake server's own host.
    const listsUp = { value: true, xmltv: 0 };
    const f: FetchFn = async (u, i) => {
      const url = new URL(u);
      if (url.host === 'lists.test') {
        if (!listsUp.value) throw new TypeError('Failed to fetch');
        return fetch(`${server.url}${url.pathname}${url.search}`, i);
      }
      if (url.pathname === '/xmltv.php') listsUp.xmltv++;
      return fetch(u, i);
    };
    const { api, events } = make(storage, SourceService, f);
    const { sourceId } = await api.addSource({
      kind: 'm3u', name: 'Split', playlistUrl: 'http://lists.test/get.php?username=test&password=test&type=m3u_plus',
      epgUrl: `${server.url}/xmltv.php?username=test&password=test`,
    });
    await api.idle();
    listsUp.value = false;
    listsUp.xmltv = 0;
    await storage.setMeta(`playlistAt:${sourceId}`, 0);
    await storage.setMeta(`epgAt:${sourceId}`, 0);
    events.length = 0;
    await api.init();
    await api.idle();
    expect(events.find((e) => e.type === 'refreshFailed' && e.what === 'playlist')).toMatchObject({ sourceId });
    expect(events.some((e) => e.type === 'offline' && e.value)).toBe(true);
    expect(listsUp.xmltv).toBe(1);
    expect(events.some((e) => e.type === 'refreshed' && e.what === 'epg')).toBe(true);
  });

  describe('the guide import shares the worker', () => {
    const indexOf = (a: AppApi) => (a as unknown as { index: object }).index;

    describe('a failing or dropped late guide read', () => {
      async function slowApi() {
        const { seed } = await seeded();
        await seed.refresh('epg');
        await seed.idle();
        const state = { g: gate(), fail: true };
        class SlowGuide extends SourceService {
          override async programmesFor(...args: Parameters<SourceService['programmesFor']>) {
            await state.g.p;
            if (state.fail) throw new Error('read failed');
            return super.programmesFor(...args);
          }
        }
        const events: AppEvent[] = [];
        const service = new SlowGuide({ storage, fetch: (u, i) => fetch(u, i), now: () => NOW, shortEpgGapMs: 0 });
        const api = new AppApi({ service, storage, emit: (e) => events.push(e), now: () => NOW, appVersion: '1.2.3', nowNextWaitMs: 20 });
        live.push(api);
        await api.init();
        const from = NOW - 3_600_000;
        const to = NOW + 3_600_000;
        const updates = () => events.filter((e) => e.type === 'nowNextUpdated').length;
        const slowFail = async () => {
          state.g = gate();
          await api.getEpgRows('all', 0, 3, from, to);
          state.g.open();
          await api.idle();
        };
        return { api, state, updates, slowFail, events };
      }

      test('two slow failures for the same page give one nowNextUpdated', async () => {
        const { updates, slowFail } = await slowApi();
        await slowFail();
        expect(updates()).toBe(1);
        await slowFail();
        expect(updates()).toBe(1);
      });

      test('after invalidateNowNext a new failure emits again', async () => {
        const { api, updates, slowFail } = await slowApi();
        await slowFail();
        expect(updates()).toBe(1);
        (api as unknown as { invalidateNowNext(): void }).invalidateNowNext();
        await slowFail();
        expect(updates()).toBe(2);
      });

      test('an answer dropped after a source switch emits nothing', async () => {
        const { api, state, updates } = await slowApi();
        state.fail = false;
        await api.getEpgRows('all', 0, 3, NOW - 3_600_000, NOW + 3_600_000);
        (api as unknown as { activeId: string | null }).activeId = 'another-source';
        state.g.open();
        await api.idle();
        expect(updates()).toBe(0);
      });
    });

    test('getEpgRows answers lite rows when the guide read is slow; the late read comes as nowNextUpdated', async () => {
      const { seed } = await seeded();
      await seed.refresh('epg');
      await seed.idle();
      const g = gate();
      const state = { held: true, reads: 0 };
      class SlowGuide extends SourceService {
        override async programmesFor(...args: Parameters<SourceService['programmesFor']>) {
          state.reads++;
          if (state.held) await g.p;
          return super.programmesFor(...args);
        }
      }
      const events: AppEvent[] = [];
      const service = new SlowGuide({ storage, fetch: (u, i) => fetch(u, i), now: () => NOW, shortEpgGapMs: 0 });
      const api = new AppApi({ service, storage, emit: (e) => events.push(e), now: () => NOW, appVersion: '1.2.3', nowNextWaitMs: 20 });
      live.push(api);
      await api.init();
      const from = NOW - 3_600_000;
      const to = NOW + 3_600_000;
      const lite = await api.getEpgRows('all', 0, 3, from, to);
      expect(lite.total).toBe(40);
      expect(lite.rows.map((r) => r.channel.name)).toHaveLength(3);
      expect(lite.rows.every((r) => r.programmes.length === 0)).toBe(true);
      state.held = false;
      g.open();
      await api.idle();
      const updated = events.filter((e): e is Extract<AppEvent, { type: 'nowNextUpdated' }> => e.type === 'nowNextUpdated');
      expect(updated.flatMap((e) => e.channelIds)).toEqual(lite.rows.map((r) => r.channel.id));
      // The re-read uses the late answer: no second guide read.
      const reads = state.reads;
      const full = await api.getEpgRows('all', 0, 3, from, to);
      expect(state.reads).toBe(reads);
      expect(full.rows[0]!.programmes[0]?.title).toMatch(/^Programme /);
      // Once used, it is gone: the next call reads the guide again.
      await api.getEpgRows('all', 0, 3, from, to);
      expect(state.reads).toBe(reads + 1);
    });

    test('a late guide read that is dropped or fails still refreshes its rows, and keeps nothing', async () => {
      const { seed } = await seeded();
      await seed.refresh('epg');
      await seed.idle();
      const state = { g: gate(), reads: 0, fail: false };
      class SlowGuide extends SourceService {
        override async programmesFor(...args: Parameters<SourceService['programmesFor']>) {
          state.reads++;
          await state.g.p;
          if (state.fail) throw new Error('read failed');
          return super.programmesFor(...args);
        }
      }
      const events: AppEvent[] = [];
      const service = new SlowGuide({ storage, fetch: (u, i) => fetch(u, i), now: () => NOW, shortEpgGapMs: 0 });
      const api = new AppApi({ service, storage, emit: (e) => events.push(e), now: () => NOW, appVersion: '1.2.3', nowNextWaitMs: 20 });
      live.push(api);
      await api.init();
      const from = NOW - 3_600_000;
      const to = NOW + 3_600_000;
      const updatedIds = () => events
        .filter((e): e is Extract<AppEvent, { type: 'nowNextUpdated' }> => e.type === 'nowNextUpdated')
        .flatMap((e) => e.channelIds);
      const late = () => (api as unknown as { epgLate: Map<string, unknown> }).epgLate;

      // Dropped: the guide changed while the read ran (a new generation).
      const lite = await api.getEpgRows('all', 0, 3, from, to);
      const ids = lite.rows.map((r) => r.channel.id);
      (api as unknown as { invalidateNowNext(): void }).invalidateNowNext();
      state.g.open();
      await api.idle();
      expect(updatedIds()).toEqual(ids);
      expect(late().size).toBe(0);

      // Failed: the late read rejects.
      events.length = 0;
      state.g = gate();
      state.fail = true;
      expect((await api.getEpgRows('all', 0, 3, from, to)).rows.every((r) => r.programmes.length === 0)).toBe(true);
      state.g.open();
      await api.idle();
      expect(updatedIds()).toEqual(ids);
      expect(late().size).toBe(0);
      // Nothing kept: the re-read reads the guide again.
      state.fail = false;
      const reads = state.reads;
      await api.getEpgRows('all', 0, 3, from, to);
      expect(state.reads).toBe(reads + 1);
    });

    test('a failed guide refresh keeps the channel index; an unchanged coverage keeps it too; a new one rebuilds it', async () => {
      await seeded();
      let fail = false;
      let drop = false;
      class Guide extends SourceService {
        override async refreshEpg(id: string, p?: Parameters<SourceService['refreshEpg']>[1]) {
          if (fail) throw new SourceNetworkError('The TV guide could not be read.', 502);
          const r = await super.refreshEpg(id, p);
          if (drop) await storage.setMeta(`epgCoverage:${id}`, []);
          return r;
        }
      }
      const { api, events } = make(storage, Guide);
      await api.init();
      await api.idle();
      const first = indexOf(api);
      fail = true;
      await expect(api.refresh('epg')).rejects.toThrow('could not be read');
      expect(indexOf(api)).toBe(first);
      fail = false;
      await api.refresh('epg');
      expect(indexOf(api)).toBe(first);
      expect(events.some((e) => e.type === 'refreshed' && e.what === 'epg')).toBe(true);
      drop = true;
      await api.refresh('epg');
      expect(indexOf(api)).not.toBe(first);
    });

    test('a guide refresh of the active source reuses its channels in memory instead of reading them again', async () => {
      await seeded();
      const { api } = make();
      await api.init();
      await api.idle();
      let reads = 0;
      const get = storage.getChannels.bind(storage);
      storage.getChannels = (id) => { reads++; return get(id); };
      await api.refresh('epg');
      expect(reads).toBe(0);
      expect((await api.getChannelSlice('all', 0, 1)).rows[0]!.now?.title).toMatch(/^Programme /);
    });

    test('Diagnostics shows the guide import: idle, importing with a count, then idle or failed with the reason', async () => {
      const { sourceId } = await seeded();
      const g = gate();
      let mode: 'hold' | 'fail' | 'pass' = 'hold';
      class Held extends SourceService {
        override async refreshEpg(id: string, p?: Parameters<SourceService['refreshEpg']>[1]) {
          if (mode === 'fail') throw new SourceNetworkError('The TV guide could not be read.', 502);
          if (mode === 'pass') return super.refreshEpg(id, p);
          p?.({ phase: 'epg', count: 412_000 });
          await g.p;
          return { programmes: 412_000, skipped: 0 };
        }
      }
      const { api } = make(storage, Held);
      await api.init();
      await api.idle();
      const guide = async () => (await api.diagnostics()).sources.find((s) => s.id === sourceId)!.guideImport;
      expect(await guide()).toEqual({ stage: 'idle', count: 0, startedAt: 0 });
      const running = api.refresh('epg');
      await settle();
      expect(await guide()).toEqual({ stage: 'importing', count: 412_000, startedAt: NOW });
      g.open();
      await running;
      expect(await guide()).toEqual({ stage: 'idle', count: 412_000, startedAt: NOW });
      mode = 'fail';
      await api.refresh('epg').catch(() => undefined);
      expect(await guide()).toEqual({
        stage: 'failed', count: 0, startedAt: NOW,
        error: { name: 'SourceNetworkError', message: 'The TV guide could not be read.', status: 502 },
      });
      mode = 'pass';
      await api.refresh('epg');
      expect((await guide())?.stage).toBe('idle');
      // A deleted source leaves no import state behind.
      await api.deleteSource(sourceId);
      expect((api as unknown as { guideImports: Map<string, unknown> }).guideImports.has(sourceId)).toBe(false);
    });
  });

  test('Diagnostics shows the guide import as importing only once it really starts, not while queued', async () => {
    const { sourceId } = await seeded();
    const queued = gate();
    const reading = gate();
    let hold = false;
    class Queued extends SourceService {
      override async refreshEpg(id: string, p?: Parameters<SourceService['refreshEpg']>[1], o?: Parameters<SourceService['refreshEpg']>[2]) {
        if (!hold) return super.refreshEpg(id, p, o);
        // Waiting for the source lock (a playlist refresh holds it): nothing is imported yet.
        await queued.p;
        o?.onStart?.();
        await reading.p;
        return { programmes: 0, skipped: 0 };
      }
    }
    const { api } = make(storage, Queued);
    await api.init();
    await api.idle();
    const guide = async () => (await api.diagnostics()).sources.find((s) => s.id === sourceId)!.guideImport;
    hold = true;
    const running = api.refresh('epg');
    await settle();
    expect(await guide()).toEqual({ stage: 'idle', count: 0, startedAt: 0 });
    queued.open();
    await settle();
    expect(await guide()).toEqual({ stage: 'importing', count: 0, startedAt: NOW });
    reading.open();
    await running;
    expect((await guide())?.stage).toBe('idle');
  });

  test('a DOMException with an empty message is logged by name, with non-empty text', async () => {
    class Quota extends SourceService {
      override deleteSource(): never { throw new DOMException('', 'QuotaExceededError'); }
    }
    const { api } = make(storage, Quota);
    const err = await api.deleteSource('x').catch((e: unknown) => e) as Error;
    expect(err.name).toBe('QuotaExceededError');
    const entry = (await api.diagnostics()).lastErrors.find((e) => e.where === 'deleteSource')!;
    expect(entry.name).toBe('QuotaExceededError');
    expect(entry.message).toBe('QuotaExceededError');
  });

  test('the log keeps code and status when the error has them', async () => {
    class Coded extends SourceService {
      override deleteSource(): never { throw Object.assign(new Error('nope'), { name: 'HttpError', status: 503, code: 22 }); }
    }
    const { api } = make(storage, Coded);
    await api.deleteSource('x').catch(() => undefined);
    expect((await api.diagnostics()).lastErrors.find((e) => e.where === 'deleteSource'))
      .toMatchObject({ name: 'HttpError', message: 'nope', status: 503, code: 22 });
  });

  test('a name or string code that holds a link is scrubbed in the log too', async () => {
    class Odd extends SourceService {
      override deleteSource(): never { throw Object.assign(new Error('nope'), { name: 'Failed http://example.test/live/u1/p1/1.ts?x=1', code: 'ERR http://example.test/live/u1/p1/2.ts' }); }
    }
    const { api } = make(storage, Odd);
    await api.deleteSource('x').catch(() => undefined);
    const e = (await api.diagnostics()).lastErrors.find((l) => l.where === 'deleteSource')!;
    expect(JSON.stringify(e)).not.toMatch(/u1|p1|x=1/);
    expect(e.name).toContain('example.test');
    expect(String(e.code)).toContain('example.test');
  });

  test('diagnostics reports the storage estimate when the device has one', async () => {
    const withEstimate = (storageEstimate?: () => Promise<{ usage?: number; quota?: number }>) => {
      const service = new SourceService({ storage, fetch: (u, i) => fetch(u, i), now: () => NOW });
      const api = new AppApi({ service, storage, emit: () => undefined, now: () => NOW, appVersion: '1.2.3', ...(storageEstimate ? { storageEstimate } : {}) });
      live.push(api);
      return api;
    };
    expect((await withEstimate().diagnostics()).storage).toBeUndefined();
    expect((await withEstimate(async () => ({ usage: 5, quota: 10 })).diagnostics()).storage).toEqual({ used: 5, quota: 10 });
    expect((await withEstimate(async () => ({})).diagnostics()).storage).toBeUndefined();
    expect((await withEstimate(async () => { throw new Error('no'); }).diagnostics()).storage).toBeUndefined();
  });

  test('non-Error throws are rethrown as scrubbed Errors', async () => {
    class Thrower extends SourceService {
      override listSources(): never {
        throw 'failed at http://example.test/live/u1/p1/1.ts';
      }
    }
    const { api } = make(storage, Thrower);
    const err = await api.listSources().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('example.test');
    expect((err as Error).message).not.toMatch(/u1|p1/);
  });
});

describe('AppApi – background short EPG', () => {
  /** No stored guide; every short-EPG request is recorded by stream id and held until `open()`. */
  const held = () => {
    const g = gate();
    const streams: number[] = [];
    const fetchFn: FetchFn = async (u, i) => {
      if (u.includes('/xmltv.php')) return new Response('', { status: 500 });
      if (u.includes('action=get_short_epg')) {
        streams.push(Number(new URL(u).searchParams.get('stream_id')));
        await g.p;
      }
      return fetch(u, i);
    };
    return { g, streams, fetchFn };
  };
  const streamOf = (id: string) => Number(/:x(\d+)$/.exec(id)?.[1]);

  test('a failing nowNextUpdated listener cannot reject the short-EPG job chain', async () => {
    const service = new SourceService({ shortEpgGapMs: 0, storage, fetch: (u, i) => (u.includes('/xmltv.php')
      ? Promise.resolve(new Response('', { status: 500 }))
      : fetch(u, i)), now: () => NOW });
    const api = new AppApi({
      service, storage, now: () => NOW,
      emit: (e) => { if (e.type === 'nowNextUpdated') throw new Error('listener failed'); },
    });
    await api.addSource(xt());
    await api.idle().catch(() => undefined);
    await api.getPlayable((await api.getChannelSlice('all', 0, 1)).rows[0]!.id);
    await expect(api.idle()).resolves.toBeUndefined();
  });

  test('getEpgRows never starts a short-EPG lookup', async () => {
    const h = held();
    const { api } = make(storage, SourceService, h.fetchFn);
    await api.addSource(xt());
    await api.idle().catch(() => undefined);
    h.g.open();
    const r = await api.getEpgRows('all', 0, 5, NOW, NOW + 3 * 3600_000);
    expect(r.rows).toHaveLength(5);
    await api.idle();
    expect(h.streams).toEqual([]);
  });

  test('getEpgRows shows a cached short-EPG answer for a row without stored programmes, inside the window only', async () => {
    let asked = 0;
    const fetchFn: FetchFn = async (u, i) => {
      if (u.includes('/xmltv.php')) return new Response('', { status: 500 });
      if (u.includes('action=get_short_epg')) {
        asked++;
        return new Response(JSON.stringify({ epg_listings: [
          { title: btoa('Synthetic Now'), start_timestamp: String((NOW - 600_000) / 1000), stop_timestamp: String((NOW + 1_800_000) / 1000) },
          { title: btoa('Synthetic Next'), start_timestamp: String((NOW + 1_800_000) / 1000), stop_timestamp: String((NOW + 3_600_000) / 1000) },
        ] }));
      }
      return fetch(u, i);
    };
    const { api } = make(storage, SourceService, fetchFn);
    await api.addSource(xt());
    await api.idle().catch(() => undefined);
    const [a, b] = (await api.getEpgRows('all', 0, 2, NOW, NOW + 3 * 3600_000)).rows;
    expect(a!.programmes).toEqual([]);
    await api.focusChannel(a!.channel.id);
    await api.idle();
    expect(asked).toBe(1);

    const titles = async (from: number, to: number) =>
      (await api.getEpgRows('all', 0, 2, from, to)).rows.map((r) => r.programmes.map((p) => p.title));
    expect(await titles(NOW, NOW + 3 * 3600_000)).toEqual([['Synthetic Now', 'Synthetic Next'], []]);
    expect(await titles(NOW + 1_800_000, NOW + 3 * 3600_000)).toEqual([['Synthetic Next'], []]);
    expect(await titles(NOW + 2 * 3600_000, NOW + 5 * 3600_000)).toEqual([[], []]);
    expect(b!.programmes).toEqual([]);
    await api.idle();
    expect(asked).toBe(1); // getEpgRows only reads the cache
  });

  test('slices and search never start a short-EPG lookup', async () => {
    const h = held();
    const { api } = make(storage, SourceService, h.fetchFn);
    await api.addSource(xt());
    await api.idle().catch(() => undefined);
    h.g.open();
    await api.getChannelSlice('all', 0, 9);
    await api.getChannelSlice('all', 9, 9);
    await api.search('Channel', 20);
    await api.idle();
    expect(h.streams).toEqual([]);
  });

  test('focusChannel reads nothing for a channel with a stored guide, for a non-Xtream source, or with a fresh short-EPG answer', async () => {
    let reads = 0;
    class Counting extends SourceService {
      override async programmesFor(id: string, channels: Channel[], from: number, to: number): Promise<Map<string, Programme[]>> {
        reads++;
        return super.programmesFor(id, channels, from, to);
      }
    }
    // Xtream with a guide: the focused channel is covered.
    const { api } = make(storage, Counting);
    await api.addSource(xt());
    await api.refresh('epg');
    const id = (await api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    reads = 0;
    await api.focusChannel(id);
    await api.idle();
    expect(reads).toBe(0);

    // M3U (no short EPG exists for it): nothing to look up, with or without a guide.
    const m3u = make(new MemoryStorage(), Counting);
    await m3u.api.addSource({ kind: 'm3u', name: 'Plain', playlistUrl: `${server.url}/get.php?username=test&password=test&type=m3u_plus` });
    await m3u.api.idle().catch(() => undefined);
    const mid = (await m3u.api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    reads = 0;
    await m3u.api.focusChannel(mid);
    await m3u.api.idle();
    expect(reads).toBe(0);

    // Xtream without a guide: the first focus looks up (one read) and asks the short EPG; a fresh answer skips both.
    const h = held();
    const bare = make(new MemoryStorage(), Counting, h.fetchFn);
    await bare.api.addSource(xt());
    await bare.api.idle().catch(() => undefined);
    h.g.open();
    const bid = (await bare.api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    reads = 0;
    await bare.api.focusChannel(bid);
    await bare.api.idle();
    expect(reads).toBe(1);
    expect(h.streams).toEqual([streamOf(bid)]);
    await bare.api.focusChannel(undefined);
    await bare.api.focusChannel(bid);
    await bare.api.idle();
    expect(reads).toBe(1);
    expect(h.streams).toEqual([streamOf(bid)]);
  });

  test('focusChannel still asks the short EPG for a covered channel whose stored guide has run out', async () => {
    // The guide is imported at NOW; two days later every stored programme is in the past, but the channel is still
    // in the coverage. The fallback must not be skipped on coverage alone.
    const st = new MemoryStorage();
    const { api } = make(st);
    await api.addSource(xt());
    await api.refresh('epg');
    const id = (await api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    const h = held();
    const LATER = NOW + 2 * 24 * 3600_000;
    const service = new SourceService({ storage: st, fetch: h.fetchFn, now: () => LATER, shortEpgGapMs: 0 });
    const later = new AppApi({ service, storage: st, emit: () => {}, now: () => LATER, appVersion: '1.2.3' });
    await later.init();
    h.g.open();
    expect((await later.getChannelSlice('all', 0, 1)).rows[0]!.now).toBeUndefined();
    await later.focusChannel(id);
    await later.idle();
    expect(h.streams).toEqual([streamOf(id)]);
  });

  test('focusChannel looks up the focused channel only; a queued one that lost the focus sends no request', async () => {
    const h = held();
    const { api } = make(storage, SourceService, h.fetchFn);
    await api.addSource(xt());
    await api.idle().catch(() => undefined);
    const [a, b, c] = (await api.getChannelSlice('all', 0, 3)).rows.map((r) => r.id);
    await api.focusChannel(a!); // runs (held)
    await settle();
    await api.focusChannel(b!); // waits for the one slot
    await api.focusChannel(c!); // waits; b no longer has the focus
    await settle();
    expect(h.streams).toEqual([streamOf(a!)]);
    h.g.open();
    await api.idle();
    expect(h.streams).toEqual([streamOf(a!), streamOf(c!)]);
  });

  test('the playing channel keeps its lookup while the focus moves on', async () => {
    const h = held();
    const { api } = make(storage, SourceService, h.fetchFn);
    await api.addSource(xt());
    await api.idle().catch(() => undefined);
    const [a, p, b] = (await api.getChannelSlice('all', 0, 3)).rows.map((r) => r.id);
    await api.focusChannel(a!); // runs (held)
    await settle();
    await api.getPlayable(p!); // waits; p is the playing channel
    await api.focusChannel(b!); // waits; the focus left a, which already ran
    h.g.open();
    await api.idle();
    expect(h.streams).toHaveLength(3);
    expect(new Set(h.streams)).toEqual(new Set([a!, p!, b!].map(streamOf)));
  });

  test('a settings change makes a queued lookup stale', async () => {
    const h = held();
    const { api } = make(storage, SourceService, h.fetchFn);
    await api.addSource(xt());
    await api.idle().catch(() => undefined);
    const [a, b] = (await api.getChannelSlice('all', 0, 2)).rows.map((r) => r.id);
    await api.focusChannel(a!); // runs (held)
    await settle();
    await api.focusChannel(b!); // waits
    await settle();
    await api.saveSettings({ epgOffsetHours: 1 });
    h.g.open();
    await api.idle();
    expect(h.streams).toEqual([streamOf(a!)]);
  });

  test('an answer is kept until its programme ends; nothing found is kept for 15 minutes', async () => {
    let t = NOW;
    const asked: number[] = [];
    const fetchFn: FetchFn = async (u, i) => {
      if (u.includes('/xmltv.php')) return new Response('', { status: 500 });
      if (u.includes('action=get_short_epg')) {
        const stream = Number(new URL(u).searchParams.get('stream_id'));
        asked.push(stream);
        // Odd streams: one programme until NOW + 30 min. Even streams: nothing.
        const listings = stream % 2 === 1 ? [{
          title: btoa('Synthetic Show'), start_timestamp: String((NOW - 60_000) / 1000), stop_timestamp: String((NOW + 30 * 60_000) / 1000),
        }] : [];
        return new Response(JSON.stringify({ epg_listings: listings }));
      }
      return fetch(u, i);
    };
    const service = new SourceService({ shortEpgGapMs: 0, storage, fetch: fetchFn, now: () => t });
    const api = new AppApi({ service, storage, emit: () => undefined, now: () => t });
    live.push(api);
    await api.addSource(xt());
    await api.idle().catch(() => undefined);
    const rows = (await api.getChannelSlice('all', 0, 2)).rows;
    const odd = rows.find((r) => streamOf(r.id) % 2 === 1)!.id;
    const even = rows.find((r) => streamOf(r.id) % 2 === 0)!.id;
    const ask = async (id: string) => { await api.focusChannel(id); await api.idle(); };

    await ask(odd);
    await ask(odd);
    expect(asked).toEqual([streamOf(odd)]);
    expect((await api.getChannelSlice('all', 0, 2)).rows.find((r) => r.id === odd)?.now?.title).toBe('Synthetic Show');
    t = NOW + 29 * 60_000;
    await ask(odd);
    expect(asked).toHaveLength(1);
    t = NOW + 31 * 60_000; // the programme ended
    await ask(odd);
    expect(asked).toHaveLength(2);

    await ask(even);
    expect(asked).toHaveLength(3);
    t += 14 * 60_000;
    await ask(even);
    expect(asked).toHaveLength(3);
    t += 2 * 60_000;
    await ask(even);
    expect(asked).toHaveLength(4);
  });
  test('zapping never waits on the short-EPG lookup, and skips it when the row already has now/next', async () => {
    let hold: Promise<void> | undefined;
    let reads = 0;
    class Slow extends SourceService {
      override async programmesFor(id: string, channels: Channel[], from: number, to: number): Promise<Map<string, Programme[]>> {
        reads++;
        if (hold) await hold;
        return super.programmesFor(id, channels, from, to);
      }
    }
    const fetchFn: FetchFn = (u, i) => (u.includes('/xmltv.php') ? Promise.resolve(new Response('', { status: 500 })) : fetch(u, i));
    const { api } = make(storage, Slow, fetchFn);
    await api.addSource(xt());
    await api.idle().catch(() => undefined);
    const id = (await api.getChannelSlice('all', 0, 3)).rows[0]!.id; // now/next cached (empty) for these rows
    let release!: () => void;
    hold = new Promise((r) => { release = r; });
    const zap = await Promise.race([api.getPlayable(id), settle().then(() => 'waiting' as const)]);
    expect(zap).not.toBe('waiting');
    hold = undefined;
    release();
    await api.idle();
    const before = reads;
    expect((await api.getPlayable(id))?.now?.title).toMatch(/^Programme /);
    await api.idle();
    expect(reads).toBe(before);
  });

  test('a source switch clears the playing channel', async () => {
    let t = NOW;
    let g: ReturnType<typeof gate> | undefined;
    const streams: number[] = [];
    const fetchFn: FetchFn = async (u, i) => {
      if (u.includes('/xmltv.php')) return new Response('', { status: 500 });
      if (u.includes('action=get_short_epg')) {
        streams.push(Number(new URL(u).searchParams.get('stream_id')));
        if (!g) return new Response('', { status: 500 });
        await g.p;
      }
      return fetch(u, i);
    };
    const service = new SourceService({ shortEpgGapMs: 0, storage, fetch: fetchFn, now: () => t });
    const api = new AppApi({ service, storage, emit: () => undefined, now: () => t });
    live.push(api);
    const { sourceId: first } = await api.addSource(xt());
    await api.idle().catch(() => undefined);
    const [x, a, y] = (await api.getChannelSlice('all', 0, 3)).rows.map((r) => r.id);
    await api.getPlayable(a!); // nothing found (HTTP 500): cached for 15 min
    await api.idle();
    expect(streams).toEqual([streamOf(a!)]);
    t += 16 * 60_000; // that answer expired
    const { sourceId: second } = await api.addSource(xt());
    await api.setActiveSource(second);
    await api.setActiveSource(first);
    await api.idle().catch(() => undefined);
    streams.length = 0;
    g = gate();
    await api.focusChannel(x!); // runs (held)
    await settle();
    await api.focusChannel(a!); // waits
    await api.focusChannel(y!); // waits; a lost the focus and stopped being the playing channel at the switch
    await settle();
    g.open();
    await api.idle();
    expect(streams).toEqual([streamOf(x!), streamOf(y!)]);
  });

  test('a failed lookup (HTTP 500) counts as nothing found: no new request within 15 minutes', async () => {
    let t = NOW;
    const asked: number[] = [];
    const fetchFn: FetchFn = async (u, i) => {
      if (u.includes('/xmltv.php')) return new Response('', { status: 500 });
      if (u.includes('action=get_short_epg')) {
        asked.push(Number(new URL(u).searchParams.get('stream_id')));
        return new Response('', { status: 500 });
      }
      return fetch(u, i);
    };
    const service = new SourceService({ shortEpgGapMs: 0, storage, fetch: fetchFn, now: () => t });
    const api = new AppApi({ service, storage, emit: () => undefined, now: () => t });
    live.push(api);
    await api.addSource(xt());
    await api.idle().catch(() => undefined);
    const id = (await api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    const ask = async () => { await api.focusChannel(id); await api.idle(); };
    await ask();
    expect(asked).toEqual([streamOf(id)]);
    t += 14 * 60_000;
    await ask();
    expect(asked).toHaveLength(1);
    t += 2 * 60_000;
    await ask();
    expect(asked).toHaveLength(2);
  });
});

describe('AppApi – stream format memory', () => {
  test('the format that played last on a source is tried first, also after a restart', async () => {
    const { api } = make();
    await api.addSource(xt());
    const id = (await api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    expect((await api.getPlayable(id))!.url).toMatch(/\.ts$/);
    await api.notePlayed(id, 'm3u8'); // the .m3u8 alternate played
    const p = (await api.getPlayable(id))!;
    expect(p.url).toMatch(/\.m3u8$/);
    expect(p.alternateUrl).toMatch(/\.ts$/);
    const { api: again } = make();
    await again.init();
    expect((await again.getPlayable(id))!.url).toMatch(/\.m3u8$/);
  });

  test('changing the preferred format wins over the memo', async () => {
    const { api } = make();
    await api.addSource(xt());
    const id = (await api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    await api.notePlayed(id, 'm3u8'); // m3u8 played while TS was preferred
    await api.saveSettings({ preferredFormat: 'm3u8' });
    expect((await api.getPlayable(id))!.url).toMatch(/\.m3u8$/);
    await api.notePlayed(id, 'ts'); // now the .ts alternate played
    expect((await api.getPlayable(id))!.url).toMatch(/\.ts$/);
    await api.saveSettings({ preferredFormat: 'ts' });
    expect((await api.getPlayable(id))!.url).toMatch(/\.ts$/);
  });

  test('the memo holds a format name only and goes with its source', async () => {
    const { api } = make();
    const { sourceId } = await api.addSource(xt());
    const id = (await api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    await api.notePlayed(id, 'm3u8');
    expect(await storage.getMeta(`streamFormat:${sourceId}`)).toEqual({ format: 'm3u8', pref: 'ts' });
    await api.deleteSource(sourceId);
    expect(await storage.getMeta(`streamFormat:${sourceId}`)).toBeNull();
  });

  test('a report with an unknown format name is ignored', async () => {
    const { api } = make();
    const { sourceId } = await api.addSource(xt());
    const id = (await api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    await api.notePlayed(id, 'mp4' as unknown as 'ts');
    expect(await storage.getMeta(`streamFormat:${sourceId}`)).toBeUndefined();
    expect((await api.getPlayable(id))!.url).toMatch(/\.ts$/);
  });

  test('a report that races the deletion of its source leaves no key behind', async () => {
    const { api } = make();
    const { sourceId } = await api.addSource(xt());
    const id = (await api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    const g = gate();
    const getMeta = storage.getMeta.bind(storage);
    vi.spyOn(storage, 'getMeta').mockImplementation(async (key: string) => {
      if (key === `streamFormat:${sourceId}`) await g.p;
      return getMeta(key);
    });
    const report = api.notePlayed(id, 'm3u8');
    await api.deleteSource(sourceId);
    g.open();
    await report;
    expect(await getMeta(`streamFormat:${sourceId}`)).toBeNull();
  });

  test('a native .m3u8 channel URL is swapped to .ts first when TS played last', async () => {
    const playlist = '#EXTM3U\n#EXTINF:-1 group-title="News",Synthetic One\nhttp://example.test/live/u/p/7.m3u8\n';
    const fetchFn: FetchFn = async (u, i) => (u === 'http://example.test/p.m3u' ? new Response(playlist) : fetch(u, i));
    const { api } = make(storage, SourceService, fetchFn);
    await api.addSource({ kind: 'm3u', name: 'Plain', playlistUrl: 'http://example.test/p.m3u' });
    await api.saveSettings({ preferredFormat: 'm3u8' });
    const id = (await api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    expect((await api.getPlayable(id))!.url).toBe('http://example.test/live/u/p/7.m3u8');
    await api.notePlayed(id, 'ts');
    const p = (await api.getPlayable(id))!;
    expect(p.url).toBe('http://example.test/live/u/p/7.ts');
    expect(p.alternateUrl).toBe('http://example.test/live/u/p/7.m3u8');
  });
});

describe('AppApi – init reads', () => {
  /** Counts `getMeta` reads by key and the most reads in flight at once (serial awaits never overlap). */
  class CountingStorage extends MemoryStorage {
    reads = new Map<string, number>();
    inFlight = 0;
    peak = 0;
    override async getMeta<T>(key: string) {
      this.reads.set(key, (this.reads.get(key) ?? 0) + 1);
      this.inFlight++;
      this.peak = Math.max(this.peak, this.inFlight);
      await new Promise((r) => setTimeout(r, 1));
      try { return await super.getMeta<T>(key); } finally { this.inFlight--; }
    }
  }

  test('init reads parseStats once and overlaps the independent state reads', async () => {
    const st = new CountingStorage();
    const { sourceId } = await seeded(st);
    st.reads.clear();
    st.peak = 0;
    const { api } = make(st);
    const state = await api.init();
    await api.idle();
    expect(state.activeSourceId).toBe(sourceId);
    expect(st.reads.get(`parseStats:${sourceId}`)).toBe(1);
    // parseStats, lastChannel, lastGroup and the cooldown status go out together (settings is already cached).
    expect(st.peak).toBeGreaterThanOrEqual(4);
  });

  test('init with a lost channel cache reads parseStats once for the state and once for the refill decision', async () => {
    const st = new CountingStorage();
    const { sourceId } = await seeded(st);
    await st.replaceChannels(sourceId, []);
    st.reads.clear();
    const { api } = make(st);
    const state = await api.init();
    await api.idle();
    expect(state.activeSourceId).toBe(sourceId);
    expect(st.reads.get(`parseStats:${sourceId}`)).toBe(2);
    expect((await api.getGroups()).find((g) => g.id === 'all')?.count).toBe(40);
  });
});

describe('AppApi – layout', () => {
  type Changed = Extract<AppEvent, { type: 'layoutChanged' }>;
  const changes = (events: AppEvent[]) => events.filter((e): e is Changed => e.type === 'layoutChanged');

  test('v1 flags are migrated to a stored layout on first load', async () => {
    const { seed, sourceId } = await seeded();
    const rows = (await seed.getChannelSlice('all', 0, 3)).rows;
    await storage.setMeta(`layout:${sourceId}`, null);
    await storage.setMeta(`flags:${sourceId}`, { favourites: [rows[0]!.id], hidden: [rows[1]!.id], recent: [rows[2]!.id] });
    const { api } = make();
    const state = await api.init();
    expect(state.groups.find((g) => g.id === 'fav')?.count).toBe(1);
    expect(state.groups.find((g) => g.id === 'all')?.count).toBe(39);
    expect(state.groups.find((g) => g.id === 'recent')?.count).toBe(1);
    const layout = await api.getLayout();
    expect(layout.lists[0]!.channelIds).toEqual([rows[0]!.id]);
    expect(await storage.getMeta(`layout:${sourceId}`)).toEqual(layout);
  });

  test('ops round trip: lists, renames and hidden groups persist across a new instance', async () => {
    const { api } = make();
    await api.addSource(xt());
    const [a, b] = (await api.getChannelSlice('g:News', 0, 2)).rows.map((r) => r.id);
    const res = await api.applyLayoutOps([
      { op: 'createList', id: 'evening', name: 'Evening' },
      { op: 'addToList', listId: 'evening', channelIds: [a!, b!] },
      { op: 'renameChannel', id: a!, name: 'Morning desk' },
      { op: 'hideGroups', ids: ['g:Kids'] },
    ]);
    expect(res).toEqual({ version: 1, rejected: [] });
    const groups = await api.getGroups();
    expect(groups.find((g) => g.id === 'list:evening')).toEqual({ id: 'list:evening', name: 'Evening', count: 2 });
    expect(groups.some((g) => g.id === 'g:Kids')).toBe(false);
    expect((await api.getChannelSlice('list:evening', 0, 5)).rows[0]!.name).toBe('Morning desk');
    expect(await api.listLists()).toEqual([
      { id: 'fav', groupId: 'fav', name: 'Favourites', count: 0 },
      { id: 'evening', groupId: 'list:evening', name: 'Evening', count: 2 },
    ]);
    expect(await api.channelLists(a!)).toEqual(['evening']);
    expect(await api.channelLists('nope')).toEqual([]);
    expect((await api.hiddenGroups()).map((g) => g.id)).toEqual(['g:Kids']);
    expect((await api.providerGroups()).map((g) => [g.id, g.hidden])).toEqual([
      ['g:News', false], ['g:Movies', false], ['g:Kids', true], ['g:Music', false],
    ]);
    await api.idle();

    const { api: again } = make();
    const state = await again.init();
    expect(state.groups.find((g) => g.id === 'list:evening')?.count).toBe(2);
    expect(await again.getLayout()).toEqual(await api.getLayout());
    expect((await again.getChannelSlice('list:evening', 0, 1)).rows[0]!.name).toBe('Morning desk');
  });

  test('layout edits stamp the sync clock; zapping (markWatched) never writes sync state', async () => {
    const { api } = make();
    await api.addSource(xt());
    const sourceId = (await api.init()).activeSourceId!;
    const id = (await api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    await api.markWatched(id, 'all');
    expect(await storage.listSyncMeta(sourceId)).toEqual([]);
    await api.toggleFavourite(id);
    await api.applyLayoutOps([{ op: 'hideChannels', ids: [id] }]);
    await api.idle(); // stamps are stored after the layout write, batched
    expect((await storage.listSyncMeta(sourceId)).map((e) => e.key).sort()).toEqual([`hc:${id}`, `lm:fav|${id}`, 'lq:fav']);
  });

  test('a bulk layout edit returns after the layout write, not after its sync stamps', async () => {
    const { api } = make();
    await api.addSource(xt());
    const sourceId = (await api.init()).activeSourceId!;
    const put = storage.putSyncMeta.bind(storage);
    const held = gate();
    storage.putSyncMeta = async (e) => { await held.p; return put(e); };
    const ids = Array.from({ length: 50_000 }, (_, i) => `${sourceId}:x${900_000 + i}`);
    const t0 = performance.now();
    await api.applyLayoutOps([{ op: 'hideChannels', ids }]);
    const ms = performance.now() - t0;
    expect((await api.getLayout()).hiddenChannels).toHaveLength(50_000);
    expect(await storage.listSyncMeta(sourceId)).toEqual([]); // still held
    // A later edit queues behind it and gets the later stamp.
    await api.applyLayoutOps([{ op: 'unhideChannels', ids: [ids[0]!] }]);
    held.open();
    await api.idle();
    const meta = new Map((await storage.listSyncMeta(sourceId)).map((e) => [e.key, e.value as string]));
    expect(meta.size).toBe(50_000);
    expect(meta.get(`hc:${ids[0]}`)! > meta.get(`hc:${ids[1]}`)!).toBe(true);
    console.info(`hideChannels 50k ids: ${ms.toFixed(0)} ms to return`);
    expect(ms).toBeLessThan(2000);
  });

  test('layoutChanged carries the version and origin; no-op batches emit nothing', async () => {
    const { api, events } = make();
    await api.addSource(xt());
    const id = (await api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    await api.applyLayoutOps([{ op: 'hideChannels', ids: [id] }]);
    await api.applyLayoutOps([{ op: 'unhideChannels', ids: [id] }], 'remote');
    await api.applyLayoutOps([{ op: 'unhideChannels', ids: [id] }], 'remote');
    expect(await api.toggleFavourite(id)).toBe(true);
    expect(changes(events)).toEqual([
      { type: 'layoutChanged', version: 1, origin: 'local' },
      { type: 'layoutChanged', version: 2, origin: 'remote' },
      { type: 'layoutChanged', version: 3, origin: 'local' },
    ]);
    expect((await api.getLayout()).version).toBe(3);
  });

  test('invalid and refused ops are reported as rejected; valid ones still apply', async () => {
    const { api, events } = make();
    await api.addSource(xt());
    const [id, other] = (await api.getChannelSlice('all', 0, 2)).rows.map((r) => r.id);
    const res = await api.applyLayoutOps([
      { op: 'hideChannels', ids: [id!] },
      { op: 'bogus' } as unknown as LayoutOp,
      { op: 'deleteList', listId: 'fav' },
      { op: 'addToList', listId: 'fav', channelIds: [other!] },
    ]);
    expect(res.version).toBe(1);
    expect(res.rejected.map((r) => r.index)).toEqual([1, 2]);
    for (const r of res.rejected) expect(r.reason).toEqual(expect.any(String));
    expect((await api.getChannelSlice('fav', 0, 5)).total).toBe(1);
    expect(changes(events)).toHaveLength(1);
  });

  test('a batch over MAX_OPS_PER_BATCH is rejected whole', async () => {
    const { api, events } = make();
    await api.addSource(xt());
    const id = (await api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    const ops: LayoutOp[] = Array.from({ length: MAX_OPS_PER_BATCH + 1 }, () => ({ op: 'hideChannels', ids: [id] }));
    const res = await api.applyLayoutOps(ops);
    expect(res.version).toBe(0);
    expect(res.rejected).toHaveLength(MAX_OPS_PER_BATCH + 1);
    expect((await api.getChannelSlice('all', 0, 1)).total).toBe(40);
    expect(changes(events)).toEqual([]);
    expect(await api.applyLayoutOps('nope' as unknown as LayoutOp[]))
      .toEqual({ version: 0, rejected: [{ index: 0, reason: expect.any(String) }] });
  });

  test('ops scoped to a source that is no longer active fail with WrongSource and change nothing', async () => {
    const { api, events } = make();
    const { sourceId: a } = await api.addSource(xt());
    const { sourceId: b } = await api.addSource({ ...xt(), name: 'Second' });
    await api.setActiveSource(b);
    const before = await api.getLayout();
    const err = await api.applyLayoutOps([{ op: 'setHideNoEpg', value: true }], 'remote', a).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('WrongSource');
    expect((err as Error).message).toBe('The TV switched to another source.');
    expect(await api.getLayout()).toEqual(before);
    expect(changes(events)).toEqual([]);
    // The active source's id is accepted.
    expect((await api.applyLayoutOps([{ op: 'setHideNoEpg', value: true }], 'remote', b)).rejected).toEqual([]);
  });

  test('getActiveLayout returns the active source id with its layout', async () => {
    const { api } = make();
    expect(await api.getActiveLayout()).toEqual({ sourceId: undefined, layout: expect.objectContaining({ version: 0 }) });
    const { sourceId } = await api.addSource(xt());
    await api.applyLayoutOps([{ op: 'setHideNoEpg', value: true }]);
    const got = await api.getActiveLayout();
    expect(got.sourceId).toBe(sourceId);
    expect(got.layout).toEqual(await api.getLayout());
  });

  test('a batch that only touched recently watched is flagged recentOnly', async () => {
    const { api, events } = make();
    await api.addSource(xt());
    const id = (await api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    await api.markWatched(id, 'all');
    await api.applyLayoutOps([{ op: 'hideChannels', ids: [id] }]);
    expect(changes(events)).toEqual([
      { type: 'layoutChanged', version: 1, origin: 'local', recentOnly: true },
      { type: 'layoutChanged', version: 2, origin: 'local' },
    ]);
  });

  test('without an active source every op is rejected', async () => {
    const { api } = make();
    await api.init();
    const res = await api.applyLayoutOps([{ op: 'setHideNoEpg', value: true }]);
    expect(res).toEqual({ version: 0, rejected: [{ index: 0, reason: expect.any(String) }] });
  });

  test('renaming a channel keeps its guide when the guide matched it by name', async () => {
    const playlist = ['#EXTM3U', '#EXTINF:-1 group-title="News",Channel 001', 'http://example.test/live/1.ts', ''].join('\n');
    const fetchFn: FetchFn = async (u, i) => (u === 'http://example.test/p.m3u' ? new Response(playlist) : fetch(u, i));
    const { api } = make(storage, SourceService, fetchFn);
    await api.addSource({
      kind: 'm3u', name: 'By name', playlistUrl: 'http://example.test/p.m3u',
      epgUrl: `${server.url}/xmltv.php?username=test&password=test`,
    });
    await api.refresh('epg');
    const id = (await api.getChannelSlice('all', 0, 1)).rows[0]!.id;
    expect((await api.getChannelSlice('all', 0, 1)).rows[0]!.now).toBeDefined();
    await api.applyLayoutOps([{ op: 'renameChannel', id, name: 'Something else' }]);
    const row = (await api.getChannelSlice('all', 0, 1)).rows[0]!;
    expect(row.name).toBe('Something else');
    expect(row.now?.title).toMatch(/^Programme /);
    const epg = await api.getEpgRows('all', 0, 1, NOW, NOW + 3600_000);
    expect(epg.rows[0]!.programmes.length).toBeGreaterThan(0);
  });

  describe('with a partial guide', () => {
    let partial: Awaited<ReturnType<typeof startFakeXtream>>;
    beforeAll(async () => { partial = await startFakeXtream({ port: 0, channels: 40, epgChannels: 10, now: () => NOW }); });
    afterAll(async () => { await partial.close(); });
    const px = () => ({ kind: 'xtream' as const, name: 'Partial', server: partial.url, username: 'test', password: 'test' });

    test('hideNoEpg hides channels without guide data once coverage is known; lists keep them', async () => {
      const gated = gate();
      const fetchFn: FetchFn = async (u, i) => {
        if (u.includes('/xmltv.php')) await gated.p;
        return fetch(u, i);
      };
      const { api } = make(storage, SourceService, fetchFn);
      await api.addSource(px());
      const last = (await api.getChannelSlice('all', 39, 1)).rows[0]!.id;
      await api.applyLayoutOps([{ op: 'setHideNoEpg', value: true }, { op: 'addToList', listId: 'fav', channelIds: [last] }]);
      // Guide not loaded yet: coverage unknown, nothing is hidden.
      expect((await api.getChannelSlice('all', 0, 1)).total).toBe(40);
      expect((await api.getCompanionState()).channels.every((c) => c.hasEpg)).toBe(true);
      gated.open();
      await api.idle();
      expect((await api.getChannelSlice('all', 0, 1)).total).toBe(10);
      expect((await api.getChannelSlice('fav', 0, 5)).rows.map((r) => r.id)).toEqual([last]);
      await api.applyLayoutOps([{ op: 'setHideNoEpg', value: false }]);
      expect((await api.getChannelSlice('all', 0, 1)).total).toBe(40);

      const { api: again } = make();
      await again.init();
      await again.applyLayoutOps([{ op: 'setHideNoEpg', value: true }]);
      expect((await again.getChannelSlice('all', 0, 1)).total).toBe(10);
    });

    test('getCompanionState lists every channel, hidden ones included, with hasEpg and no credentials', async () => {
      const { api } = make();
      await api.addSource(px());
      await api.refresh('epg');
      const [a, b] = (await api.getChannelSlice('all', 0, 2)).rows.map((r) => r.id);
      await api.applyLayoutOps([
        { op: 'hideChannels', ids: [a!] },
        { op: 'hideGroups', ids: ['g:Movies'] },
        { op: 'renameChannel', id: b!, name: 'Renamed' },
      ]);
      const state = await api.getCompanionState();
      expect(state.version).toBe(1);
      expect(state.activeSourceId).toBe((await api.listSources())[0]!.id);
      expect(state.channels).toHaveLength(40);
      expect(state.channels.some((c) => c.id === a)).toBe(true);
      expect(state.channels.filter((c) => c.group === 'Movies')).toHaveLength(10);
      const renamed = state.channels.find((c) => c.id === b)!;
      expect(renamed.displayName).toBe('Renamed');
      expect(renamed.name).not.toBe('Renamed');
      expect(state.channels.filter((c) => c.hasEpg)).toHaveLength(10);
      expect(state.groups.find((g) => g.id === 'g:Movies')).toMatchObject({ hidden: true, count: 10 });
      expect(state.layout).toEqual(await api.getLayout());
      for (const s of state.sources) {
        expect(Object.keys(s).sort()).toEqual(['active', 'id', 'kind', 'name']);
        expect(s).not.toHaveProperty('password');
        expect(s).not.toHaveProperty('username');
      }
      const json = JSON.stringify(state);
      expect(json).not.toContain('password');
      expect(json).not.toContain('username');
      expect(json).not.toContain('/live/');
      expect(json).not.toContain(partial.url);
    });
  });
});

describe('AppApi – sourcesChanged', () => {
  type Changed = Extract<AppEvent, { type: 'sourcesChanged' }>;
  const changes = (events: AppEvent[]) => events.filter((e): e is Changed => e.type === 'sourcesChanged');

  test('every source operation announces the new active source with the caller origin', async () => {
    const { api, events } = make();
    const a = await api.addSource(xt());
    expect(changes(events)).toEqual([{ type: 'sourcesChanged', activeSourceId: a.sourceId, origin: 'local' }]);
    await api.idle();

    events.length = 0;
    const b = await api.addSource({ ...xt(), name: 'Second' }, 'remote');
    await api.idle();
    // The first source stays active; the list still changed.
    expect(changes(events)).toEqual([{ type: 'sourcesChanged', activeSourceId: a.sourceId, origin: 'remote' }]);

    events.length = 0;
    await api.setActiveSource(b.sourceId, 'remote');
    await api.idle();
    expect(changes(events)).toEqual([{ type: 'sourcesChanged', activeSourceId: b.sourceId, origin: 'remote' }]);

    events.length = 0;
    await api.setActiveSource(a.sourceId);
    await api.idle();
    expect(changes(events)).toEqual([{ type: 'sourcesChanged', activeSourceId: a.sourceId, origin: 'local' }]);

    events.length = 0;
    const cfg = (await api.getSource(a.sourceId))!;
    await api.updateSource({ ...cfg, name: 'Renamed' }, 'remote');
    await api.idle();
    expect(changes(events)).toEqual([{ type: 'sourcesChanged', activeSourceId: a.sourceId, origin: 'remote' }]);

    events.length = 0;
    await api.deleteSource(a.sourceId, 'remote');
    await api.idle();
    expect(changes(events)).toEqual([{ type: 'sourcesChanged', activeSourceId: b.sourceId, origin: 'remote' }]);

    events.length = 0;
    await api.deleteSource(b.sourceId);
    await api.idle();
    // No source left: the event carries no activeSourceId.
    expect(changes(events)).toEqual([{ type: 'sourcesChanged', origin: 'local' }]);
  });

  test('a failed operation announces nothing; an unknown origin counts as local', async () => {
    const { api, events } = make();
    await expect(api.addSource(xt('wrong', 'creds'))).rejects.toBeDefined();
    expect(changes(events)).toEqual([]);
    const { sourceId } = await api.addSource(xt(), 'bogus' as unknown as 'local');
    await api.idle();
    expect(changes(events)).toEqual([{ type: 'sourcesChanged', activeSourceId: sourceId, origin: 'local' }]);
  });
});

describe('scrub', () => {
  test('removes Xtream credentials from stream paths and queries', () => {
    const out = scrub('Could not open http://example.test/live/u1/p1/1.ts for playback');
    expect(out).toContain('example.test');
    expect(out).not.toContain('u1');
    expect(out).not.toContain('p1');
    const q = scrub('GET http://example.test/player_api.php?username=u1&password=p1 failed');
    expect(q).not.toMatch(/u1|p1/);
  });
});

describe('APP_API_METHODS', () => {
  test('lists the public API methods only', () => {
    for (const m of ['init', 'refresh', 'getChannelSlice', 'toggleFavourite', 'diagnostics', 'clearCache']) {
      expect(APP_API_METHODS).toContain(m);
    }
    for (const m of APP_API_METHODS) expect(typeof (AppApi.prototype as unknown as Record<string, unknown>)[m]).toBe('function');
    for (const m of ['idle', 'run', 'record', 'activate', 'constructor']) expect(APP_API_METHODS).not.toContain(m);
    expect(new Set(APP_API_METHODS).size).toBe(APP_API_METHODS.length);
  });
});

describe('AppApi VOD', () => {
  test('without a VodService every VOD call rejects clearly', async () => {
    const { api } = make();
    await expect(api.getVodHome('movie')).rejects.toThrow('Movies and series are not available.');
  });

  test('home loads in the background and is ready after the fetch', async () => {
    const { api, events } = makeVod();
    await api.addSource(xt());
    expect((await api.getVodHome('movie')).status).toBe('loading');
    await api.idle();
    expect(events.some((e) => e.type === 'vodRefreshed')).toBe(true);
    const home = await api.getVodHome('movie');
    expect(home.status).toBe('ready');
    const first = home.rows.find((r) => r.items.length)!.items[0]!;
    expect((await api.getMovie(first.id))?.tile.id).toBe(first.id);
    expect((await api.getVodPlayable(first.id))?.url).toContain('/movie/');
  });

  test("a VOD playable carries its host's cooldown key and, once refused, the cooldown", async () => {
    const { api } = makeVod();
    const { sourceId } = await api.addSource(xt());
    await api.getVodHome('movie');
    await api.idle();
    const first = (await api.getVodHome('movie')).rows.find((r) => r.items.length)!.items[0]!;
    const p = (await api.getVodPlayable(first.id))!;
    expect(p.cooldownKey).toBe(`${sourceId}@${new URL(server.url).host}`);
    await api.reportStreamRefused(sourceId, p.url);
    expect((await api.getVodPlayable(first.id))?.cooldown).toEqual({ state: 'waiting', until: NOW + 120_000, reason: 'refused' });
  });

  test('search folders: the resident catalogue\'s categories, prefix first; none for a kind that is not resident', async () => {
    const { api } = makeVod();
    await api.addSource(xt());
    await api.refreshVod('movie');
    // getVodCategories also returns virtual shelves (continue, favourites, recent, all, and `vod:`-prefixed ids);
    // only the provider's own categories may be folder hits, so those are excluded from the expectation.
    const real = (await api.getVodCategories('movie')).filter((c) => !['continue','favourites', 'recent', 'all'].includes(c.id) && !c.id.startsWith('vod:'));
    const first = real[0]!;
    const q = first.name.slice(0, 3).toLowerCase();
    const hits = (await api.search(q, 50)).folders.filter((f) => f.kind === 'movie');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.name.toLowerCase().includes(q))).toBe(true);
    expect(hits.some((h) => ['continue', 'favourites', 'recent', 'all'].includes(h.id) || h.id.startsWith('vod:'))).toBe(false);
    expect((await api.search(q, 50)).folders.filter((f) => f.kind === 'series')).toEqual([]);
  });

  test('switching source resets VOD state', async () => {
    const { api, vod } = makeVod();
    const { sourceId: a } = await api.addSource(xt());
    await api.refreshVod('movie');
    const { sourceId: b } = await api.addSource({ ...xt(), name: 'Second' });
    await api.setActiveSource(b);
    const spy = vi.spyOn(vod, 'storedCatalog');
    await api.getVodCategories('movie');
    expect(spy.mock.calls[0]).toEqual([b, 'movie']);
    await api.setActiveSource(a);
    await api.preloadVod('movie');
    expect(spy.mock.calls.at(-1)).toEqual([a, 'movie']);
  });

  test('an unknown sort order is rejected', async () => {
    const { api } = makeVod();
    await api.addSource(xt());
    await expect(api.getVodSlice('movie', 'all', 'bogus' as never, 0, 10)).rejects.toThrow('Unknown sort order.');
    for (const sort of ['added', 'title', 'rating'] as const) await expect(api.getVodSlice('movie', 'all', sort, 0, 1)).resolves.toBeDefined();
  });

  test('deleting the active source resets VOD state to the next one', async () => {
    const { api, vod } = makeVod();
    const { sourceId: a } = await api.addSource(xt());
    const { sourceId: b } = await api.addSource({ ...xt(), name: 'Second' });
    await api.refreshVod('movie');
    await api.deleteSource(a);
    const spy = vi.spyOn(vod, 'storedCatalog');
    await api.getVodCategories('movie');
    expect(spy.mock.calls[0]).toEqual([b, 'movie']);
  });

  test('updating the active source resets VOD state (the catalogue is read again)', async () => {
    const { api, vod } = makeVod();
    const { sourceId: a } = await api.addSource(xt());
    await api.refreshVod('movie');
    const spy = vi.spyOn(vod, 'storedCatalog');
    await api.getVodCategories('movie');
    expect(spy).toHaveBeenCalledTimes(0);
    await api.updateSource({ ...(await api.getSource(a))!, name: 'Renamed' });
    await api.getVodCategories('movie');
    expect(spy.mock.calls[0]).toEqual([a, 'movie']);
  });

  test('updating the active source cancels its in-flight VOD fetch before the source is rewritten', async () => {
    const hold = gate();
    let holding = false;
    let heldStreams = 0;
    const fetchFn: FetchFn = async (u, i) => {
      if (holding && /action=get_vod_streams/.test(u)) { heldStreams++; await hold.p; }
      // The rewrite's own requests start while the VOD fetch waits: let the VOD fetch finish during them.
      else if (holding && heldStreams > 0 && !/action=get_(vod|series)/.test(u)) {
        hold.open();
        await new Promise((r) => setTimeout(r, 150));
      }
      return fetch(u, i);
    };
    const { api, events } = makeVod(storage, fetchFn);
    const { sourceId: a } = await api.addSource(xt());
    holding = true;
    expect((await api.getVodHome('movie')).status).toBe('loading');
    await vi.waitFor(() => expect(heldStreams).toBeGreaterThan(0));
    await api.updateSource({ ...(await api.getSource(a))!, name: 'Renamed' });
    hold.open();
    await api.idle();
    expect(events.some((e) => e.type === 'vodRefreshed')).toBe(false);
    expect(await storage.getVod(a, 'movie')).toBeUndefined();
  });

  test('an episode whose series detail fails is recorded once', async () => {
    let failInfo = false;
    const fetchFn: FetchFn = async (u, i) => {
      if (failInfo && /action=get_series_info/.test(u)) throw new TypeError('fetch failed');
      return fetch(u, i);
    };
    const { api } = makeVod(storage, fetchFn);
    await api.addSource(xt());
    await api.refreshVod('series');
    const show = (await api.getVodSlice('series', 'all', 'title', 0, 1)).rows[0]!;
    failInfo = true;
    await expect(api.getVodPlayable(`${show.id}:e1`, show.id)).rejects.toBeInstanceOf(Error);
    const mine = (await api.diagnostics()).lastErrors.filter((e) => e.where === 'getVodPlayable' || e.where === 'getVodDetail' || e.where === 'refreshVod');
    expect(mine.map((e) => e.where)).toEqual(['getVodDetail']);
  });

  test('M3U: a playlist refresh reloads the catalogue and announces both kinds', async () => {
    const { api, events, vod } = makeVod();
    await api.addSource({ kind: 'm3u', name: 'Fake M3U', playlistUrl: `${server.url}/get.php?username=test&password=test&type=m3u_plus` });
    expect((await api.getVodHome('movie')).status).toBe('ready');
    await api.idle();
    events.length = 0;
    const spy = vi.spyOn(vod, 'storedCatalog');
    await api.refresh('playlist');
    const refreshed = events.filter((e) => e.type === 'vodRefreshed');
    expect(refreshed.map((e) => (e as { kind: string }).kind).sort()).toEqual(['movie', 'series']);
    expect(refreshed[0]).toMatchObject({ truncated: false });
    expect((refreshed.find((e) => (e as { kind: string }).kind === 'movie') as { count: number }).count).toBeGreaterThan(0);
    await api.idle();
    const before = spy.mock.calls.length;
    expect((await api.getVodHome('movie')).status).toBe('ready');
    expect(spy.mock.calls.length).toBe(before);
    expect(spy.mock.calls.every((c) => c[1] === 'movie')).toBe(true);
  });

  test('M3U: a playlist refresh takes counts from the ingest and reloads only the resident kind', async () => {
    const { api, events, vod } = makeVod();
    await api.addSource({ kind: 'm3u', name: 'Fake M3U', playlistUrl: `${server.url}/get.php?username=test&password=test&type=m3u_plus` });
    expect((await api.getVodHome('movie')).status).toBe('ready');
    await api.idle();
    events.length = 0;
    const spy = vi.spyOn(vod, 'storedCatalog');
    await api.refresh('playlist');
    await api.idle();
    expect(spy.mock.calls.map((c) => c[1])).toEqual(['movie']);
    const refreshed = events.filter((e) => e.type === 'vodRefreshed') as { kind: string; count: number; truncated: boolean }[];
    expect(refreshed.find((e) => e.kind === 'movie')).toMatchObject({ count: 6, truncated: false });
    expect(refreshed.find((e) => e.kind === 'series')).toMatchObject({ count: 1, truncated: false });
  });

  test('an M3U refresh that drops all movies still announces both kinds (count 0)', async () => {
    const events: AppEvent[] = [];
    let served = 0;
    const tiny = '#EXTM3U\n#EXTINF:-1,Channel 001\nhttp://example.test/live/u/p/1.ts\n';
    const fetchFn = async (u: string, i?: RequestInit) => {
      if (u.includes('/get.php') && served++ > 0) return new Response(tiny);
      return fetch(u, i);
    };
    const deps = { storage, fetch: fetchFn, now: () => NOW };
    const api = new AppApi({ service: new SourceService(deps), storage, vod: new VodService(deps), emit: (e) => events.push(e), now: () => NOW });
    live.push(api);
    await api.addSource({ kind: 'm3u', name: 'M', playlistUrl: `${server.url}/get.php?username=test&password=test&type=m3u_plus` });
    await api.idle();
    events.length = 0;
    await api.refresh('playlist');
    const vod = events.filter((e) => e.type === 'vodRefreshed');
    expect(vod.map((e) => [(e as { kind: string }).kind, (e as { count: number }).count])).toEqual([['movie', 0], ['series', 0]]);
  });

  test('search: movies and series from the stored catalogues (20 at most each), filled in after searchReady, never fetched', async () => {
    const { api, events, vod } = makeVod();
    await api.addSource(xt());
    const id = (await storage.listSources())[0]!.id;
    const items = (kind: 'movie' | 'series', n: number) => Array.from({ length: n }, (_, i) => ({
      id: `${id}:${kind[0]}${i}`, kind, title: `Synthetic ${kind} ${String(i).padStart(2, '0')}`, categoryId: '1', year: 2000 + i,
    }));
    await storage.replaceVod(id, 'movie', { items: items('movie', 25), categories: [] });
    await storage.replaceVod(id, 'series', { items: items('series', 3), categories: [] });
    await api.idle();
    const refresh = vi.spyOn(vod, 'refresh');
    events.length = 0;
    const first = await api.search('synthetic', 50);
    expect(first).toMatchObject({ channels: [], movies: [], series: [], vodPending: true });
    await api.idle();
    expect(events).toContainEqual({ type: 'searchReady', sourceId: id });
    const r = await api.search('synthetic', 50);
    expect(r.vodPending).toBe(false);
    expect(r.movies).toHaveLength(20);
    expect(r.movies[0]).toEqual({ id: `${id}:m0`, kind: 'movie', title: 'Synthetic movie 00', categoryId: '1', year: 2000, watched: false, favourite: false });
    expect(r.series.map((t) => t.title)).toEqual(['Synthetic series 00', 'Synthetic series 01', 'Synthetic series 02']);
    expect(refresh).not.toHaveBeenCalled();
    // A source switch drops the indexes: the next search is pending again.
    const other = await api.addSource({ kind: 'm3u', name: 'M', playlistUrl: `${server.url}/get.php?username=test&password=test&type=m3u_plus` });
    await api.setActiveSource(other.sourceId);
    expect((await api.search('synthetic', 50)).vodPending).toBe(true);
  });

  test('an invalid kind is rejected', async () => {
    const { api } = makeVod();
    await api.addSource(xt());
    await expect(api.getVodHome('music' as never)).rejects.toThrow('Unknown kind');
  });
});

describe('AppApi – refusal cooldown', () => {
  /** Answers 403 to every source request while `refusing.on`, counting what was actually sent. */
  const refusingFetch = () => {
    const state = { on: false, sent: [] as string[] };
    const f: FetchFn = async (u, i) => {
      state.sent.push(new URL(u).searchParams.get('action') ?? new URL(u).pathname);
      return state.on ? new Response('', { status: 403 }) : fetch(u, i);
    };
    return { state, f };
  };
  const cooldownEvents = (events: AppEvent[]) =>
    events.filter((e): e is Extract<AppEvent, { type: 'cooldown' }> => e.type === 'cooldown');

  test('a refusal reaches InitState and a cooldown event; a reload sends nothing in the background', async () => {
    const r = refusingFetch();
    const { api, events } = make(storage, SourceService, r.f);
    const { sourceId } = await api.addSource(xt());
    await api.idle();
    r.state.on = true;
    await expect(api.refresh('playlist')).rejects.toMatchObject({ name: 'SourceAuthError' });
    expect(cooldownEvents(events).at(-1)).toEqual({ type: 'cooldown', sourceId, cooldown: { state: 'waiting', until: NOW + 120_000, reason: 'refused' } });
    // Reload: a stale playlist and guide would refresh, and every row would look up its short EPG.
    await storage.setMeta(`playlistAt:${sourceId}`, 0);
    await storage.setMeta(`epgAt:${sourceId}`, 0);
    r.state.sent = [];
    const second = make(storage, SourceService, r.f);
    const s = await second.api.init();
    expect(s.cooldown).toEqual({ state: 'waiting', until: NOW + 120_000, reason: 'refused' });
    await second.api.getChannelSlice('all', 0, 40);
    await second.api.idle();
    expect(r.state.sent).toEqual([]);
    expect(second.events.some((e) => e.type === 'refreshFailed')).toBe(false);
  });

  /** The first channel's playable (its stream URL is on the fake server's host). */
  const firstPlayable = async (api: AppApi) => (await api.getPlayable((await api.getChannelSlice('all', 0, 1)).rows[0]!.id))!;
  const hostKey = (sourceId: string) => `${sourceId}@${new URL(server.url).host}`;

  test('explicit refresh while blocked fails with the neutral copy and sends nothing', async () => {
    const r = refusingFetch();
    const { api } = make(storage, SourceService, r.f);
    await api.addSource(xt());
    await api.idle();
    r.state.on = true;
    await expect(api.refresh('playlist')).rejects.toMatchObject({ name: 'SourceAuthError' });
    r.state.sent = [];
    await expect(api.refresh('both')).rejects.toMatchObject({
      name: 'SourceRefused', message: "Your source is refusing connections. The app is waiting so you don't get blocked.",
    });
    expect(r.state.sent).toEqual([]);
  });

  test('a stream refusal pauses only its host: the source API stays clear and the playable carries the cooldown', async () => {
    const r = refusingFetch();
    const { api, events } = make(storage, SourceService, r.f);
    const { sourceId } = await api.addSource(xt());
    await api.idle();
    const p = await firstPlayable(api);
    expect(p.cooldownKey).toBe(hostKey(sourceId));
    expect(p.cooldown).toBeUndefined();
    await api.reportStreamRefused(sourceId, p.url);
    const waiting = { state: 'waiting', until: NOW + 120_000, reason: 'refused' };
    expect(cooldownEvents(events).at(-1)).toEqual({ type: 'cooldown', sourceId, streamKey: hostKey(sourceId), cooldown: waiting });
    expect((await api.init()).cooldown).toEqual({ state: 'clear' });
    r.state.sent = [];
    await api.refresh('playlist'); // the API is not paused
    expect(r.state.sent).not.toEqual([]);
    expect((await firstPlayable(api)).cooldown).toEqual(waiting);
  });

  test('a persisted host cooldown reaches the playable after a reload', async () => {
    const { api } = make(storage, SourceService);
    const { sourceId } = await api.addSource(xt());
    await api.idle();
    await api.reportStreamRefused(sourceId, (await firstPlayable(api)).url);
    const second = make(storage, SourceService);
    await second.api.init();
    expect((await firstPlayable(second.api)).cooldown).toEqual({ state: 'waiting', until: NOW + 120_000, reason: 'refused' });
  });

  test('stream reports: an answer during the host block is ignored', async () => {
    const { api } = make(storage, SourceService);
    const { sourceId } = await api.addSource(xt());
    await api.idle();
    const p = await firstPlayable(api);
    await api.reportStreamRefused(sourceId, p.url);
    await api.reportStreamAnswered(sourceId, p.url); // a stream that was already playing
    expect((await firstPlayable(api)).cooldown).toEqual({ state: 'waiting', until: NOW + 120_000, reason: 'refused' });
  });

  test("a stream refusal's Retry-After replaces the host's wait", async () => {
    const { api } = make(storage, SourceService);
    const { sourceId } = await api.addSource(xt());
    await api.idle();
    const p = await firstPlayable(api);
    await api.reportStreamRefused(sourceId, p.url, 90_000);
    expect((await firstPlayable(api)).cooldown).toEqual({ state: 'waiting', until: NOW + 90_000, reason: 'refused' });
  });

  test('back online: an unreachable wait of the active source ends and the background pass runs', async () => {
    const r = refusingFetch();
    let down = false;
    const f: FetchFn = async (u, i) => (down ? new Response('', { status: 500 }) : r.f(u, i));
    const { api } = make(storage, SourceService, f);
    const { sourceId } = await api.addSource(xt());
    await api.idle();
    down = true;
    for (let i = 0; i < 3; i++) await api.refresh('playlist').catch(() => undefined);
    expect((await api.init()).cooldown).toMatchObject({ reason: 'unreachable' });
    down = false;
    await storage.setMeta(`epgAt:${sourceId}`, 0);
    r.state.sent = [];
    await api.networkOnline();
    await api.idle();
    expect((await api.init()).cooldown).toEqual({ state: 'clear' });
    expect(r.state.sent).toContain('/xmltv.php');
  });

  test('back online: a refresh that failed while offline skips its backoff; an older failure keeps it', async () => {
    const r = refusingFetch();
    let offline = false;
    const f: FetchFn = async (u, i) => {
      if (offline) throw new TypeError('Failed to fetch');
      return r.f(u, i);
    };
    const { api, events } = make(storage, SourceService, f);
    const { sourceId } = await api.addSource(xt());
    await api.idle();
    await storage.setMeta(`refreshFail:${sourceId}:playlist`, { count: 1, at: NOW - 60_000 }); // failed before, online
    offline = true;
    await storage.setMeta(`epgAt:${sourceId}`, 0);
    await api.init(); // the automatic guide refresh fails offline: its backoff is recorded
    await api.idle();
    expect(events.some((e) => e.type === 'offline' && e.value)).toBe(true);
    expect(await storage.getMeta(`refreshFail:${sourceId}:epg`)).toBeTruthy();
    offline = false;
    r.state.sent = [];
    await api.networkOnline();
    await api.idle();
    expect(r.state.sent).toContain('/xmltv.php');
    expect(await storage.getMeta(`refreshFail:${sourceId}:epg`)).toBeFalsy();
    expect(await storage.getMeta(`refreshFail:${sourceId}:playlist`)).toEqual({ count: 1, at: NOW - 60_000 });
  });

  test('back online leaves a refusal wait alone and sends nothing', async () => {
    const r = refusingFetch();
    const { api } = make(storage, SourceService, r.f);
    await api.addSource(xt());
    await api.idle();
    r.state.on = true;
    await expect(api.refresh('playlist')).rejects.toMatchObject({ name: 'SourceAuthError' });
    r.state.sent = [];
    await api.networkOnline();
    await api.idle();
    expect((await api.init()).cooldown).toEqual({ state: 'waiting', until: NOW + 120_000, reason: 'refused' });
    expect(r.state.sent).toEqual([]);
  });

  test('a stream never counts toward the unreachable breaker: the API has no such report', () => {
    expect(APP_API_METHODS).not.toContain('reportStreamUnreachable' as never);
  });

  test('three failed source requests through wrap trip the breaker', async () => {
    const r = refusingFetch();
    let down = false;
    const f: FetchFn = async (u, i) => (down ? new Response('', { status: 500 }) : r.f(u, i));
    const { api, events } = make(storage, SourceService, f);
    const { sourceId } = await api.addSource(xt());
    await api.idle();
    down = true;
    for (let i = 0; i < 3; i++) await api.refresh('playlist').catch(() => undefined);
    const unreachable = { state: 'waiting', until: NOW + 60_000, reason: 'unreachable' };
    expect((await api.init()).cooldown).toEqual(unreachable);
    expect(cooldownEvents(events).at(-1)).toEqual({ type: 'cooldown', sourceId, cooldown: unreachable });
  });

  test('explicit refresh while unreachable fails with the unreachable copy and sends nothing', async () => {
    const r = refusingFetch();
    let down = false;
    const f: FetchFn = async (u, i) => (down ? new Response('', { status: 500 }) : r.f(u, i));
    const { api } = make(storage, SourceService, f);
    await api.addSource(xt());
    await api.idle();
    down = true;
    for (let i = 0; i < 3; i++) await api.refresh('playlist').catch(() => undefined);
    r.state.sent = [];
    await expect(api.refresh('both')).rejects.toMatchObject({
      name: 'SourceRefused', message: "Your source isn't answering. The app is waiting so it doesn't flood it.",
    });
    expect(r.state.sent).toEqual([]);
  });

  test('retry sends nothing by itself; the probe getting through runs the skipped refreshes', async () => {
    const r = refusingFetch();
    const { api, events } = make(storage, SourceService, r.f);
    const { sourceId } = await api.addSource(xt());
    await api.idle();
    const p = await firstPlayable(api);
    r.state.on = true;
    await expect(api.refresh('playlist')).rejects.toMatchObject({ name: 'SourceAuthError' });
    r.state.on = false;
    await storage.setMeta(`epgAt:${sourceId}`, 0);
    r.state.sent = [];
    expect(await api.retrySource(p.url)).toEqual({ state: 'clear' });
    await api.idle();
    expect(r.state.sent).toEqual([]); // the user's stream is the probe
    expect(cooldownEvents(events).at(-1)?.cooldown).toEqual({ state: 'clear' });
    await api.reportStreamAnswered(sourceId, p.url);
    await api.idle();
    expect(r.state.sent).toContain('/xmltv.php');
  });

  test("retry with the stream's URL lets one probe through on its host too; the answer is the worse of both", async () => {
    const { api } = make(storage, SourceService);
    const { sourceId } = await api.addSource(xt());
    await api.idle();
    const p = await firstPlayable(api);
    await api.reportStreamRefused(sourceId, p.url);
    expect(await api.retrySource()).toEqual({ state: 'clear' }); // the source itself was never paused
    expect((await firstPlayable(api)).cooldown).toEqual({ state: 'waiting', until: NOW + 120_000, reason: 'refused' });
    expect(await api.retrySource(p.url)).toEqual({ state: 'clear' });
    expect((await firstPlayable(api)).cooldown).toBeUndefined();
    await api.reportStreamRefused(sourceId, p.url); // the probe was refused: one step up
    expect((await firstPlayable(api)).cooldown).toEqual({ state: 'waiting', until: NOW + 600_000, reason: 'refused' });
  });

  test('a host cooldown ending does not restart the background pass', async () => {
    const r = refusingFetch();
    let fire: (() => void) | undefined;
    let t = NOW;
    const guard = new RefusalGuard({ storage, now: () => t, timer: { set: (fn) => { fire = fn; return 1; }, clear: () => { fire = undefined; } } });
    const service = new SourceService({ storage, fetch: r.f, now: () => NOW, guard });
    const api = new AppApi({ service, storage, emit: () => undefined, now: () => NOW });
    live.push(api);
    const { sourceId } = await api.addSource(xt());
    await api.idle();
    await api.reportStreamRefused(sourceId, (await firstPlayable(api)).url);
    await storage.setMeta(`epgAt:${sourceId}`, 0);
    r.state.sent = [];
    t = NOW + 120_000;
    fire?.();
    await api.idle();
    expect(r.state.sent).toEqual([]);
  });

  test('the end of a wait restarts the background pass (the probe)', async () => {
    const r = refusingFetch();
    let fire: (() => void) | undefined;
    let t = NOW;
    const events: AppEvent[] = [];
    const guard = new RefusalGuard({ storage, now: () => t, timer: { set: (fn) => { fire = fn; return 1; }, clear: () => { fire = undefined; } } });
    const service = new SourceService({ storage, fetch: r.f, now: () => NOW, guard });
    const api = new AppApi({ service, storage, emit: (e) => events.push(e), now: () => NOW });
    live.push(api);
    const { sourceId } = await api.addSource(xt());
    await api.idle();
    r.state.on = true;
    await expect(api.refresh('playlist')).rejects.toMatchObject({ name: 'SourceAuthError' });
    r.state.on = false;
    await storage.setMeta(`epgAt:${sourceId}`, 0);
    r.state.sent = [];
    t = NOW + 120_000;
    fire?.();
    await api.idle();
    expect(r.state.sent).toEqual(['/xmltv.php']);
    expect(cooldownEvents(events).at(-1)?.cooldown).toEqual({ state: 'clear' });
  });

  test('updateSource is a manual retry', async () => {
    const r = refusingFetch();
    const { api } = make(storage, SourceService, r.f);
    const { sourceId } = await api.addSource(xt());
    await api.idle();
    r.state.on = true;
    await expect(api.refresh('playlist')).rejects.toMatchObject({ name: 'SourceAuthError' });
    r.state.on = false;
    const src = (await api.getSource(sourceId))!;
    await expect(api.updateSource({ ...src, name: 'Renamed' })).resolves.toMatchObject({ channelCount: 40 });
    expect((await api.init()).cooldown).toEqual({ state: 'clear' });
  });

  test("updateSource also lets one probe through on each of the source's stream hosts", async () => {
    const { api } = make(storage, SourceService);
    const { sourceId } = await api.addSource(xt());
    await api.idle();
    await api.reportStreamRefused(sourceId, (await firstPlayable(api)).url);
    expect((await firstPlayable(api)).cooldown).toMatchObject({ state: 'waiting' });
    const src = (await api.getSource(sourceId))!;
    await api.updateSource({ ...src, name: 'Renamed' });
    expect((await firstPlayable(api)).cooldown).toBeUndefined();
  });

  test("deleting a source drops its stream hosts' cooldowns and their list", async () => {
    const { api } = make(storage, SourceService);
    const { sourceId } = await api.addSource(xt());
    await api.idle();
    await api.reportStreamRefused(sourceId, (await firstPlayable(api)).url);
    expect(await storage.getMeta(`refusal:${hostKey(sourceId)}`)).toMatchObject({ step: 1 });
    await api.deleteSource(sourceId);
    expect(await storage.getMeta(`refusal:${hostKey(sourceId)}`)).toBeNull();
    expect(await storage.getMeta(`streamKeys:${sourceId}`)).toBeNull();
  });

  test('a stream URL without a host pauses its own key, never the source', async () => {
    const { api } = make(storage, SourceService);
    const { sourceId } = await api.addSource(xt());
    await api.idle();
    await api.reportStreamRefused(sourceId, 'not a url');
    expect((await api.init()).cooldown).toEqual({ state: 'clear' });
    expect(await storage.getMeta(`refusal:${sourceId}@stream`)).toMatchObject({ step: 1 });
  });

  test('worseCooldown answers the cooldown that blocks longer', () => {
    const a = { state: 'waiting', until: 5, reason: 'refused' } as const;
    const b = { state: 'waiting', until: 9, reason: 'unreachable' } as const;
    expect(worseCooldown({ state: 'clear' }, a)).toBe(a);
    expect(worseCooldown(a, { state: 'clear' })).toBe(a);
    expect(worseCooldown(a, b)).toBe(b);
    expect(worseCooldown(b, a)).toBe(b);
  });
});

describe('AppApi source headers and refresh backoff', () => {
  const HOUR_MS = 3_600_000;
  const playlist = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-chno="1",Channel A',
    '#EXTVLCOPT:http-user-agent=ChannelAgent/1.0',
    'http://example.test/live/a.ts',
    '#EXTINF:-1 tvg-chno="2",Channel B',
    'http://example.test/live/b.ts|Referer=http://example.test/channel',
    '#EXTINF:-1 tvg-chno="3",Channel C',
    'http://example.test/live/c.ts',
    '#EXTINF:-1 group-title="Drama",Synthetic Film A (2020)',
    'http://example.test/movie/u/p/1.mp4|User-Agent=FilmAgent/1.0',
  ].join('\n');
  let gets = 0;
  const fetchFn: FetchFn = async (u, i) => {
    if (u === 'http://example.test/p.m3u') { gets++; return new Response(playlist); }
    return fetch(u, i);
  };
  const input = { kind: 'm3u' as const, name: 'Headers', playlistUrl: 'http://example.test/p.m3u' };
  beforeEach(() => { gets = 0; });

  test('getPlayable merges the channel headers over the source settings; VOD playables too', async () => {
    const { api } = makeVod(storage, fetchFn);
    const { sourceId } = await api.addSource(input);
    await api.idle();
    const headersOf = async (n: number) => (await api.byNumber(n))!.headers;
    expect(await headersOf(1)).toEqual({ userAgent: 'ChannelAgent/1.0' });
    expect(await headersOf(2)).toEqual({ referrer: 'http://example.test/channel' });
    expect(await headersOf(3)).toBeUndefined();
    const home = await api.getVodHome('movie');
    const film = home.rows.find((r) => r.items.length)!.items[0]!;
    const filmPlayable = (await api.getVodPlayable(film.id))!;
    expect(filmPlayable.url).toBe('http://example.test/movie/u/p/1.mp4');
    expect(filmPlayable.headers).toEqual({ userAgent: 'FilmAgent/1.0' });
    await api.updateSource({ ...(await api.getSource(sourceId))!, userAgent: 'SourceAgent/1.0', referrer: 'http://example.test/source' });
    await api.idle();
    expect(await headersOf(1)).toEqual({ userAgent: 'ChannelAgent/1.0', referrer: 'http://example.test/source' });
    expect(await headersOf(2)).toEqual({ userAgent: 'SourceAgent/1.0', referrer: 'http://example.test/channel' });
    expect(await headersOf(3)).toEqual({ userAgent: 'SourceAgent/1.0', referrer: 'http://example.test/source' });
    // The entry's own User-Agent wins over the source's; the source's Referer fills in.
    const film2 = (await api.getVodHome('movie')).rows.find((r) => r.items.length)!.items[0]!;
    expect((await api.getVodPlayable(film2.id))?.headers).toEqual({ userAgent: 'FilmAgent/1.0', referrer: 'http://example.test/source' });
  });

  test('the background refresh skips a backed-off playlist; a manual refresh runs', async () => {
    const seed = make(storage, SourceService, fetchFn).api;
    const { sourceId } = await seed.addSource(input);
    await seed.idle();
    // Stale by autoRefreshHours, but the last automatic attempt failed 5 min ago.
    await storage.setMeta(`playlistAt:${sourceId}`, NOW - 13 * HOUR_MS);
    await storage.setMeta(`refreshFail:${sourceId}:playlist`, { count: 1, at: NOW - 5 * 60_000 });
    const before = gets;
    const { api, events } = make(storage, SourceService, fetchFn);
    await api.init();
    await api.idle();
    expect(gets).toBe(before);
    expect(events.some((e) => e.type === 'refreshFailed')).toBe(false);
    await api.refresh('playlist');
    expect(gets).toBe(before + 1);
    expect(await storage.getMeta(`refreshFail:${sourceId}:playlist`)).toBeFalsy();
  });

  test('an empty channel cache is not refilled while the playlist is backed off', async () => {
    const seed = make(storage, SourceService, fetchFn).api;
    const { sourceId } = await seed.addSource(input);
    await seed.idle();
    await storage.replaceChannels(sourceId, []);
    await storage.setMeta(`refreshFail:${sourceId}:playlist`, { count: 1, at: NOW - 5 * 60_000 });
    const before = gets;
    const { api } = make(storage, SourceService, fetchFn);
    await api.init();
    await api.idle();
    expect(gets).toBe(before);
    // Once the wait is over, the same start refills it.
    await storage.setMeta(`refreshFail:${sourceId}:playlist`, { count: 1, at: NOW - 15 * 60_000 });
    const later = make(storage, SourceService, fetchFn).api;
    await later.init();
    await later.idle();
    expect(gets).toBe(before + 1);
  });

  test('a failed background playlist refresh records the backoff; a failed manual one does not', async () => {
    let down = false;
    const flaky: FetchFn = async (u, i) => (down && u === 'http://example.test/p.m3u' ? new Response('down', { status: 500 }) : fetchFn(u, i));
    const seed = make(storage, SourceService, flaky).api;
    const { sourceId } = await seed.addSource(input);
    await seed.idle();
    down = true;
    await expect(seed.refresh('playlist')).rejects.toThrow();
    expect(await storage.getMeta(`refreshFail:${sourceId}:playlist`)).toBeFalsy();
    await storage.setMeta(`playlistAt:${sourceId}`, NOW - 13 * HOUR_MS);
    const { api } = make(storage, SourceService, flaky);
    await api.init();
    await api.idle();
    expect(await storage.getMeta(`refreshFail:${sourceId}:playlist`)).toEqual({ count: 1, at: NOW });
  });

  test('the first Movies load is not held off by a failed background refresh', async () => {
    const { api } = makeVod();
    const { sourceId } = await api.addSource(xt());
    await api.idle();
    await storage.setMeta(`refreshFail:${sourceId}:vod:movie`, { count: 1, at: NOW });
    expect((await api.getVodHome('movie')).status).not.toBe('empty');
    await api.idle();
    expect((await api.getVodHome('movie')).status).toBe('ready');
    expect(await storage.getMeta(`refreshFail:${sourceId}:vod:movie`)).toBeFalsy();
  });
});

describe('subtitles from a link or a file', () => {
  const SRT = '1\n00:00:01,000 --> 00:00:02,000\nHello\n';

  test('kept per title under the active source; without a source or the service they are unavailable', async () => {
    const events: AppEvent[] = [];
    const service = new SourceService({ storage, fetch: (u, i) => fetch(u, i), now: () => NOW, shortEpgGapMs: 0 });
    const subtitles = new SubtitleService({ storage, fetch: async () => new Response(SRT) });
    const api = new AppApi({ service, storage, subtitles, emit: (e) => events.push(e), now: () => NOW });
    live.push(api);
    await expect(api.loadSubtitle('m1', { url: 'http://example.test/a.srt' })).rejects.toThrow('Add a source first.');
    expect(await api.getSubtitle('m1')).toBeUndefined();
    await api.addSource(xt());
    const got = await api.loadSubtitle('m1', { url: 'http://example.test/a.srt' });
    expect(got).toEqual({ name: 'a.srt', cues: [{ startMs: 1000, endMs: 2000, text: 'Hello' }] });
    expect(await api.getSubtitle('m1')).toEqual(got);
    await api.loadSubtitle('m2', { bytes: new TextEncoder().encode(SRT), name: 'b.srt' });
    await api.clearSubtitle('m1');
    expect(await api.getSubtitle('m1')).toBeUndefined();
    expect((await api.getSubtitle('m2'))?.name).toBe('b.srt');

    const { api: bare } = make();
    await bare.addSource(xt());
    await expect(bare.loadSubtitle('m1', { url: 'http://example.test/a.srt' })).rejects.toThrow('Loading subtitles is not available.');
    expect(await bare.getSubtitle('m1')).toBeUndefined();
  });

  test('a file the source lists: its language kept, named by label or language, never by its link', async () => {
    const service = new SourceService({ storage, fetch: (u, i) => fetch(u, i), now: () => NOW, shortEpgGapMs: 0 });
    const subtitles = new SubtitleService({ storage, fetch: async () => new Response(SRT) });
    const api = new AppApi({ service, storage, subtitles, emit: () => undefined, now: () => NOW });
    live.push(api);
    await api.addSource(xt());
    const got = await api.loadSourceSubtitle('m1', { url: 'http://panel.test/subtitle/user/secret/1.srt', language: 'en' });
    expect(got).toMatchObject({ name: 'English (from source)', language: 'en' });
    expect(JSON.stringify(got)).not.toContain('secret');
    expect(sourceSubtitleName({ url: 'http://x.test/a.srt', label: 'Forced' })).toBe('Forced (from source)');
    expect(sourceSubtitleName({ url: 'http://x.test/a.srt' })).toBe('Subtitles (from source)');
  });

  test('syncSubtitle lines the loaded file up with the recorded sample; nothing without a file or a clear answer', async () => {
    const ts = (ms: number) => new Date(ms).toISOString().slice(11, 23).replace('.', ',');
    const srtOf = (starts: number[]) => starts.map((s, i) => `${i + 1}\n${ts(s)} --> ${ts(s + 2000)}\nLine ${i + 1}\n`).join('\n');
    // Synthetic dialogue over 10 minutes: irregular gaps (a real film), and a perfectly regular 6 s rhythm.
    const irregular: number[] = [];
    for (let t = 1000, i = 0; t < 600_000; i++) { irregular.push(t); t += 2500 + ((i * 7919) % 5000); }
    const regular = Array.from({ length: 100 }, (_, i) => i * 6000 + 1000);
    let srt = srtOf(irregular);
    const service = new SourceService({ storage, fetch: (u, i) => fetch(u, i), now: () => NOW, shortEpgGapMs: 0 });
    const subtitles = new SubtitleService({ storage, fetch: async () => new Response(srt) });
    const api = new AppApi({ service, storage, subtitles, emit: () => undefined, now: () => NOW });
    live.push(api);
    await api.addSource(xt());
    // The stream's own track showed every line 1.5 s later than the file has it.
    const sampleOf = (starts: number[]) => ({
      cues: starts.map((s) => [s + 1500, s + 3500] as [number, number]), played: [[0, 600_000]] as [number, number][],
    });
    expect(await api.syncSubtitle('m1', sampleOf(irregular), { delayMs: 0, speed: 1 })).toBeUndefined();
    await api.loadSubtitle('m1', { url: 'http://example.test/a.srt' });
    expect(await api.syncSubtitle('m1', sampleOf(irregular), { delayMs: 0, speed: 1 })).toMatchObject({ delayMs: 1500, speed: 1 });
    // A perfectly regular rhythm fits every 6 s just as well: no single clear answer, so nothing changes.
    srt = srtOf(regular);
    await api.loadSubtitle('m2', { url: 'http://example.test/b.srt' });
    expect(await api.syncSubtitle('m2', sampleOf(regular), { delayMs: 0, speed: 1 })).toBeUndefined();
  });
});

describe('subtitles found online (fake OpenSubtitles service)', () => {
  const hashed: string[] = [];
  type HashFn = (url: string, headers?: { userAgent?: string; referrer?: string }) => Promise<string | undefined>;
  // The API's clock (its injected `now`): a test moves it to expire a failed hash read; reset after each test.
  let clockMs = NOW;
  afterEach(() => { clockMs = NOW; vi.restoreAllMocks(); });
  const makeOnline = (apiKey = 'fake-key', fileHash?: HashFn, apiFetch?: (u: string, i?: RequestInit) => Promise<Response>) => {
    const deps = { storage, fetch: (u: string, i?: RequestInit) => fetch(u, i), now: () => NOW };
    const service = new SourceService(deps);
    const vod = new VodService(deps);
    const subtitles = new SubtitleService(deps);
    const onlineSubtitles = new OpenSubtitlesClient({
      apiFetch: apiFetch ?? deps.fetch, fileFetch: deps.fetch, apiKey, baseUrl: `${server.url}/opensubtitles/api/v1`, appName: 'Test v0',
    });
    const api = new AppApi({ service, storage, vod, subtitles, onlineSubtitles, ...(fileHash ? { fileHash } : {}), emit: () => {}, now: () => clockMs });
    live.push(api);
    return api;
  };

  test('a movie: one row per language, the preferred language first; a click loads and keeps it for that title', async () => {
    const api = makeOnline();
    expect(await api.onlineSubtitlesAvailable()).toBe(true);
    await api.addSource(xt());
    await api.saveSettings({ subtitleLanguage: 'sv' });
    await api.refreshVod('movie');
    const movieId = (await api.getVodSlice('movie', 'all', 'title', 0, 1)).rows[0]!.id;
    const langs = await api.findSubtitlesOnline(movieId);
    // A language with hearing-impaired files too gets a CC row right after its regular one.
    expect(langs.map((l) => [l.language, l.count, l.cc ?? false])).toEqual([
      ['sv', 1, false], ['sv', 1, true], ['en', 2, false], ['en', 1, true], ['de', 1, false], ['es', 1, false], ['fr', 1, false],
    ]);
    // The best Swedish file: the trusted one; each row's versions are its own kind, none timed for this exact file.
    expect(langs[0]!.fileId).toBe(2001);
    expect(langs[0]!.files).toEqual([2001]);
    expect(langs[1]!.files).toEqual([2002]);
    expect(langs.every((l) => !l.synced)).toBe(true);
    const loaded = await api.loadOnlineSubtitle(movieId, langs[0]!.fileId, 'Swedish');
    expect(loaded.name).toBe('Swedish');
    expect(loaded.cues[0]).toEqual({ startMs: 1000, endMs: 4000, text: 'Synthetic subtitle 1 (sv)' });
    expect((await api.getSubtitle(movieId))?.name).toBe('Swedish');
    await expect(api.loadOnlineSubtitle(movieId, 999, 'English')).rejects.toThrow('Daily subtitle download limit reached. Try again tomorrow.');
    // The delay is kept with that file; a newly loaded file starts at 0.
    await api.setSubtitleDelay(movieId, 1200);
    expect((await api.getSubtitle(movieId))?.delayMs).toBe(1200);
    await api.loadOnlineSubtitle(movieId, 1001, 'English');
    expect((await api.getSubtitle(movieId))?.delayMs).toBeUndefined();
  });

  test('exact match on: the stream file\'s hash goes along and the matching version comes first, marked synced', async () => {
    hashed.length = 0;
    const api = makeOnline('fake-key', async (url) => { hashed.push(url); return '0123456789abcdef'; });
    await api.addSource(xt());
    await api.refreshVod('movie');
    const movieId = (await api.getVodSlice('movie', 'all', 'title', 0, 1)).rows[0]!.id;
    // Turned off: no hash is read.
    await api.saveSettings({ subtitleExactMatch: false });
    expect((await api.findSubtitlesOnline(movieId))[0]!.synced).toBe(false);
    expect(hashed).toEqual([]);
    // On (the default).
    await api.saveSettings({ subtitleExactMatch: true, subtitleLanguage: 'en' });
    const langs = await api.findSubtitlesOnline(movieId);
    expect(hashed).toHaveLength(1);
    expect(hashed[0]).toMatch(/\/movie\/test\/test\/\d+\.m3u8$/);
    expect(langs[0]).toMatchObject({ language: 'en', fileId: 1003, synced: true });
    expect(langs[0]!.files).toEqual([1003, 1001]);
  });

  test('exact match never reads the file on an account limited to one connection', async () => {
    hashed.length = 0;
    const api = makeOnline('fake-key', async (url) => { hashed.push(url); return '0123456789abcdef'; });
    await api.addSource(xt('single'));
    await api.refreshVod('movie');
    const movieId = (await api.getVodSlice('movie', 'all', 'title', 0, 1)).rows[0]!.id;
    expect((await api.findSubtitlesOnline(movieId)).every((l) => !l.synced)).toBe(true);
    expect(hashed).toEqual([]);
  });

  test('exact match on but no hash (refused, or a playlist): the search still works', async () => {
    const api = makeOnline('fake-key', async () => undefined);
    await api.addSource(xt());
    await api.saveSettings({ subtitleExactMatch: true });
    await api.refreshVod('movie');
    const movieId = (await api.getVodSlice('movie', 'all', 'title', 0, 1)).rows[0]!.id;
    expect((await api.findSubtitlesOnline(movieId)).length).toBe(7);
  });

  const firstMovie = async (api: AppApi) => {
    await api.refreshVod('movie');
    return (await api.getVodSlice('movie', 'all', 'title', 0, 1)).rows[0]!.id;
  };

  test('with the video frame rate: each language\'s best is timed for it; rows carry its release and fps', async () => {
    const api = makeOnline();
    await api.addSource(xt());
    await api.saveSettings({ subtitleLanguage: 'sv' });
    const movieId = await firstMovie(api);
    const plain = await api.findSubtitlesOnline(movieId);
    // Without a frame rate: the trusted PAL file, as before.
    expect(plain[0]).toMatchObject({ language: 'sv', fileId: 2001, release: 'Synthetic.Release.sv.1', fps: 25 });
    const film = await api.findSubtitlesOnline(movieId, undefined, 23.976);
    // The 23.976 Swedish file is the hearing-impaired one: it leads the Swedish CC row; the regular row keeps the PAL file.
    expect(film[0]).toMatchObject({ language: 'sv', fileId: 2001, fps: 25 });
    expect(film[1]).toMatchObject({ language: 'sv', cc: true, fileId: 2002, release: 'Synthetic.Release.sv.2', fps: 23.976 });
    // A language with only a PAL file still offers it, its fps on the row.
    expect(film.find((l) => l.language === 'de')).toMatchObject({ fileId: 3001, fps: 25 });
  });

  test('versions of one language: one search for that language only, ranked with the frame rate', async () => {
    const urls: string[] = [];
    const api = makeOnline('fake-key', undefined, (u, i) => { urls.push(u); return fetch(u, i); });
    await api.addSource(xt());
    const movieId = await firstMovie(api);
    const versions = await api.subtitleVersions(movieId, 'en', undefined, 23.976);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).searchParams.get('languages')).toBe('en');
    expect(new URL(urls[0]!).searchParams.get('page')).toBeNull();
    expect(versions.map((v) => v.fileId)).toEqual([1002, 1003, 1001]);
    expect(versions[0]).toEqual({ fileId: 1002, release: 'Synthetic.Release.en.2', fps: 23.976, synced: false, downloads: 800, hearingImpaired: true });
    expect('fps' in versions[1]!).toBe(false);
  });

  test('versions are kept per title for the session: a reopen asks nothing; a source switch forgets them', async () => {
    const urls: string[] = [];
    const api = makeOnline('fake-key', undefined, (u, i) => { if (new URL(u).pathname.endsWith('/subtitles')) urls.push(u); return fetch(u, i); });
    const { sourceId } = await api.addSource(xt());
    const movieId = await firstMovie(api);
    const first = await api.subtitleVersions(movieId, 'en', undefined, 23.976);
    expect(urls).toHaveLength(1);
    expect(await api.subtitleVersions(movieId, 'en', undefined, 23.976)).toEqual(first);
    expect(urls).toHaveLength(1);
    // Another language (or frame rate) is another list.
    await api.subtitleVersions(movieId, 'sv', undefined, 23.976);
    await api.subtitleVersions(movieId, 'en');
    expect(urls).toHaveLength(3);
    await api.setActiveSource(sourceId);
    await api.subtitleVersions(movieId, 'en', undefined, 23.976);
    expect(urls).toHaveLength(4);
  });

  test('kept versions belong to the file playing and the exact-match setting', async () => {
    const urls: string[] = [];
    const api = makeOnline('fake-key', async () => '0123456789abcdef',
      (u, i) => { if (new URL(u).pathname.endsWith('/subtitles')) urls.push(u); return fetch(u, i); });
    await api.addSource(xt());
    const movieId = await firstMovie(api);
    await api.saveSettings({ subtitleExactMatch: false });
    await api.subtitleVersions(movieId, 'en');
    expect(urls).toHaveLength(1);
    // Exact match turned on: the list is made again (now with the hash), then kept.
    await api.saveSettings({ subtitleExactMatch: true });
    expect((await api.subtitleVersions(movieId, 'en'))[0]).toMatchObject({ synced: true });
    await api.subtitleVersions(movieId, 'en');
    expect(urls).toHaveLength(2);
    // Another version of the movie picked (the id now plays another file): its own list.
    const real = VodController.prototype.playable;
    const spy = vi.spyOn(VodController.prototype, 'playable').mockImplementation(async function (this: VodController, ...args) {
      const out = await real.apply(this, args);
      return out && { ...out, url: out.url.replace(/(\.\w+)$/, '-other$1') };
    });
    await api.subtitleVersions(movieId, 'en');
    expect(urls).toHaveLength(3);
    spy.mockRestore();
    await api.subtitleVersions(movieId, 'en');
    expect(urls).toHaveLength(3);
    // Exact match off again: the list made without the hash is still kept.
    await api.saveSettings({ subtitleExactMatch: false });
    await api.subtitleVersions(movieId, 'en');
    expect(urls).toHaveLength(3);
  });

  test('a version loaded from the list keeps its language, file id and frame rate; its speed is kept with it', async () => {
    const api = makeOnline();
    await api.addSource(xt());
    const movieId = await firstMovie(api);
    const loaded = await api.loadOnlineSubtitle(movieId, 2001, 'Swedish', { language: 'sv', fps: 25 });
    expect(loaded).toMatchObject({ name: 'Swedish', online: { language: 'sv', fileId: 2001 }, fps: 25 });
    expect((await api.getSubtitle(movieId))?.speed).toBeUndefined();
    await api.setSubtitleSpeed(movieId, 23.976 / 25);
    await api.setSubtitleDelay(movieId, 300);
    expect(await api.getSubtitle(movieId)).toMatchObject({ speed: 23.976 / 25, delayMs: 300, online: { language: 'sv', fileId: 2001 } });
  });

  test('exact match: another file under the same id (a picked version) is hashed again; a source switch forgets the hashes', async () => {
    const hashed: string[] = [];
    const api = makeOnline('fake-key', async (url) => { hashed.push(url); return '0123456789abcdef'; });
    const { sourceId } = await api.addSource(xt());
    await api.saveSettings({ subtitleExactMatch: true });
    const movieId = await firstMovie(api);
    await api.findSubtitlesOnline(movieId);
    expect(hashed).toHaveLength(1);
    // The id now resolves to another file (as after "pickVodVersion"): its own hash is read.
    const real = VodController.prototype.playable;
    const spy = vi.spyOn(VodController.prototype, 'playable').mockImplementation(async function (this: VodController, ...args) {
      const out = await real.apply(this, args);
      return out && { ...out, url: out.url.replace(/(\.\w+)$/, '-other$1') };
    });
    await api.findSubtitlesOnline(movieId);
    expect(hashed).toHaveLength(2);
    expect(hashed[1]).toMatch(/-other\.\w+$/);
    spy.mockRestore();
    // Back to the first file: still remembered.
    await api.findSubtitlesOnline(movieId);
    expect(hashed).toHaveLength(2);
    // Switching source (even to the same one) forgets every hash.
    await api.setActiveSource(sourceId);
    await api.findSubtitlesOnline(movieId);
    expect(hashed).toHaveLength(3);
  });

  test('exact match: a failed hash read is retried only after MOVIE_HASH_RETRY_MS', async () => {
    let calls = 0;
    const api = makeOnline('fake-key', async () => { calls++; return undefined; });
    await api.addSource(xt());
    await api.saveSettings({ subtitleExactMatch: true });
    const movieId = await firstMovie(api);
    await api.findSubtitlesOnline(movieId);
    clockMs = NOW + MOVIE_HASH_RETRY_MS - 1;
    await api.findSubtitlesOnline(movieId);
    expect(calls).toBe(1);
    clockMs = NOW + MOVIE_HASH_RETRY_MS;
    await api.findSubtitlesOnline(movieId);
    expect(calls).toBe(2);
  });

  test('versions with an empty or blank language: none, and nothing is asked', async () => {
    const urls: string[] = [];
    const api = makeOnline('fake-key', undefined, (u, i) => { urls.push(u); return fetch(u, i); });
    await api.addSource(xt());
    const movieId = await firstMovie(api);
    expect(await api.subtitleVersions(movieId, '')).toEqual([]);
    expect(await api.subtitleVersions(movieId, '  ')).toEqual([]);
    expect(urls).toEqual([]);
  });

  // A stub of the search API: `pages` answers by page number; other calls go to the fake server.
  const pagedApi = (pages: Record<number, { total_pages?: number; ids: number[] }>, urls: string[]) =>
    async (u: string, i?: RequestInit): Promise<Response> => {
      const url = new URL(u);
      if (!url.pathname.endsWith('/subtitles')) return fetch(u, i);
      urls.push(u);
      const page = pages[Number(url.searchParams.get('page') ?? 1)] ?? { ids: [] };
      const data = page.ids.map((id) => ({
        attributes: { language: 'en', download_count: id, release: `Synthetic.${id}`, files: [{ file_id: id }] },
      }));
      return new Response(JSON.stringify({ ...(page.total_pages ? { total_pages: page.total_pages } : {}), data }), { status: 200 });
    };
  const range = (from: number, n: number) => Array.from({ length: n }, (_, k) => from + k);

  test('versions: page 2 only when page 1 says there is more (or, without a page count, came back full); never a third', async () => {
    const urls: string[] = [];
    let pages: Record<number, { total_pages?: number; ids: number[] }> = { 1: { total_pages: 3, ids: [1, 2, 3] }, 2: { total_pages: 3, ids: [3, 4] } };
    const api = makeOnline('fake-key', undefined, (u, i) => pagedApi(pages, urls)(u, i));
    const { sourceId } = await api.addSource(xt());
    const movieId = await firstMovie(api);
    const two = await api.subtitleVersions(movieId, 'en');
    expect(urls.map((u) => new URL(u).searchParams.get('page'))).toEqual([null, '2']);
    // Deduplicated by file id, most downloaded first.
    expect(two.map((v) => v.fileId)).toEqual([4, 3, 2, 1]);

    const count = async (p: typeof pages) => {
      pages = p;
      await api.setActiveSource(sourceId); // forgets the versions kept for the session
      urls.length = 0;
      const n = (await api.subtitleVersions(movieId, 'en')).length;
      return [n, urls.length];
    };
    expect(await count({ 1: { total_pages: 1, ids: range(1, 60) }, 2: { ids: [999] } })).toEqual([60, 1]);
    expect(await count({ 1: { ids: range(1, SUBTITLE_SEARCH_PAGE_SIZE) }, 2: { ids: [999] } })).toEqual([SUBTITLE_SEARCH_PAGE_SIZE + 1, 2]);
    expect(await count({ 1: { ids: range(1, SUBTITLE_SEARCH_PAGE_SIZE - 1) }, 2: { ids: [999] } })).toEqual([SUBTITLE_SEARCH_PAGE_SIZE - 1, 1]);
  });

  test('exact match: the hash is read once per title with the stream\'s headers and reused by the versions search', async () => {
    const calls: [string, unknown][] = [];
    const urls: string[] = [];
    const api = makeOnline('fake-key', async (url, headers) => { calls.push([url, headers]); return '0123456789abcdef'; },
      (u, i) => { urls.push(u); return fetch(u, i); });
    await api.addSource({ ...xt(), userAgent: 'SourceAgent/1.0', referrer: 'http://example.test/source' });
    await api.saveSettings({ subtitleExactMatch: true });
    const movieId = await firstMovie(api);
    await api.findSubtitlesOnline(movieId);
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual({ userAgent: 'SourceAgent/1.0', referrer: 'http://example.test/source' });
    const versions = await api.subtitleVersions(movieId, 'en');
    expect(calls).toHaveLength(1);
    expect(new URL(urls.at(-1)!).searchParams.get('moviehash')).toBe('0123456789abcdef');
    expect(versions[0]).toMatchObject({ fileId: 1003, synced: true });
    await api.findSubtitlesOnline(movieId);
    expect(calls).toHaveLength(1);
  });

  test('exact match: the versions search reads the hash itself when the language list did not', async () => {
    const calls: string[] = [];
    const api = makeOnline('fake-key', async (url) => { calls.push(url); return undefined; });
    await api.addSource(xt());
    await api.saveSettings({ subtitleExactMatch: true });
    const movieId = await firstMovie(api);
    expect((await api.subtitleVersions(movieId, 'sv')).length).toBe(2);
    await api.subtitleVersions(movieId, 'en');
    // A failed read is remembered too: not asked again for the same title for a while (retried after 10 minutes).
    expect(calls).toHaveLength(1);
  });

  test('not set up (no client): unavailable and rejects; the service\'s own errors come through', async () => {
    const { api: bare } = make();
    expect(await bare.onlineSubtitlesAvailable()).toBe(false);
    await expect(bare.findSubtitlesOnline('x')).rejects.toThrow('Online subtitles are not available.');
    const wrong = makeOnline('wrong');
    await wrong.addSource(xt());
    await wrong.refreshVod('movie');
    const movieId = (await wrong.getVodSlice('movie', 'all', 'title', 0, 1)).rows[0]!.id;
    await expect(wrong.findSubtitlesOnline(movieId)).rejects.toThrow('Online subtitles are not set up correctly.');
  });
});

describe('AppApi – sports in your guide', () => {
  let sportsServer: Awaited<ReturnType<typeof startFakeXtream>>;
  beforeAll(async () => { sportsServer = await startFakeXtream({ port: 0, channels: 40, sports: true, now: () => NOW }); });
  afterAll(async () => { await sportsServer.close(); });

  test('events from the fake sports guide; highlights, replay and the film are not events', async () => {
    const { api } = make();
    await api.addSource({ kind: 'xtream', name: 'Fake', server: sportsServer.url, username: 'test', password: 'test' });
    await api.idle();
    const events = await api.getSportsEvents();
    const titles = events.map((e) => e.title);
    // One Northbridge event (the replay and the highlights show are not events); its title is one of the five spellings.
    const nbs = events.filter((e) => e.title.includes('Northbridge'));
    expect(nbs).toHaveLength(1);
    expect(titles.join('|')).not.toMatch(/Highlights|Hollis/);
    const nb = nbs[0]!;
    expect(nb.channelCount).toBe(5);
    const rows = await api.getEventChannels(nb.key);
    expect(rows.map((r) => r.number)).toEqual([1, 2, 3, 4, 5]);
    expect(await api.getEventChannels('p:nope')).toEqual([]);
  });

  test('followed teams sort first', async () => {
    const { api } = make();
    await api.addSource({ kind: 'xtream', name: 'Fake', server: sportsServer.url, username: 'test', password: 'test' });
    await api.idle();
    await api.saveSettings({ followedTeams: ['Pinecrest'] });
    const events = await api.getSportsEvents();
    expect(events[0]!.title).toBe('Lakeshore v Pinecrest');
    expect(events[0]!.followed).toBe(true);
  });

  test('matches: the fake guide fixtures (design note §4): grouped, gated, small ones in See all only, other sport last', async () => {
    const { api } = make();
    await api.addSource({ kind: 'xtream', name: 'Fake', server: sportsServer.url, username: 'test', password: 'test' });
    await api.idle();
    const all = await api.getSportsEvents();
    const titles = all.map((e) => e.title);
    expect(titles.join('|')).not.toMatch(/Studio|Evening News|Build-up|Wdh/);
    const sw = all.filter((e) => e.title.includes('Southmere'));
    expect(sw).toHaveLength(1);
    expect(sw[0]).toMatchObject({ title: 'Southmere v Westvale', competition: 'Northern Cup', channelCount: 3 });
    expect(titles.at(-1)).toBe('Lakeside Open, Round 3');
    expect(titles).toContain('Player One v Player Two');
    const home = await api.getStartHome();
    const row = home.rows.find((r) => r.id === 'sports')!;
    expect(row.title).toBe('On now');
    const rowTitles = row.cells.flatMap((c) => (c.type === 'event' ? [c.event.title] : []));
    // The fake guide has no country prefixes (unknown scope): the 25 % cut-off applies and the row is never padded, so the
    // one-channel match stays in See all only. Sport with no sides is never in the row.
    expect(rowTitles).not.toContain('Player One v Player Two');
    expect(rowTitles).not.toContain('Lakeside Open, Round 3');
    expect(row.cells.at(-1)).toEqual({ type: 'viewAll', target: 'sports', total: all.length });
  });

  test('matches follow Your countries at once: channels in groups the region rule hides drop out, showing them brings them back', async () => {
    const { api } = make();
    await api.addSource({ kind: 'xtream', name: 'Fake', server: sportsServer.url, username: 'test', password: 'test' });
    await api.idle();
    await api.setRegions({ mode: 'only', codes: ['SE'] });
    const northbridge = async () => (await api.getSportsEvents()).find((e) => e.title.includes('Northbridge'));
    const nb = (await northbridge())!;
    const rows = await api.getEventChannels(nb.key);
    const groups = [...new Set(rows.map((r) => `g:${r.group}`))];
    expect(groups.length).toBeGreaterThan(1);
    // The user says the first group is the chosen country and the others another one: `only` SE hides those.
    const [home, ...away] = groups;
    await api.setGroupRegion(home!, ['SE']);
    for (const g of away) await api.setGroupRegion(g, ['DK']);
    const kept = rows.filter((r) => `g:${r.group}` === home).length;
    expect((await northbridge())!.channelCount).toBe(kept);
    // Shown on purpose over the rule: back at once.
    await api.setGroupVisibility(away, 'show');
    expect((await northbridge())!.channelCount).toBe(nb.channelCount);
  });

  test("matches: a pinned competition comes first, a hidden one is gone; chips are the guide's own categories", async () => {
    const { api } = make();
    await api.addSource({ kind: 'xtream', name: 'Fake', server: sportsServer.url, username: 'test', password: 'test' });
    await api.idle();
    const before = await api.getSportsEvents();
    expect(before[0]!.title).not.toBe('Lakeshore v Pinecrest');
    expect(before.find((e) => e.title === 'Lakeshore v Pinecrest')!.competition).toBe('Test Cup');
    await api.saveSettings({ pinnedCompetitions: ['Test Cup'] });
    expect((await api.getSportsEvents())[0]!.title).toBe('Lakeshore v Pinecrest');
    await api.saveSettings({ pinnedCompetitions: [], hiddenCompetitions: ['test cup'] });
    expect((await api.getSportsEvents()).map((e) => e.title)).not.toContain('Lakeshore v Pinecrest');
    const chips = await api.getMatchFilters();
    expect(chips.categories.map((c) => c.label)).toEqual(['Football', 'Golf', 'Ishockey', 'Tennis']);
    expect(chips.competitions).toEqual([{ id: 'northern cup', label: 'Northern Cup' }]);
    await api.saveSettings({ hiddenCompetitions: [], matchCategories: ['tennis'] });
    expect((await api.getSportsEvents()).every((e) => e.title.includes('Marlow'))).toBe(true);
  });

  test("getMatchCompetitions: one category's competitions, pinned first and marked, hidden ones left out", async () => {
    const { api } = make();
    await api.addSource({ kind: 'xtream', name: 'Fake', server: sportsServer.url, username: 'test', password: 'test' });
    await api.idle();
    await api.saveSettings({ pinnedCompetitions: ['northern cup'] });
    const cats = (await api.getMatchFilters()).categories;
    const per = await Promise.all(cats.map(async (c) => ({ c, r: await api.getMatchCompetitions(c.id) })));
    const withCup = per.find((p) => p.r.chips.some((x) => x.id === 'northern cup'));
    expect(withCup).toBeDefined();
    expect(withCup!.r.chips[0]).toEqual({ id: 'northern cup', label: 'Northern Cup', pinned: true });
    await api.saveSettings({ pinnedCompetitions: [], hiddenCompetitions: ['northern cup'] });
    expect((await api.getMatchCompetitions(withCup!.c.id)).chips.map((x) => x.id)).not.toContain('northern cup');
    expect(await api.getMatchCompetitions('no such category')).toEqual({ chips: [], more: [] });
  });

  test('getStartHome: live now and sports rows; the cached call answers the last value; no stream URLs are kept', async () => {
    const st = new MemoryStorage();
    const { api } = make(st);
    await api.addSource({ kind: 'xtream', name: 'Fake', server: sportsServer.url, username: 'test', password: 'test' });
    await api.idle();
    expect(await api.getStartHomeCached()).toBeUndefined();
    const h = await api.getStartHome();
    expect(h.rows.map((r) => r.id)).toContain('sports');
    expect(await api.getStartHomeCached()).toEqual(h);
    const stored = JSON.stringify(await st.getMeta(`startHome:${(await api.init()).activeSourceId}`));
    expect(stored).not.toMatch(/"url"/);
  });

  test('getStartHome: no channel row on Start, whatever the favourites and recents are', async () => {
    const { api } = make();
    await api.addSource(xt());
    const [a, b] = (await api.getChannelSlice('all', 0, 2)).rows.map((r) => r.id);
    await api.toggleFavourite(a!);
    await api.markWatched(b!, 'all');
    await api.idle();
    const home = await api.getStartHome();
    expect(home.rows.find((r) => r.id === 'live')).toBeUndefined();
  });

  test('getStartHome: Top rated rows from the loaded catalogues, kept once the other kind is resident', async () => {
    const { api } = makeVod(new MemoryStorage());
    await api.addSource({ kind: 'xtream', name: 'Fake', server: sportsServer.url, username: 'test', password: 'test' });
    await api.idle();
    await api.getVodHome('movie');
    await api.idle();
    await api.getVodHome('movie');
    const h = await api.getStartHome();
    const top = h.rows.find((r) => r.id === 'topMovies')!;
    expect(top.title).toBe('Top rated movies');
    const ratings = top.cells.flatMap((c) => (c.type === 'vod' ? [c.tile.rating!] : []));
    expect(ratings.length).toBe(20);
    expect([...ratings].sort((a, b) => b - a)).toEqual(ratings);
    expect(top.cells.at(-1)).toMatchObject({ type: 'viewAll', target: 'movie', order: 'rating' });

    await api.getVodHome('series');
    await api.idle();
    await api.getVodHome('series');
    const after = await api.getStartHome();
    expect(after.rows.map((r) => r.id)).toEqual(expect.arrayContaining(['topMovies', 'topSeries']));
    expect(after.rows.find((r) => r.id === 'topMovies')).toEqual(top);
  });

  const makeSpied = () => {
    const st = new MemoryStorage();
    const service = new SourceService({ storage: st, fetch: (u, i) => fetch(u, i), now: () => NOW, shortEpgGapMs: 0 });
    const spy = vi.spyOn(service, 'sportsIndexFor');
    const api = new AppApi({ service, storage: st, emit: () => {}, now: () => NOW, appVersion: '1.2.3' });
    live.push(api);
    return { api, spy };
  };
  const cachedEvents = (api: AppApi) => (api as unknown as { sports: { cache?: { view: { events: unknown } } } }).sports.cache?.view.events;

  test('a zap (markWatched) does not regroup or re-read the index; hiding an airing channel does change the event', async () => {
    const { api, spy } = makeSpied();
    await api.addSource({ kind: 'xtream', name: 'Fake', server: sportsServer.url, username: 'test', password: 'test' });
    await api.idle();
    spy.mockClear();
    const nb = (await api.getSportsEvents()).find((e) => e.title.includes('Northbridge'))!;
    const grouped = cachedEvents(api);
    expect(grouped).toBeDefined();
    expect(spy).toHaveBeenCalledTimes(1);
    const rows = await api.getEventChannels(nb.key);
    await api.markWatched(rows[0]!.id, 'all');
    await api.getSportsEvents();
    expect(cachedEvents(api)).toBe(grouped);
    expect(spy).toHaveBeenCalledTimes(1);
    await api.toggleHidden(rows[0]!.id);
    const after = (await api.getSportsEvents()).find((e) => e.title.includes('Northbridge'))!;
    expect(cachedEvents(api)).not.toBe(grouped);
    expect(after.channelCount).toBe(nb.channelCount - 1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('the later of two same-pairing events opens its own channels', async () => {
    const st = new MemoryStorage();
    const service = new SourceService({ storage: st, fetch: (u, i) => fetch(u, i), now: () => NOW, shortEpgGapMs: 0 });
    const api = new AppApi({ service, storage: st, emit: () => {}, now: () => NOW, appVersion: '1.2.3' });
    live.push(api);
    const { sourceId } = await api.addSource({ kind: 'xtream', name: 'Fake', server: sportsServer.url, username: 'test', password: 'test' });
    await api.idle();
    const base = (await service.sportsIndexFor(sourceId))!;
    const nbc = base.candidates.filter((c) => c.title.includes('Northbridge'));
    expect(nbc.length).toBeGreaterThan(0);
    const H = 3600_000;
    // The same pairing 5 hours later, on one channel only.
    const later = { ...nbc[0]!, start: nbc[0]!.start + 5 * H, stop: nbc[0]!.stop + 5 * H };
    vi.spyOn(service, 'sportsIndexFor').mockResolvedValue({ ...base, candidates: [...base.candidates, later] });
    const nbs = (await api.getSportsEvents()).filter((e) => e.title.includes('Northbridge')).sort((a, b) => a.start - b.start);
    expect(nbs).toHaveLength(2);
    expect(nbs[0]!.key).not.toBe(nbs[1]!.key);
    expect((await api.getEventChannels(nbs[0]!.key)).length).toBe(nbs[0]!.channelCount);
    const laterRows = await api.getEventChannels(nbs[1]!.key);
    expect(laterRows.length).toBe(nbs[1]!.channelCount);
    expect(nbs[1]!.channelCount).toBeLessThan(nbs[0]!.channelCount);
  });

  test('a guide refresh re-reads the sports index', async () => {
    const { api, spy } = makeSpied();
    await api.addSource({ kind: 'xtream', name: 'Fake', server: sportsServer.url, username: 'test', password: 'test' });
    await api.idle();
    spy.mockClear();
    await api.getSportsEvents();
    await api.getSportsEvents();
    expect(spy).toHaveBeenCalledTimes(1);
    await api.refresh('epg');
    await api.getSportsEvents();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('getStartHome writes the stored page only when the rows changed', async () => {
    class Counting extends MemoryStorage {
      startWrites = 0;
      override async setMeta(key: string, value: unknown) {
        if (key.startsWith('startHome:')) this.startWrites++;
        return super.setMeta(key, value);
      }
    }
    const st = new Counting();
    const { api } = make(st);
    await api.addSource({ kind: 'xtream', name: 'Fake', server: sportsServer.url, username: 'test', password: 'test' });
    await api.idle();
    const first = await api.getStartHome();
    expect(first.rows.length).toBeGreaterThan(0);
    expect(st.startWrites).toBe(1);
    const second = await api.getStartHome();
    expect(second.rows).toEqual(first.rows);
    expect(st.startWrites).toBe(1); // same rows: no readwrite transaction
    expect(await api.getStartHomeCached()).toEqual(second);
    // A favourite no longer shows on Start: same rows, still no write.
    const ch = (await api.getChannelSlice('all', 0, 1)).rows[0]!;
    await api.toggleFavourite(ch.id);
    const third = await api.getStartHome();
    expect(third.rows).toEqual(first.rows);
    expect(st.startWrites).toBe(1);
    // Hiding an airing channel changes the matches row: the page is rewritten once.
    const nb = (await api.getSportsEvents()).find((e) => e.title.includes('Northbridge'))!;
    const evRows = await api.getEventChannels(nb.key);
    await api.toggleHidden(evRows[0]!.id);
    const fourth = await api.getStartHome();
    expect(fourth.rows).not.toEqual(first.rows);
    expect(st.startWrites).toBe(2);
    await api.getStartHome();
    expect(st.startWrites).toBe(2);
  });

  test('deleteSource clears the stored Start page and the cached answer', async () => {
    const st = new MemoryStorage();
    const { api } = make(st);
    const { sourceId } = await api.addSource({ kind: 'xtream', name: 'Fake', server: sportsServer.url, username: 'test', password: 'test' });
    await api.idle();
    await api.getStartHome();
    expect(await st.getMeta(`startHome:${sourceId}`)).toBeTruthy();
    await api.deleteSource(sourceId);
    expect(await st.getMeta(`startHome:${sourceId}`)).toBeNull();
    expect(await api.getStartHomeCached()).toBeUndefined();
  });
});

describe('AppApi – trending rows', () => {
  const FEED_BASE = 'https://feed.example.test/trending';
  const feedFor = (kind: 'movie' | 'series') => ({
    v: 1, kind, lang: 'en', at: '2026-10-20T00:00:00Z',
    items: kind === 'movie'
      ? [3, 1, 5, 7, 9].map((n, i) => ({ rank: i + 1, wd: `Q${900_000 + n}`, year: 2000 + n, titles: [`Synthetic Film ${String(n).padStart(3, '0')}`] }))
        .concat([{ rank: 6, wd: 'Q999999', year: 2030, titles: ['Synthetic Absent Film'] }])
      : [{ rank: 1, wd: 'Q1', titles: ['Synthetic Series 01'] }],
  });

  const makeTrending = (feedFetch: (url: string, init: RequestInit) => Promise<Response>) => {
    const st = new MemoryStorage();
    const deps = { storage: st, fetch: (u: string, i?: RequestInit) => fetch(u, i), now: () => NOW };
    const api = new AppApi({
      service: new SourceService(deps), vod: new VodService(deps), storage: st, emit: () => {}, now: () => NOW,
      trending: { baseUrl: FEED_BASE, fetch: feedFetch },
    });
    live.push(api);
    return api;
  };

  test('the library\'s trending titles after Sports and before Recently added; at least 4; absent titles never shown', async () => {
    const asked: string[] = [];
    const api = makeTrending(async (url, init) => {
      asked.push(url);
      expect(init).toEqual({ credentials: 'omit', referrerPolicy: 'no-referrer' });
      const kind = url.includes('/movie.') ? 'movie' : 'series';
      return new Response(JSON.stringify(feedFor(kind)));
    });
    await api.addSource(xt());
    await api.idle();
    await api.getStartHome(); // first visit: the feed is fetched in the background
    await api.idle();
    await api.getVodHome('movie');
    await api.idle();
    await api.getVodHome('movie');
    const h = await api.getStartHome();
    const ids = h.rows.map((r) => r.id);
    expect(ids.indexOf('trendingMovies')).toBeLessThan(ids.indexOf('newLibrary'));
    const row = h.rows.find((r) => r.id === 'trendingMovies')!;
    // Five title + exact year matches: numbered 1..5; the feed is fresh.
    expect(row.title).toBe('Top movies this week');
    expect(row.cells.map((c) => (c.type === 'vod' ? c.rank : undefined))).toEqual([1, 2, 3, 4, 5]);
    // A numbered Top row turns that kind's Top rated row off.
    expect(ids).not.toContain('topMovies');
    expect(row.cells.map((c) => (c.type === 'vod' ? c.tile.title : ''))).toEqual(
      ['Synthetic Film 003', 'Synthetic Film 001', 'Synthetic Film 005', 'Synthetic Film 007', 'Synthetic Film 009'],
    );
    // One series matches: under the minimum of 4, so no row.
    expect(ids).not.toContain('trendingSeries');
    expect(asked.every((u) => u.startsWith(`${FEED_BASE}/v1/`))).toBe(true);
  });

  test('Movies opened before any feed was fetched, then Series, then Start: the movie row still fills', async () => {
    // The movie snapshot is taken on the Movies visit while the feed is still on its way; the Series visit then makes
    // series the resident catalogue, so Start cannot recompute movies. The snapshot must pick the feed up once it lands.
    const api = makeTrending(async (url) => new Response(JSON.stringify(feedFor(url.includes('/movie.') ? 'movie' : 'series'))));
    await api.addSource(xt());
    await api.idle();
    // Each tab asks again once its catalogue has loaded (the screen reloads on vodRefreshed).
    for (const kind of ['movie', 'series'] as const) {
      await api.getVodHome(kind);
      await api.idle();
      await api.getVodHome(kind);
    }
    await api.idle();
    const h = await api.getStartHome();
    const row = h.rows.find((r) => r.id === 'trendingMovies');
    expect(row?.cells.map((c) => (c.type === 'vod' ? c.tile.title : ''))).toEqual(
      ['Synthetic Film 003', 'Synthetic Film 001', 'Synthetic Film 005', 'Synthetic Film 007', 'Synthetic Film 009'],
    );
  });

  test('without a feed URL there is no trending row and no request', async () => {
    const { api } = makeVod(new MemoryStorage(), async (u, i) => {
      expect(u).not.toContain('trending');
      return fetch(u, i);
    });
    await api.addSource(xt());
    await api.idle();
    await api.getVodHome('movie');
    await api.idle();
    await api.getVodHome('movie');
    const h = await api.getStartHome();
    expect(h.rows.map((r) => r.id)).not.toContain('trendingMovies');
  });

  test('a failing feed never fails Start', async () => {
    const api = makeTrending(async () => { throw new TypeError('fetch failed'); });
    await api.addSource(xt());
    await api.idle();
    const h = await api.getStartHome();
    await api.idle();
    expect(h.rows.map((r) => r.id)).not.toContain('trendingMovies');
  });
});
