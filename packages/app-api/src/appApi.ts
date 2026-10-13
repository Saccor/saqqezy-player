import {
  ChannelIndex, GROUP_ALL, alternateStreamUrl, applyShift, redactUrl,
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

interface NowNext { now?: Programme; next?: Programme }

/** Strips URLs down to scheme, host and path so no token or login can reach a message. */
function scrub(message: string): string {
  return message.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, (m) => redactUrl(m).replace(/[?#].*$/, ''));
}

export interface AppApiDeps {
  service: SourceService;
  /** Same storage the service uses; AppApi reads/writes the small per-source meta keys through it. */
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
  private readonly background = new Map<string, Promise<void>>();
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
      await this.service.deleteSource(id);
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
      if (what !== 'epg') await this.refreshPlaylistFor(id);
      if (what !== 'playlist') await this.refreshEpgFor(id);
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
      const rows = await this.toRows(channels);
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
    return this.run('toggleFavourite', async () => {
      if (!this.index.get(channelId)) return false;
      const on = !this.favourites().has(channelId);
      this.index.setFavourite(channelId, on);
      this.favSet = undefined;
      await this.persistFlags();
      return on;
    });
  }

  toggleHidden(channelId: string): Promise<boolean> {
    return this.run('toggleHidden', async () => {
      if (!this.index.get(channelId)) return false;
      const on = !this.index.flags().hidden.includes(channelId);
      this.index.setHidden(channelId, on);
      await this.persistFlags();
      return on;
    });
  }

  hiddenChannels(): Promise<ChannelRow[]> {
    return this.run('hiddenChannels', async () => this.toRows(this.index.hiddenChannels()));
  }

  markWatched(channelId: string, groupId: string): Promise<void> {
    return this.run('markWatched', async () => {
      const id = this.activeId;
      if (!id || !this.index.get(channelId)) return;
      this.index.markWatched(channelId);
      await this.persistFlags();
      await this.storage.setMeta(`lastChannel:${id}`, channelId);
      await this.storage.setMeta(`lastGroup:${id}`, groupId);
    });
  }

  // ---- settings, cache, diagnostics ----

  getSettings(): Promise<AppSettings> {
    return this.run('getSettings', () => this.currentSettings());
  }

  saveSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
    return this.run('saveSettings', async () => {
      this.settings = await this.service.saveSettings(partial);
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

  // ---- internals ----

  /** Wraps every public call: records failures (credential-free) and rethrows. */
  private async run<T>(where: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw this.record(where, err);
    }
  }

  private record(where: string, err: unknown): unknown {
    const rpc = toRpcError(err);
    const message = scrub(rpc.message);
    const out = message === rpc.message || typeof err !== 'object' || err === null
      ? err
      : Object.assign(new Error(message), { name: rpc.name, ...(rpc.status !== undefined ? { status: rpc.status } : {}) });
    const key = out as object | null;
    if (key && typeof key === 'object' && this.recorded.has(key)) return out;
    if (key && typeof key === 'object') this.recorded.add(key);
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

  /** Makes `id` the in-memory active source and loads its cached index. */
  private async activate(id: string | undefined): Promise<void> {
    this.activeId = id;
    this.index = id ? await this.service.loadIndex(id) : new ChannelIndex([]);
    this.favSet = undefined;
    this.invalidateNowNext();
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
    if (this.activeId === id) await this.activate(id);
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

  /** Fire-and-forget: playlist first when stale or the cache is empty, then the guide when stale. */
  private startBackground(id: string): void {
    if (this.background.has(id)) return;
    const task = this.backgroundRefresh(id)
      .catch(() => { /* already recorded and emitted as refreshFailed */ })
      .finally(() => { this.background.delete(id); });
    this.background.set(id, task);
  }

  private async backgroundRefresh(id: string): Promise<void> {
    const emptyCache = this.activeId === id && this.index.groupSize(GROUP_ALL) === 0;
    if (emptyCache || await this.service.needsPlaylistRefresh(id)) await this.refreshPlaylistFor(id);
    if (await this.service.needsEpgRefresh(id)) await this.refreshEpgFor(id);
  }

  private async nowNextCached(channels: Channel[]): Promise<Map<string, NowNext>> {
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
      const fetched = await this.service.nowNextFor(id, misses);
      for (const c of misses) {
        const nn = fetched.get(c.id) ?? {};
        out.set(c.id, nn);
        if (gen === this.generation) this.nnCache.set(c.id, { at: t, nn });
      }
    }
    return out;
  }

  private async toRows(channels: Channel[]): Promise<ChannelRow[]> {
    if (channels.length === 0) return [];
    const [nn, settings] = await Promise.all([this.nowNextCached(channels), this.currentSettings()]);
    const favs = this.favourites();
    return channels.map((c) => {
      const hours = settings.epgOffsetHours + (c.epgShift ?? 0);
      const pair = nn.get(c.id);
      const row: ChannelRow = {
        id: c.id, number: c.number, name: c.name, group: c.group, favourite: favs.has(c.id),
      };
      if (c.logo) row.logo = c.logo;
      if (pair?.now) row.now = toLite(applyShift(pair.now, hours));
      if (pair?.next) row.next = toLite(applyShift(pair.next, hours));
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
