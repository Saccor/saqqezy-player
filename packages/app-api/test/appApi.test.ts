import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { SourceService, SourceAuthError, type Channel } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { startFakeXtream } from '@iptv/fake-xtream';
import { APP_API_METHODS, AppApi, scrub } from '../src/appApi.ts';
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

const make = (st: MemoryStorage = storage, Svc: typeof SourceService = SourceService) => {
  const events: AppEvent[] = [];
  const service = new Svc({ storage: st, fetch: (u, i) => fetch(u, i), now: () => NOW });
  const api = new AppApi({ service, storage: st, emit: (e) => events.push(e), now: () => NOW, appVersion: '1.2.3' });
  live.push(api);
  return { api, events };
};
const xt = (username = 'test', password = 'test') =>
  ({ kind: 'xtream' as const, name: 'Fake', server: server.url, username, password });
const settle = () => new Promise((r) => setTimeout(r, 50));
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => { open = r; });
  return { p, open };
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

  test('search', async () => {
    const { api } = make();
    await api.addSource(xt());
    const r = await api.search('channel 007', 5);
    expect(r.map((c) => c.name)).toEqual(['Channel 007']);
    expect(await api.search('', 5)).toEqual([]);
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
