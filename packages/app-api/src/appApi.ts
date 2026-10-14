import {
  ChannelIndex, GROUP_ALL, alternateStreamUrl, applyShift, nowNext, redactUrl,
  type AppSettings, type Channel, type GroupInfo, type NewSource, type Programme, type SourceConfig,
  type SourceService, type Storage,
} from '@iptv/core';
import { toRpcError } from './rpc.ts';
import type {
  AppEvent, ChannelRow, DiagnosticsInfo, InitState, PlayableChannel, ProgrammeLite, SourceSummary,
} from './types.ts';

const NOW_NEXT_TTL_MS = 60_000;
const ERROR_RING = 20;
const HOUR = 3_600_000;
/** Extra stored-guide margin around "now" when picking now/next, so long programmes are still found. */
const NOW_NEXT_MARGIN_MS = 6 * HOUR;
/** Requested row windows remembered per source; a queued short-EPG lookup outside all of them is dropped. */
const VISIBLE_WINDOWS = 2;

const noop = () => { /* settled */ };

interface NowNext { now?: Programme; next?: Programme }

/** Strips query, fragment and Xtream path credentials from every URL so no login can reach a message. */
export function scrub(message: string): string {
  return message.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, (m) => redactUrl(m).replace(/[?#].*$/, ''));
}

export interface AppApiDeps {
  service: SourceService;
  /**
   * Same storage the service uses; AppApi reads/writes the small per-source meta keys and reads the
   * rebuilt channel list through it. Accepted deviation from the brief, which lists only `service`.
   */
  storage: Storage;
  emit: (e: AppEvent) => void;
  now?: () => number;
  appVersion?: string;
}

export class AppApi {
  private readonly service: SourceService;
  private readonly storage: Storage;
  private readonly emit: (e: AppEvent) => void;
  private readonly now: () => number;
  private readonly appVersion: string;

  private activeId: string | undefined;
  private index = new ChannelIndex([]);
  private favSet: Set<string> | undefined;
  private settings: AppSettings | undefined;
  private nnCache = new Map<string, { at: number; nn: NowNext }>();
  /** Bumped whenever cached now/next may be stale, so in-flight lookups do not repopulate the cache. */
  private generation = 0;
  private offline = false;
  /** Per-source serial queue: background refreshes, explicit refreshes and deletes run one at a time. */
  private readonly queues = new Map<string, Promise<void>>();
  /** Background task per source; `rerun` asks a running task to loop once more when it finishes. */
  private readonly background = new Map<string, { started: boolean; rerun: boolean }>();
  /** Serialises flag mutations with index swaps, so a toggle is never lost or saved to the wrong source. */
  private indexLock: Promise<void> = Promise.resolve();
  /** Channels whose background short-EPG lookup is running (not started twice). */
  private readonly shortPending = new Set<string>();
  /** Background short-EPG lookups in flight (awaited by the test-only `idle`). */
  private readonly shortJobs = new Set<Promise<void>>();
  /** The last `VISIBLE_WINDOWS` requested row windows (channel ids) per source, newest last. */
  private readonly windows = new Map<string, Set<string>[]>();
  private readonly errors: DiagnosticsInfo['lastErrors'] = [];
  private readonly recorded = new WeakSet<object>();

  constructor(deps: AppApiDeps) {
    this.service = deps.service;
    this.storage = deps.storage;
    this.emit = deps.emit;
    this.now = deps.now ?? Date.now;
    this.appVersion = deps.appVersion ?? '0.0.0';
  }

  // ---- lifecycle & sources ----

  init(): Promise<InitState> {
    return this.run('init', async () => {
      const id = await this.resolveActive();
      await this.activate(id);
      if (id) this.startBackground(id);
      return this.initState();
    });
  }

  listSources(): Promise<SourceSummary[]> {
    return this.run('listSources', () => this.summaries());
  }

  getSource(id: string): Promise<SourceConfig | undefined> {
    return this.run('getSource', async () => (await this.service.listSources()).find((s) => s.id === id));
  }

  addSource(input: NewSource): Promise<{ sourceId: string; channelCount: number }> {
    return this.run('addSource', async () => {
      const { source, result } = await this.service.addSource(input, (p) => this.emit({ type: 'progress', ...p }));
      const active = await this.service.getActiveSourceId();
      if (active === source.id) {
        await this.activate(source.id);
        this.startBackground(source.id);
      }
      return { sourceId: source.id, channelCount: result.channelCount };
    });
  }

  updateSource(source: SourceConfig): Promise<{ channelCount: number }> {
    return this.run('updateSource', async () => {
      const result = await this.service.updateSource(source, (p) => this.emit({ type: 'progress', ...p }));
      if (this.activeId === source.id) {
        await this.activate(source.id);
        this.startBackground(source.id);
      }
      return { channelCount: result.channelCount };
    });
  }

  deleteSource(id: string): Promise<InitState> {
    return this.run('deleteSource', async () => {
      // Queued behind any background task of this source, so nothing writes to it after the delete.
      await this.enqueue(id, () => this.service.deleteSource(id));
      this.windows.delete(id);
      for (const key of [`flags:${id}`, `lastChannel:${id}`, `lastGroup:${id}`]) await this.storage.setMeta(key, null);
      const next = await this.resolveActive();
      if (next !== this.activeId || id === this.activeId) {
        await this.activate(next);
        if (next) this.startBackground(next);
      }
      return this.initState();
    });
  }

  setActiveSource(id: string): Promise<InitState> {
    return this.run('setActiveSource', async () => {
      await this.service.setActiveSource(id);
      await this.activate(id);
      this.startBackground(id);
      return this.initState();
    });
  }

  refresh(what: 'playlist' | 'epg' | 'both'): Promise<void> {
    return this.run('refresh', async () => {
      const id = this.activeId;
      if (!id) return;
      // Waits for a running background refresh of the same source, then runs the requested steps.
      await this.enqueue(id, async () => {
        if (what !== 'epg') await this.refreshPlaylistFor(id);
        if (what !== 'playlist') await this.refreshEpgFor(id);
      });
    });
  }

  // ---- browsing ----

  getGroups(): Promise<GroupInfo[]> {
    return this.run('getGroups', async () => (this.activeId ? this.index.groups() : []));
  }

  getChannelSlice(groupId: string, offset: number, count: number): Promise<{ total: number; rows: ChannelRow[] }> {
    return this.run('getChannelSlice', async () => ({
      total: this.index.groupSize(groupId),
      rows: await this.toRows(this.index.slice(groupId, offset, count)),
    }));
  }

  /** Position of `channelId` among the visible channels of `groupId`, or -1 (Home restores focus by id with it). */
  indexOf(groupId: string, channelId: string): Promise<number> {
    return this.run('indexOf', async () => this.index.indexOf(groupId, channelId));
  }

  getPlayable(channelId: string): Promise<PlayableChannel | undefined> {
    return this.run('getPlayable', () => this.playable(this.index.get(channelId)));
  }

  neighbour(groupId: string, channelId: string, delta: number): Promise<PlayableChannel | undefined> {
    return this.run('neighbour', () => this.playable(this.index.neighbour(groupId, channelId, delta)));
  }

  byNumber(n: number): Promise<PlayableChannel | undefined> {
    return this.run('byNumber', () => this.playable(this.index.byNumber(n)));
  }

  getEpgRows(groupId: string, offset: number, count: number, from: number, to: number):
    Promise<{ total: number; rows: { channel: ChannelRow; programmes: ProgrammeLite[] }[] }> {
    return this.run('getEpgRows', async () => {
      const channels = this.index.slice(groupId, offset, count);
      // The guide grid shows stored programmes only: no background short-EPG lookups from here.
      const rows = await this.toRows(channels, false);
      const id = this.activeId;
      const settings = await this.currentSettings();
      const shifts = channels.map((c) => settings.epgOffsetHours + (c.epgShift ?? 0));
      let byChannel = new Map<string, Programme[]>();
      if (id && channels.length) {
        // Displayed = stored + shift, so the stored window is [from - shift, to - shift]; widen it to cover every channel.
        const lo = from - Math.max(...shifts) * HOUR;
        const hi = to - Math.min(...shifts) * HOUR;
        byChannel = await this.service.programmesFor(id, channels, lo, hi);
      }
      return {
        total: this.index.groupSize(groupId),
        rows: channels.map((c, i) => {
          const hours = shifts[i]!;
          const programmes = (byChannel.get(c.id) ?? [])
            .map((p) => applyShift(p, hours))
            .filter((p) => p.stop > from && p.start < to)
            .sort((a, b) => a.start - b.start)
            .map(toLite);
          return { channel: rows[i]!, programmes };
        }),
      };
    });
  }

  search(query: string, limit: number): Promise<ChannelRow[]> {
    return this.run('search', async () => this.toRows(this.index.search(query, limit)));
  }

  // ---- user flags ----

  toggleFavourite(channelId: string): Promise<boolean> {
    return this.run('toggleFavourite', () => this.withIndex(async () => {
      if (!this.index.get(channelId)) return false;
      const on = !this.favourites().has(channelId);
      this.index.setFavourite(channelId, on);
      this.favSet = undefined;
      await this.persistFlags();
      return on;
    }));
  }

  toggleHidden(channelId: string): Promise<boolean> {
    return this.run('toggleHidden', () => this.withIndex(async () => {
      if (!this.index.get(channelId)) return false;
      const on = !this.index.flags().hidden.includes(channelId);
      this.index.setHidden(channelId, on);
      await this.persistFlags();
      return on;
    }));
  }

  hiddenChannels(): Promise<ChannelRow[]> {
    return this.run('hiddenChannels', async () => this.toRows(this.index.hiddenChannels()));
  }

  markWatched(channelId: string, groupId: string): Promise<void> {
    return this.run('markWatched', () => this.withIndex(async () => {
      const id = this.activeId;
      if (!id || !this.index.get(channelId)) return;
      this.index.markWatched(channelId);
      await this.persistFlags();
      await this.storage.setMeta(`lastChannel:${id}`, channelId);
      await this.storage.setMeta(`lastGroup:${id}`, groupId);
    }));
  }

  // ---- settings, cache, diagnostics ----

  getSettings(): Promise<AppSettings> {
    return this.run('getSettings', () => this.currentSettings());
  }

  saveSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
    return this.run('saveSettings', async () => {
      this.settings = await this.service.saveSettings(partial);
      // Cached now/next was picked on the old offset's timeline.
      this.invalidateNowNext();
      return this.settings;
    });
  }

  clearCache(): Promise<InitState> {
    return this.run('clearCache', async () => {
      const id = this.activeId;
      if (id) {
        await this.service.clearCachedData(id);
        await this.activate(id);
        this.startBackground(id);
      }
      return this.initState();
    });
  }

  diagnostics(): Promise<DiagnosticsInfo> {
    return this.run('diagnostics', async () => {
      const sources = await Promise.all((await this.service.listSources()).map(async (s) => {
        const stats = await this.storage.getMeta<{ channelCount?: number; skipped?: number }>(`parseStats:${s.id}`);
        return {
          id: s.id,
          name: s.name,
          kind: s.kind,
          channels: stats?.channelCount ?? 0,
          skipped: stats?.skipped ?? 0,
          playlistAt: (await this.storage.getMeta<number>(`playlistAt:${s.id}`)) ?? 0,
          epgAt: (await this.storage.getMeta<number>(`epgAt:${s.id}`)) ?? 0,
        };
      }));
      return {
        appVersion: this.appVersion,
        sources,
        lastErrors: this.errors.map((e) => ({ ...e })),
        settings: await this.currentSettings(),
      };
    });
  }

  /** Test-only: resolves once every per-source queue (background and explicit refreshes) is empty. Not exposed over RPC. */
  async idle(): Promise<void> {
    while (this.queues.size || this.shortJobs.size) {
      await Promise.all([...this.queues.values(), ...this.shortJobs]);
    }
  }

  // ---- internals ----

  /** Wraps every public call: records failures (credential-free) and rethrows. */
  private async run<T>(where: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw this.record(where, err);
    }
  }

  /** Returns what to rethrow: the original Error when its message is clean, else a new Error with the scrubbed message. */
  private record(where: string, err: unknown): Error {
    const rpc = toRpcError(err);
    const message = scrub(rpc.message);
    const out = err instanceof Error && message === rpc.message
      ? err
      : Object.assign(new Error(message), { name: rpc.name, ...(rpc.status !== undefined ? { status: rpc.status } : {}) });
    if (this.recorded.has(out)) return out;
    this.recorded.add(out);
    this.errors.push({ at: this.now(), where, message });
    if (this.errors.length > ERROR_RING) this.errors.shift();
    return out;
  }

  private async currentSettings(): Promise<AppSettings> {
    this.settings ??= await this.service.getSettings();
    return this.settings;
  }

  private async summaries(): Promise<SourceSummary[]> {
    const active = this.activeId;
    return (await this.service.listSources()).map((s) => ({ id: s.id, name: s.name, kind: s.kind, active: s.id === active }));
  }

  private async initState(): Promise<InitState> {
    const id = this.activeId;
    const state: InitState = {
      sources: await this.summaries(),
      groups: id ? this.index.groups() : [],
      settings: await this.currentSettings(),
    };
    if (id) {
      state.activeSourceId = id;
      const lastChannel = await this.storage.getMeta<string>(`lastChannel:${id}`);
      const lastGroup = await this.storage.getMeta<string>(`lastGroup:${id}`);
      if (lastChannel) state.lastChannelId = lastChannel;
      if (lastGroup) state.lastGroupId = lastGroup;
    }
    return state;
  }

  /** The stored active id if it still exists, else the first source (persisted), else undefined. */
  private async resolveActive(): Promise<string | undefined> {
    const sources = await this.service.listSources();
    const stored = await this.service.getActiveSourceId();
    if (stored && sources.some((s) => s.id === stored)) return stored;
    const first = sources[0]?.id;
    if (first) await this.service.setActiveSource(first);
    return first;
  }

  /** Makes `id` the in-memory active source and loads its cached index; both are swapped in together. */
  private activate(id: string | undefined): Promise<void> {
    return this.withIndex(async () => {
      const index = id ? await this.service.loadIndex(id) : new ChannelIndex([]);
      this.activeId = id;
      this.index = index;
      this.favSet = undefined;
      this.invalidateNowNext();
    });
  }

  /** After a playlist refresh: rebuild the active index from the new channels, keeping the in-memory flags. */
  private rebuildIndex(id: string): Promise<void> {
    return this.withIndex(async () => {
      if (this.activeId !== id) return;
      const channels = await this.storage.getChannels(id);
      this.index = new ChannelIndex(channels, this.index.flags());
      this.favSet = undefined;
      this.invalidateNowNext();
    });
  }

  /** Small mutex around the active index: swaps and flag mutations never interleave. */
  private withIndex<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.indexLock.then(fn);
    this.indexLock = run.then(noop, noop);
    return run;
  }

  /** Runs `fn` after everything already queued for source `id`. */
  private enqueue<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(id) ?? Promise.resolve()).then(fn);
    const tail = run.then(noop, noop);
    this.queues.set(id, tail);
    void tail.then(() => { if (this.queues.get(id) === tail) this.queues.delete(id); });
    return run;
  }

  private invalidateNowNext(): void {
    this.generation++;
    this.nnCache = new Map();
  }

  private favourites(): Set<string> {
    return (this.favSet ??= new Set(this.index.flags().favourites));
  }

  private async persistFlags(): Promise<void> {
    if (this.activeId) await this.service.saveFlags(this.activeId, this.index);
  }

  private setOffline(value: boolean): void {
    if (this.offline === value) return;
    this.offline = value;
    this.emit({ type: 'offline', value });
  }

  private failed(what: 'playlist' | 'epg', sourceId: string, where: string, err: unknown): never {
    const out = this.record(where, err);
    const error = toRpcError(out);
    if (error.name === 'SourceNetworkError' && error.status === undefined) this.setOffline(true);
    this.emit({ type: 'refreshFailed', what, sourceId, error });
    throw out;
  }

  private async refreshPlaylistFor(id: string): Promise<void> {
    try {
      await this.service.refreshPlaylist(id, (p) => this.emit({ type: 'progress', ...p }));
    } catch (err) {
      this.failed('playlist', id, 'refreshPlaylist', err);
    }
    await this.rebuildIndex(id);
    this.setOffline(false);
    this.emit({ type: 'refreshed', what: 'playlist', sourceId: id });
  }

  private async refreshEpgFor(id: string): Promise<void> {
    try {
      await this.service.refreshEpg(id, (p) => this.emit({ type: 'progress', ...p }));
    } catch (err) {
      this.failed('epg', id, 'refreshEpg', err);
    }
    if (this.activeId === id) this.invalidateNowNext();
    this.setOffline(false);
    this.emit({ type: 'refreshed', what: 'epg', sourceId: id });
  }

  /**
   * Fire-and-forget, through the source's queue: playlist first when stale or the cache is empty, then
   * the guide when stale. If a task is already running it loops once more afterwards, so callers that
   * just changed the data (clearCache, updateSource) always get a repopulating pass.
   */
  private startBackground(id: string): void {
    const existing = this.background.get(id);
    if (existing) {
      // A task that has not started yet will see the new state anyway.
      if (existing.started) existing.rerun = true;
      return;
    }
    const state = { started: false, rerun: false };
    this.background.set(id, state);
    void this.enqueue(id, async () => {
      state.started = true;
      try {
        do {
          state.rerun = false;
          try {
            await this.backgroundRefresh(id);
          } catch {
            // Already recorded and emitted as refreshFailed.
          }
        } while (state.rerun);
      } finally {
        this.background.delete(id);
      }
    });
  }

  private async backgroundRefresh(id: string): Promise<void> {
    let playlist: boolean;
    try {
      playlist = (this.activeId === id && this.totalChannels() === 0) || await this.service.needsPlaylistRefresh(id);
    } catch (err) {
      this.failed('playlist', id, 'backgroundRefresh', err);
    }
    if (playlist) await this.refreshPlaylistFor(id);
    let epg: boolean;
    try {
      epg = await this.service.needsEpgRefresh(id);
    } catch (err) {
      this.failed('epg', id, 'backgroundRefresh', err);
    }
    if (epg) await this.refreshEpgFor(id);
  }

  /** Every channel in the active index, hidden ones included. */
  private totalChannels(): number {
    return this.index.groupSize(GROUP_ALL) + this.index.hiddenChannels().length;
  }

  /** Remembers `channels` as the newest requested row window of the active source. */
  private noteWindow(channels: Channel[]): void {
    const id = this.activeId;
    if (!id) return;
    const list = this.windows.get(id) ?? [];
    list.push(new Set(channels.map((c) => c.id)));
    while (list.length > VISIBLE_WINDOWS) list.shift();
    this.windows.set(id, list);
  }

  private inVisibleWindow(id: string, channelId: string): boolean {
    return (this.windows.get(id) ?? []).some((w) => w.has(channelId));
  }

  private async nowNextCached(channels: Channel[], shortEpg: boolean): Promise<Map<string, NowNext>> {
    const out = new Map<string, NowNext>();
    const id = this.activeId;
    if (!id || channels.length === 0) return out;
    const t = this.now();
    const misses: Channel[] = [];
    for (const c of channels) {
      const hit = this.nnCache.get(c.id);
      if (hit && t - hit.at < NOW_NEXT_TTL_MS) out.set(c.id, hit.nn);
      else misses.push(c);
    }
    if (misses.length) {
      const gen = this.generation;
      const fetched = await this.lookupNowNext(id, misses, t, shortEpg);
      for (const c of misses) {
        const nn = fetched.get(c.id) ?? {};
        out.set(c.id, nn);
        // A background short-EPG answer may already have landed for this channel: keep it.
        const landed = this.nnCache.get(c.id);
        if (gen === this.generation && !(landed && landed.at >= t)) this.nnCache.set(c.id, { at: t, nn });
      }
    }
    return out;
  }

  /**
   * Now/next on the displayed (shifted) timeline: "now" is the programme whose shifted interval contains `t`.
   * Stored programmes only, fetched over a window wide enough for every channel's shift, so this never waits on
   * the network. Channels with nothing stored get an empty pair now and a background short-EPG lookup
   * (`startShortEpg`), whose answers update the cache and are announced with `nowNextUpdated`.
   */
  private async lookupNowNext(id: string, channels: Channel[], t: number, shortEpg: boolean): Promise<Map<string, NowNext>> {
    const settings = await this.currentSettings();
    const hours = channels.map((c) => settings.epgOffsetHours + (c.epgShift ?? 0));
    const lo = t - Math.max(...hours) * HOUR - NOW_NEXT_MARGIN_MS;
    const hi = t - Math.min(...hours) * HOUR + NOW_NEXT_MARGIN_MS;
    const stored = await this.service.programmesFor(id, channels, lo, hi);
    const out = new Map<string, NowNext>();
    const missing: { c: Channel; h: number }[] = [];
    channels.forEach((c, i) => {
      const h = hours[i]!;
      const list = stored.get(c.id) ?? [];
      if (list.length === 0) missing.push({ c, h });
      out.set(c.id, nowNext(list.map((p) => applyShift(p, h)), t));
    });
    if (missing.length && shortEpg) this.startShortEpg(id, missing);
    return out;
  }

  /**
   * Fire-and-forget Xtream short-EPG lookup for channels without stored programmes (the service caps the
   * concurrency, bounds the waiting queue and skips it while a guide refresh of the source runs). A lookup is
   * stale, and sends no request, once the generation or the active source changed, the source was deleted, or
   * the channel is in none of the last `VISIBLE_WINDOWS` requested row windows. Answers for a source or
   * generation that is no longer current are dropped.
   */
  private startShortEpg(id: string, missing: { c: Channel; h: number }[]): void {
    if (this.service.isRefreshingEpg(id)) return;
    const todo = missing.filter(({ c }) => !this.shortPending.has(c.id));
    if (todo.length === 0) return;
    for (const { c } of todo) this.shortPending.add(c.id);
    const gen = this.generation;
    const isStale = (c: Channel) =>
      gen !== this.generation || this.activeId !== id || !this.inVisibleWindow(id, c.id);
    const job = this.service.shortEpgFor(id, todo.map((m) => m.c), { isStale }).then((found) => {
      if (gen !== this.generation || this.activeId !== id) return;
      const t = this.now();
      const changed: string[] = [];
      for (const { c, h } of todo) {
        const pair = found.get(c.id);
        if (!pair) continue;
        const list = [pair.now, pair.next].filter((p): p is Programme => p !== undefined).map((p) => applyShift(p, h));
        const nn = nowNext(list, t);
        this.nnCache.set(c.id, { at: t, nn });
        if (nn.now || nn.next) changed.push(c.id);
      }
      if (changed.length) this.emit({ type: 'nowNextUpdated', channelIds: changed });
    }, noop).finally(() => {
      for (const { c } of todo) this.shortPending.delete(c.id);
      this.shortJobs.delete(job);
    });
    this.shortJobs.add(job);
  }

  /** `shortEpg`: whether channels without a stored guide get a background short-EPG lookup (a visible window). */
  private async toRows(channels: Channel[], shortEpg = true): Promise<ChannelRow[]> {
    if (channels.length === 0) return [];
    if (shortEpg) this.noteWindow(channels);
    const nn = await this.nowNextCached(channels, shortEpg);
    const favs = this.favourites();
    return channels.map((c) => {
      const pair = nn.get(c.id);
      const row: ChannelRow = {
        id: c.id, number: c.number, name: c.name, group: c.group, favourite: favs.has(c.id),
      };
      if (c.logo) row.logo = c.logo;
      if (pair?.now) row.now = toLite(pair.now);
      if (pair?.next) row.next = toLite(pair.next);
      return row;
    });
  }

  private async playable(channel: Channel | undefined): Promise<PlayableChannel | undefined> {
    if (!channel) return undefined;
    const [row] = await this.toRows([channel]);
    const settings = await this.currentSettings();
    let url = channel.url;
    let alternateUrl = alternateStreamUrl(url);
    if (alternateUrl) {
      const isHls = /\.m3u8(?:[?#]|$)/.test(url);
      if (isHls !== (settings.preferredFormat === 'm3u8')) [url, alternateUrl] = [alternateUrl, url];
    }
    const out: PlayableChannel = { ...row!, url };
    if (alternateUrl) out.alternateUrl = alternateUrl;
    return out;
  }
}

function toLite(p: Programme): ProgrammeLite {
  const out: ProgrammeLite = { title: p.title, start: p.start, stop: p.stop };
  if (p.desc) out.desc = p.desc;
  return out;
}

/** Methods callable over RPC; the worker passes this to `expose` so internals (and `idle`) stay unreachable. */
export const APP_API_METHODS = [
  'init', 'listSources', 'getSource', 'addSource', 'updateSource', 'deleteSource', 'setActiveSource', 'refresh',
  'getGroups', 'getChannelSlice', 'indexOf', 'getPlayable', 'neighbour', 'byNumber', 'getEpgRows', 'search',
  'toggleFavourite', 'toggleHidden', 'hiddenChannels', 'markWatched',
  'getSettings', 'saveSettings', 'clearCache', 'diagnostics',
] as const satisfies readonly (keyof AppApi)[];

// Compile-time check: every public method except the test-only `idle` is listed above.
const exhaustive: [Exclude<Exclude<keyof AppApi, 'idle'>, (typeof APP_API_METHODS)[number]>] extends [never] ? true : never = true;
void exhaustive;
