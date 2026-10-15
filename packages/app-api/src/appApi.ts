import {
  ChannelIndex, FAV_LIST_ID, GROUP_FAV, MAX_OPS_PER_BATCH, alternateStreamUrl, applyOps, applyShift, emptyLayout,
  epgKey, isLayoutOp, isLayoutOpBatch, nowNext, queryTitles, redactUrl,
  type AppSettings, type Channel, type GroupInfo, type IngestResult, type Layout, type LayoutOp, type NewSource, type Programme,
  type ProviderGroupInfo, type SeriesPointer, type SourceConfig, type SourceService, type Storage, type TitleIndexData,
  type VodKind, type VodService, type VodSort,
} from '@iptv/core';
import { toRpcError } from './rpc.ts';
import { VodController } from './vodController.ts';
import type {
  AppEvent, ChannelRow, CompanionChannel, CompanionControl, CompanionStartResult, CompanionStatus, CompanionState, DiagnosticsInfo, InitState, LayoutOpsResult, LayoutOrigin,
  ListSummary, MovieView, PlayableChannel, ProgrammeHit, ProgrammeLite, SearchResult, SeriesView, SourceSummary, TitleHit,
  VodCategoryView, VodHome, VodPlayable, VodTile, VodTracks,
} from './types.ts';

const NOW_NEXT_TTL_MS = 60_000;
const ERROR_RING = 20;
const HOUR = 3_600_000;
/** Extra stored-guide margin around "now" when picking now/next, so long programmes are still found. */
const NOW_NEXT_MARGIN_MS = 6 * HOUR;
/** Requested row windows remembered per source; a queued short-EPG lookup outside all of them is dropped. */
const VISIBLE_WINDOWS = 2;
/** Programme search: channel hits kept when programmes match too, the on-now cap, titles asked of the index. */
const SEARCH_CHANNELS_WITH_PROGRAMMES = 10;
const SEARCH_ON_NOW = 20;
const SEARCH_TITLES = 100;
/** The loaded title index is dropped this long after the last search (memory on 1 GB TVs). */
const TITLES_IDLE_MS = 2 * 60_000;

const noop = () => { /* settled */ };
const HAS = Object.prototype.hasOwnProperty;

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
  /**
   * Builds the phone companion host (the worker passes a CompanionHost factory). `onStatus` emits
   * `{ type: 'companion', status }`. Without it the companion methods report `idle` / not available.
   */
  companion?: (api: AppApi, onStatus: (status: CompanionStatus) => void) => CompanionControl;
  /** Movies and series. Without it, the VOD methods reject with "Movies and series are not available." */
  vod?: VodService;
}

export class AppApi {
  private readonly service: SourceService;
  private readonly storage: Storage;
  private readonly emit: (e: AppEvent) => void;
  private readonly now: () => number;
  private readonly appVersion: string;

  private activeId: string | undefined;
  private index = new ChannelIndex([]);
  /** The active source's channels as stored (playlist names), kept so layout and coverage rebuilds never refetch. */
  private channels: Channel[] = [];
  /** epgKeys with stored guide data for the active source; undefined until a guide was loaded. */
  private coverage: Set<string> | undefined;
  /** Lazily built: `channels` by id, to look renamed channels' guide up under their playlist name. */
  private originalById: Map<string, Channel> | undefined;
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
  /** The active source's title index, loaded on the first search. */
  private titles: { sourceId: string; data: TitleIndexData } | undefined;
  private titlesTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by every index swap, so a title index load that raced a swap is not cached. */
  private titlesEpoch = 0;
  /** Sources whose title index rebuild was already tried this session. */
  private readonly titleRebuilds = new Map<string, 'running' | 'done'>();
  /** The title index load in flight (one per source and epoch; concurrent searches join it). */
  private titleLoad: { sourceId: string; epoch: number } | undefined;
  /** Title index loads in flight (awaited by the test-only `idle`). */
  private readonly titleJobs = new Set<Promise<void>>();
  /** No title index for this source and epoch, and its one rebuild was already tried: channels only, not pending. */
  private titlesMissing: { sourceId: string; epoch: number } | undefined;
  private readonly errors: DiagnosticsInfo['lastErrors'] = [];
  private readonly recorded = new WeakSet<object>();
  private readonly companion: CompanionControl | undefined;
  private readonly vodc: VodController | undefined;
  private readonly vod: VodService | undefined;

  constructor(deps: AppApiDeps) {
    this.service = deps.service;
    this.storage = deps.storage;
    this.emit = (e) => {
      deps.emit(e);
      try {
        this.companion?.handleEvent(e);
      } catch {
        // The companion must never break the TV.
      }
    };
    this.now = deps.now ?? Date.now;
    this.appVersion = deps.appVersion ?? '0.0.0';
    this.companion = deps.companion?.(this, (status) => {
      // Why a session ended, for diagnostics (relay close reasons carry no secrets).
      if (status.state === 'expired' && status.reason) this.note('companion', `Phone session ended: ${status.reason}.`);
      deps.emit({ type: 'companion', status });
    });
    this.vod = deps.vod;
    this.vodc = deps.vod
      ? new VodController({ vod: deps.vod, emit: this.emit, record: (where, err) => this.record(where, err) })
      : undefined;
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

  /** `origin` says who asked (a paired companion passes 'remote'); every source change ends in a `sourcesChanged` event. */
  addSource(input: NewSource, origin: LayoutOrigin = 'local'): Promise<{ sourceId: string; channelCount: number }> {
    return this.run('addSource', async () => {
      const { source, result } = await this.service.addSource(input, (p) => this.emit({ type: 'progress', ...p }));
      this.companionStale();
      const active = await this.service.getActiveSourceId();
      if (active === source.id) {
        await this.activate(source.id);
        this.startBackground(source.id);
      }
      this.sourcesChanged(origin);
      return { sourceId: source.id, channelCount: result.channelCount };
    });
  }

  updateSource(source: SourceConfig, origin: LayoutOrigin = 'local'): Promise<{ channelCount: number }> {
    return this.run('updateSource', async () => {
      // The account may change under a running VOD fetch: cancel it before anything is rewritten.
      if (this.activeId === source.id) this.vodc?.invalidate(source.id);
      const result = await this.service.updateSource(source, (p) => this.emit({ type: 'progress', ...p }));
      this.companionStale();
      if (this.activeId === source.id) {
        await this.activate(source.id);
        this.startBackground(source.id);
      }
      this.sourcesChanged(origin);
      return { channelCount: result.channelCount };
    });
  }

  deleteSource(id: string, origin: LayoutOrigin = 'local'): Promise<InitState> {
    return this.run('deleteSource', async () => {
      // Queued behind any background task of this source, so nothing writes to it after the delete.
      await this.enqueue(id, () => this.service.deleteSource(id));
      this.companionStale();
      this.windows.delete(id);
      this.titleRebuilds.delete(id);
      for (const key of [`flags:${id}`, `layout:${id}`, `epgCoverage:${id}`, `lastChannel:${id}`, `lastGroup:${id}`, `titleIndex:${id}`]) {
        await this.storage.setMeta(key, null);
      }
      const next = await this.resolveActive();
      if (next !== this.activeId || id === this.activeId) {
        await this.activate(next);
        if (next) this.startBackground(next);
      }
      this.sourcesChanged(origin);
      return this.initState();
    });
  }

  setActiveSource(id: string, origin: LayoutOrigin = 'local'): Promise<InitState> {
    return this.run('setActiveSource', async () => {
      await this.service.setActiveSource(id);
      this.companionStale();
      await this.activate(id);
      this.startBackground(id);
      this.sourcesChanged(origin);
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
        byChannel = await this.service.programmesFor(id, this.originals(channels), lo, hi);
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

  search(query: string, limit: number): Promise<SearchResult> {
    return this.run('search', async () => {
      const id = this.activeId;
      const found = this.index.search(query, limit);
      const epoch = this.titlesEpoch;
      // Without guide data there is nothing to prepare: channels only.
      const guided = id !== undefined && this.coverage !== undefined && query.trim() !== '';
      // Never waits on loading the index: without it in memory, channels come back now and `searchReady` follows.
      const data = guided ? this.cachedTitles(id) : undefined;
      // Pending while a load or a rebuild is in flight; once both finished with no index, channels only.
      if (!data) {
        const guidePending = guided && this.titlesPending(id);
        return { channels: await this.toRows(found), onNow: [], later: [], guidePending };
      }
      const hits = await this.programmeHits(data, query);
      // The source changed during the awaits: the index state now belongs to another source.
      if (this.activeId !== id || this.titlesEpoch !== epoch) return { channels: await this.toRows(found), onNow: [], later: [], guidePending: false };
      const anyProgrammes = hits.onNow.length > 0 || hits.later.length > 0;
      const chans = anyProgrammes ? found.slice(0, SEARCH_CHANNELS_WITH_PROGRAMMES) : found;
      const onNow = hits.onNow.slice(0, Math.min(SEARCH_ON_NOW, Math.max(0, limit - chans.length)));
      const later = hits.later.slice(0, Math.max(0, limit - chans.length - onNow.length));
      const [channelRows, progRows] = await Promise.all([
        this.toRows(chans),
        // Programme rows never start background short-EPG lookups.
        this.toRows([...onNow.map((h) => h.c), ...later.map((h) => h.c)], false),
      ]);
      return {
        channels: channelRows,
        onNow: onNow.map((h, i): ProgrammeHit => ({ channel: progRows[i]!, title: h.title, start: h.start, stop: h.stop })),
        later: later.map((h, i): TitleHit => ({ channel: progRows[onNow.length + i]!, title: h.title, start: h.start, stop: h.stop, more: h.more })),
        guidePending: false,
      };
    });
  }

  // ---- layout ----

  /** The active source's layout (an empty one without a source). */
  getLayout(): Promise<Layout> {
    return this.run('getLayout', async () => this.index.layout());
  }

  /**
   * Validates and applies a batch of layout ops to the active source, persists the result and swaps in the
   * rebuilt index. Malformed ops, ops the reducer refuses, and every op of an oversized batch (more than
   * `MAX_OPS_PER_BATCH`) are reported in `rejected`. Emits `layoutChanged` when the layout changed.
   * With `sourceId` (a companion's ops), a batch made for another source than the active one throws
   * WrongSourceError and changes nothing.
   */
  applyLayoutOps(ops: LayoutOp[], origin: LayoutOrigin = 'local', sourceId?: string): Promise<LayoutOpsResult> {
    return this.run('applyLayoutOps', () => this.withIndex(async () => {
      // Checked under the index lock, so a source switch cannot slip in between the check and the change.
      if (sourceId !== undefined && sourceId !== this.activeId) throw new WrongSourceError();
      return this.applyLayoutLocked(ops, origin);
    }));
  }

  /** The active source's id with its layout, read together (for the companion's source-scoped `layoutChanged`). */
  getActiveLayout(): Promise<{ sourceId: string | undefined; layout: Layout }> {
    return this.run('getActiveLayout', async () => ({ sourceId: this.activeId, layout: this.index.layout() }));
  }

  listLists(): Promise<ListSummary[]> {
    return this.run('listLists', async () => this.index.layout().lists.map((l) => {
      const groupId = listGroupId(l.id);
      return { id: l.id, groupId, name: l.name, count: this.index.groupSize(groupId) };
    }));
  }

  /** Ids of the lists that contain `channelId` (for the context menu). */
  channelLists(channelId: string): Promise<string[]> {
    return this.run('channelLists', async () =>
      this.index.layout().lists.filter((l) => l.channelIds.includes(channelId)).map((l) => l.id));
  }

  hiddenGroups(): Promise<GroupInfo[]> {
    return this.run('hiddenGroups', async () => this.index.hiddenGroupInfos());
  }

  /** Every provider group of the active source, hidden ones included. */
  providerGroups(): Promise<ProviderGroupInfo[]> {
    return this.run('providerGroups', async () => this.index.allProviderGroups());
  }

  /**
   * Whether the active source's TV guide coverage is known (a guide has been downloaded), and whether the source
   * has a guide address at all (an M3U with a guide URL, or any Xtream source). Both false without an active source.
   */
  guideStatus(): Promise<{ coverageKnown: boolean; hasGuideUrl: boolean }> {
    return this.run('guideStatus', async () => {
      const id = this.activeId;
      if (!id) return { coverageKnown: false, hasGuideUrl: false };
      const source = (await this.service.listSources()).find((s) => s.id === id);
      const hasGuideUrl = source?.kind === 'xtream' || (source?.kind === 'm3u' && !!source.epgUrl);
      const coverageKnown = Array.isArray(await this.storage.getMeta<unknown>(`epgCoverage:${id}`));
      return { coverageKnown, hasGuideUrl };
    });
  }

  /** Snapshot for a companion: every channel (hidden ones included) and the layout. No credentials or stream URLs. */
  getCompanionState(): Promise<CompanionState> {
    return this.run('getCompanionState', async () => {
      const index = this.index;
      const coverage = this.coverage;
      const layout = index.layout();
      const channels = this.channels.map((c) => {
        const out: CompanionChannel = {
          id: c.id, name: c.name, group: c.group, number: c.number, hasEpg: coverage ? coverage.has(epgKey(c)) : true,
        };
        // Only renamed channels carry displayName; the companion shows `displayName ?? name`.
        const displayName = index.displayName(c.id);
        if (displayName !== undefined && displayName !== c.name) out.displayName = displayName;
        if (c.logo) out.logo = c.logo;
        return out;
      });
      const state: CompanionState = {
        version: layout.version, sources: await this.summaries(), groups: index.allProviderGroups(), channels, layout,
        coverageKnown: coverage !== undefined,
      };
      if (this.activeId) state.activeSourceId = this.activeId;
      return state;
    });
  }

  toggleFavourite(channelId: string): Promise<boolean> {
    return this.run('toggleFavourite', () => this.withIndex(async () => {
      if (!this.index.get(channelId)) return false;
      const on = !this.favourites().has(channelId);
      await this.applyLayoutLocked([on
        ? { op: 'addToList', listId: FAV_LIST_ID, channelIds: [channelId] }
        : { op: 'removeFromList', listId: FAV_LIST_ID, channelIds: [channelId] }], 'local');
      return this.favourites().has(channelId); // the real state: false if the change was refused
    }));
  }

  toggleHidden(channelId: string): Promise<boolean> {
    return this.run('toggleHidden', () => this.withIndex(async () => {
      if (!this.index.get(channelId)) return false;
      const on = !this.index.layout().hiddenChannels.includes(channelId);
      await this.applyLayoutLocked([{ op: on ? 'hideChannels' : 'unhideChannels', ids: [channelId] }], 'local');
      return this.index.layout().hiddenChannels.includes(channelId); // the real state, even if refused
    }));
  }

  hiddenChannels(): Promise<ChannelRow[]> {
    return this.run('hiddenChannels', async () => this.toRows(this.index.hiddenChannels()));
  }

  markWatched(channelId: string, groupId: string): Promise<void> {
    return this.run('markWatched', () => this.withIndex(async () => {
      const id = this.activeId;
      if (!id || !this.index.get(channelId)) return;
      await this.applyLayoutLocked([{ op: 'markWatched', id: channelId }], 'local');
      await this.storage.setMeta(`lastChannel:${id}`, channelId);
      await this.storage.setMeta(`lastGroup:${id}`, groupId);
    }));
  }

  // ---- phone companion ----

  /** Starts a new pairing session (replacing any current one). The result holds secrets for the pairing screen. */
  companionStart(mode: 'qr' | 'code'): Promise<CompanionStartResult> {
    return this.run('companionStart', async () => {
      if (!this.companion) throw new Error('The phone companion is not available.');
      if (mode !== 'qr' && mode !== 'code') throw new Error('Unknown pairing mode.');
      return this.companion.start(mode);
    });
  }

  /** Ends the current pairing session, if any (the companion gets a goodbye). */
  companionStop(): Promise<void> {
    return this.run('companionStop', async () => { this.companion?.stop(); });
  }

  companionStatus(): Promise<CompanionStatus> {
    return this.run('companionStatus', async () => this.companion?.status() ?? { state: 'idle' });
  }

  // ---- movies & series ----

  getVodHome(kind: VodKind): Promise<VodHome> {
    return this.run('getVodHome', () => this.vodFor(kind).home(kind));
  }

  getVodCategories(kind: VodKind): Promise<VodCategoryView[]> {
    return this.run('getVodCategories', () => this.vodFor(kind).categories(kind));
  }

  getVodSlice(kind: VodKind, categoryId: string, sort: VodSort, offset: number, count: number): Promise<{ total: number; rows: VodTile[] }> {
    return this.run('getVodSlice', async () => {
      const c = this.vodFor(kind);
      if (sort !== 'added' && sort !== 'title' && sort !== 'rating') throw new Error('Unknown sort order.');
      return c.slice(kind, categoryId, sort, offset, count);
    });
  }

  getMovie(id: string): Promise<MovieView | undefined> {
    return this.run('getMovie', () => this.vodOrThrow().movie(id));
  }

  getSeries(id: string): Promise<SeriesView | undefined> {
    return this.run('getSeries', () => this.vodOrThrow().series(id));
  }

  getVodPlayable(itemId: string, seriesId?: string): Promise<VodPlayable | undefined> {
    return this.run('getVodPlayable', () => this.vodOrThrow().playable(itemId, seriesId));
  }

  saveVodProgress(itemId: string, positionMs: number, durationMs: number, series?: SeriesPointer): Promise<void> {
    return this.run('saveVodProgress', () => this.vodOrThrow().saveProgress(itemId, positionMs, durationMs, series));
  }

  setVodFavourite(itemId: string, on: boolean): Promise<void> {
    return this.run('setVodFavourite', () => this.vodOrThrow().setFavourite(itemId, on));
  }

  setVodWatched(itemId: string, on: boolean, series?: SeriesPointer): Promise<void> {
    return this.run('setVodWatched', () => this.vodOrThrow().setWatched(itemId, on, series));
  }

  clearVodProgress(itemId: string): Promise<void> {
    return this.run('clearVodProgress', () => this.vodOrThrow().clearProgress(itemId));
  }

  setVodTracks(itemId: string, tracks: VodTracks): Promise<void> {
    return this.run('setVodTracks', () => this.vodOrThrow().setTracks(itemId, tracks));
  }

  refreshVod(kind: VodKind): Promise<void> {
    return this.run('refreshVod', () => this.vodFor(kind).refresh(kind));
  }

  /** Idle-time warm-up after live playback starts: loads the stored catalogue into memory; never fetches. */
  preloadVod(kind: VodKind): Promise<void> {
    return this.run('preloadVod', () => this.vodFor(kind).preload(kind));
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
    while (this.queues.size || this.shortJobs.size || this.titleJobs.size) {
      await Promise.all([...this.queues.values(), ...this.shortJobs, ...this.titleJobs]);
    }
    await this.vodc?.idle();
  }

  // ---- internals ----

  private vodOrThrow(): VodController {
    if (!this.vodc) throw new Error('Movies and series are not available.');
    return this.vodc;
  }

  /** The controller, after checking `kind` (RPC input). */
  private vodFor(kind: VodKind): VodController {
    if (kind !== 'movie' && kind !== 'series') throw new Error('Unknown kind of title.');
    return this.vodOrThrow();
  }

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
    this.note(where, message);
    return out;
  }

  /** Adds a credential-free message to the diagnostics ring. */
  private note(where: string, message: string): void {
    this.errors.push({ at: this.now(), where, message });
    if (this.errors.length > ERROR_RING) this.errors.shift();
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
      const [channels, layout, coverage] = id
        ? await Promise.all([this.storage.getChannels(id), this.service.loadLayout(id), this.service.loadEpgCoverage(id)])
        : [[], emptyLayout(), undefined];
      this.activeId = id;
      this.vodc?.reset(id);
      this.setIndex(channels, layout, coverage);
      this.invalidateNowNext();
    });
  }

  /** After a playlist refresh: rebuild the active index from the new channels, keeping the in-memory layout. */
  private rebuildIndex(id: string): Promise<void> {
    return this.withIndex(async () => {
      if (this.activeId !== id) return;
      const [channels, coverage] = await Promise.all([this.storage.getChannels(id), this.service.loadEpgCoverage(id)]);
      this.setIndex(channels, this.index.layout(), coverage);
      this.invalidateNowNext();
    });
  }

  /** After a guide refresh: rebuild the active index with the new coverage (the channels in memory are reused). */
  private reloadCoverage(id: string): Promise<void> {
    return this.withIndex(async () => {
      if (this.activeId !== id) return;
      const coverage = await this.service.loadEpgCoverage(id);
      this.setIndex(this.channels, this.index.layout(), coverage);
      this.invalidateNowNext();
    });
  }

  /** Swaps in a fresh index. Caller holds the index lock. */
  private setIndex(channels: Channel[], layout: Layout, coverage: Set<string> | undefined): void {
    this.channels = channels;
    this.coverage = coverage;
    this.originalById = undefined;
    this.index = new ChannelIndex(channels, layout, coverage);
    this.favSet = undefined;
    this.companionStale();
    this.titles = undefined;
    this.titlesEpoch++;
  }

  /** The active source or the source list changed: tells the TV UI (and the companion host) who did it. */
  private sourcesChanged(origin: LayoutOrigin): void {
    const event: Extract<AppEvent, { type: 'sourcesChanged' }> = { type: 'sourcesChanged', origin: origin === 'remote' ? 'remote' : 'local' };
    if (this.activeId !== undefined) event.activeSourceId = this.activeId;
    this.emit(event);
  }

  /** The companion state's channels, guide coverage or sources changed: the host drops its cached state. */
  private companionStale(): void {
    try {
      this.companion?.stateChanged?.();
    } catch {
      // The companion must never break the TV.
    }
  }

  /** `applyLayoutOps` body. Caller holds the index lock. */
  private async applyLayoutLocked(input: unknown, origin: LayoutOrigin): Promise<LayoutOpsResult> {
    const before = this.index.layout();
    const version = before.version;
    const rejectAll = (n: number, reason: string): LayoutOpsResult =>
      ({ version, rejected: Array.from({ length: n }, (_, index) => ({ index, reason })) });
    if (!Array.isArray(input)) return rejectAll(1, 'Expected a list of changes.');
    if (input.length > MAX_OPS_PER_BATCH) {
      return rejectAll(input.length, `Too many changes at once (at most ${MAX_OPS_PER_BATCH}).`);
    }
    const id = this.activeId;
    if (!id) return rejectAll(input.length, 'No active source.');

    const rejected: LayoutOpsResult['rejected'] = [];
    const valid: LayoutOp[] = [];
    /** Batch index of each op in `valid`; unset when the whole batch is valid. */
    let at: number[] | undefined;
    if (isLayoutOpBatch(input)) {
      valid.push(...input);
    } else {
      const positions: number[] = [];
      input.forEach((op: unknown, index) => {
        if (isLayoutOp(op)) {
          valid.push(op);
          positions.push(index);
        } else {
          rejected.push({ index, reason: 'Unrecognised change.' });
        }
      });
      at = positions;
    }
    const res = applyOps(before, valid);
    for (const r of res.rejected) rejected.push({ index: at ? at[r.index]! : r.index, reason: r.reason });
    rejected.sort((a, b) => a.index - b.index);
    if (!res.changed) return { version, rejected };

    await this.service.saveLayout(id, res.layout);
    this.index = this.index.withLayout(res.layout);
    this.favSet = undefined;
    if (before.channelNames !== res.layout.channelNames) this.invalidateNowNext();
    const event: Extract<AppEvent, { type: 'layoutChanged' }> = { type: 'layoutChanged', version: res.layout.version, origin: origin === 'remote' ? 'remote' : 'local' };
    if (onlyRecentChanged(before, res.layout)) event.recentOnly = true;
    this.emit(event);
    return { version: res.layout.version, rejected };
  }

  /** The playlist originals of renamed channels, so guide lookups use the playlist name (and its epgKey). */
  private originals(channels: Channel[]): Channel[] {
    const names = this.index.layout().channelNames;
    if (!channels.some((c) => HAS.call(names, c.id))) return channels;
    const byId = (this.originalById ??= new Map(this.channels.map((c) => [c.id, c])));
    return channels.map((c) => (HAS.call(names, c.id) ? byId.get(c.id) ?? c : c));
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

  /**
   * The title index of `id` when it is in memory. Otherwise undefined, after starting (or joining) its
   * background load, unless a rebuild is running (it loads the index when done) or the index is known missing.
   */
  private cachedTitles(id: string): TitleIndexData | undefined {
    if (this.titlesTimer !== undefined) clearTimeout(this.titlesTimer);
    this.titlesTimer = setTimeout(() => { this.titles = undefined; this.titlesTimer = undefined; }, TITLES_IDLE_MS);
    (this.titlesTimer as { unref?: () => void }).unref?.();
    if (this.titles?.sourceId === id) return this.titles.data;
    const missing = this.titlesMissing;
    if (missing?.sourceId === id && missing.epoch === this.titlesEpoch) return undefined;
    if (this.titleRebuilds.get(id) === 'running') return undefined;
    this.loadTitles(id);
    return undefined;
  }

  /** True while a title index load or rebuild of `id` is in flight. */
  private titlesPending(id: string): boolean {
    return this.titleLoad?.sourceId === id || this.titleRebuilds.get(id) === 'running';
  }

  /**
   * Loads the stored title index of `id` in the background (one load per source and epoch). When it is still
   * current: caches it and emits `searchReady`; with no usable record, starts the one-time rebuild, or, when
   * that was already tried, marks the index missing and emits `searchReady` so the TV drops its pending note.
   */
  private loadTitles(id: string): void {
    const epoch = this.titlesEpoch;
    if (this.titleLoad?.sourceId === id && this.titleLoad.epoch === epoch) return;
    const load = { sourceId: id, epoch };
    this.titleLoad = load;
    const job = (async () => {
      let data: TitleIndexData | undefined;
      try {
        data = await this.service.titleIndexFor(id);
      } catch (err) {
        // Never a failed search: logged by error name only, then rebuilt like a missing record.
        this.note('search', `Title index could not be read (${err instanceof Error ? err.name : 'Error'}).`);
      }
      if (this.titleLoad === load) this.titleLoad = undefined;
      // The source or its guide changed meanwhile: this result belongs to an older index.
      if (this.activeId !== id || this.titlesEpoch !== epoch) return;
      if (data) {
        this.titles = { sourceId: id, data };
        this.emit({ type: 'searchReady', sourceId: id });
      } else if (!this.titleRebuilds.has(id)) {
        this.startTitleRebuild(id);
      } else if (this.titleRebuilds.get(id) === 'done') {
        this.titlesMissing = { sourceId: id, epoch };
        this.emit({ type: 'searchReady', sourceId: id });
      }
    })().catch((err: unknown) => { this.record('search', err); });
    this.titleJobs.add(job);
    void job.then(() => this.titleJobs.delete(job));
  }

  private startTitleRebuild(id: string): void {
    if (this.titleRebuilds.has(id)) return;
    this.titleRebuilds.set(id, 'running');
    void this.enqueue(id, async () => {
      try {
        await this.service.rebuildTitleIndex(id);
      } catch (err) {
        this.record('rebuildTitleIndex', err);
        if (this.titleRebuilds.has(id)) this.titleRebuilds.set(id, 'done');
        // Not retried this session: searches return channels only, without the pending note. As on the
        // load-missing path, searchReady lets the TV re-run the query and drop its "being prepared" note.
        if (this.activeId === id) {
          this.titlesMissing = { sourceId: id, epoch: this.titlesEpoch };
          this.emit({ type: 'searchReady', sourceId: id });
        }
        return;
      }
      if (this.titleRebuilds.has(id)) this.titleRebuilds.set(id, 'done');
      // Load the rebuilt index; its load emits `searchReady`.
      if (this.activeId === id) this.loadTitles(id);
    });
  }

  /** Matching programmes on the displayed timeline: airing now (per channel) and later (one per title). */
  private async programmeHits(data: TitleIndexData, query: string): Promise<{
    onNow: { c: Channel; title: string; start: number; stop: number }[];
    later: { c: Channel; title: string; start: number; stop: number; more: number }[];
  }> {
    const settings = await this.currentSettings();
    const t = this.now();
    const shiftOf = (c: Channel) => (settings.epgOffsetHours + (c.epgShift ?? 0)) * HOUR;
    let maxShift = Math.abs(settings.epgOffsetHours) * HOUR;
    for (const c of this.channels) maxShift = Math.max(maxShift, Math.abs(shiftOf(c)));
    const onNow: { c: Channel; title: string; start: number; stop: number }[] = [];
    const later: { c: Channel; title: string; start: number; stop: number; more: number }[] = [];
    for (const m of queryTitles(data, query, t - maxShift, SEARCH_TITLES)) {
      let next: { c: Channel; start: number; stop: number } | undefined;
      let upcoming = 0;
      const titleNow: { c: Channel; title: string; start: number; stop: number }[] = [];
      // Airings tied on start come in index (epgKey) order; ties go to the lower channel number.
      for (const a of m.airings) {
        for (const c of this.index.channelsForEpgKey(a.epgKey)) {
          const s = shiftOf(c);
          const start = a.start + s;
          const stop = a.stop + s;
          if (stop <= t) continue;
          if (start <= t) titleNow.push({ c, title: m.display, start, stop });
          else {
            upcoming++;
            if (!next || start < next.start || (start === next.start && c.number < next.c.number)) next = { c, start, stop };
          }
        }
      }
      titleNow.sort((x, y) => x.start - y.start || x.c.number - y.c.number);
      for (const h of titleNow) onNow.push(h);
      if (next) later.push({ ...next, title: m.display, more: upcoming - 1 });
    }
    return { onNow, later };
  }

  private favourites(): Set<string> {
    const fav = this.index.layout().lists.find((l) => l.id === FAV_LIST_ID);
    return (this.favSet ??= new Set(fav?.channelIds ?? []));
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
    let result: IngestResult | undefined;
    try {
      result = await this.service.refreshPlaylist(id, (p) => this.emit({ type: 'progress', ...p }));
    } catch (err) {
      this.failed('playlist', id, 'refreshPlaylist', err);
    }
    await this.rebuildIndex(id);
    await this.vodAfterPlaylist(id, result);
    this.setOffline(false);
    this.emit({ type: 'refreshed', what: 'playlist', sourceId: id });
  }

  /**
   * An M3U playlist refresh re-stores its movie and series lists: the active source's resident catalogue is stale,
   * so the controller drops it and the TV is told (once per kind that has a stored list).
   */
  private async vodAfterPlaylist(id: string, result: IngestResult | undefined): Promise<void> {
    if (!this.vodc || !this.vod || this.activeId !== id) return;
    try {
      const source = (await this.service.listSources()).find((s) => s.id === id);
      if (source?.kind !== 'm3u' || this.activeId !== id) return;
      const resident = this.vodc.residentKind();
      this.vodc.invalidate(id);
      // Counts come from the ingest (the M3U split has no cap); nothing is read back from storage here.
      const counts = { movie: result?.movieCount ?? 0, series: result?.seriesCount ?? 0 };
      for (const kind of ['movie', 'series'] as const) {
        if (counts[kind] > 0) this.emit({ type: 'vodRefreshed', sourceId: id, kind, count: counts[kind], truncated: false });
      }
      // Keep the idle preload's benefit: reload the kind that was resident (reads storage only if nothing is resident).
      if (resident) void this.vodc.preload(resident).catch((err) => { this.record('preloadVod', err); });
    } catch (err) {
      this.record('refreshPlaylist', err);
    }
  }

  private async refreshEpgFor(id: string): Promise<void> {
    try {
      await this.service.refreshEpg(id, (p) => this.emit({ type: 'progress', ...p }));
    } catch (err) {
      this.failed('epg', id, 'refreshEpg', err);
    }
    await this.reloadCoverage(id);
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

  /** Every channel of the active source, hidden ones (and those in hidden groups or without a guide) included. */
  private totalChannels(): number {
    return this.channels.length;
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
    const stored = await this.service.programmesFor(id, this.originals(channels), lo, hi);
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
    const job = this.service.shortEpgFor(id, this.originals(todo.map((m) => m.c)), { isStale }).then((found) => {
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
    }).catch(noop); // fire-and-forget: a failing listener must not become an unhandled rejection
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

function listGroupId(listId: string): string {
  return listId === FAV_LIST_ID ? GROUP_FAV : `list:${listId}`;
}

function toLite(p: Programme): ProgrammeLite {
  const out: ProgrammeLite = { title: p.title, start: p.start, stop: p.stop };
  if (p.desc) out.desc = p.desc;
  return out;
}

/** Methods callable over RPC; the worker passes this to `expose` so internals (and `idle`) stay unreachable. */
/** A companion's layout ops were made for a source that is no longer the active one. */
export class WrongSourceError extends Error {
  constructor() {
    super('The TV switched to another source.');
    this.name = 'WrongSource';
  }
}

/** True when nothing but `recent` (and the version) differs: layouts are copy-on-write, so identity is enough. */
function onlyRecentChanged(before: Layout, after: Layout): boolean {
  if (before.recent === after.recent) return false;
  for (const k of Object.keys(after) as (keyof Layout)[]) {
    if (k !== 'recent' && k !== 'version' && before[k] !== after[k]) return false;
  }
  return true;
}

export const APP_API_METHODS = [
  'init', 'listSources', 'getSource', 'addSource', 'updateSource', 'deleteSource', 'setActiveSource', 'refresh',
  'getGroups', 'getChannelSlice', 'indexOf', 'getPlayable', 'neighbour', 'byNumber', 'getEpgRows', 'search',
  'getLayout', 'getActiveLayout', 'applyLayoutOps', 'listLists', 'channelLists', 'hiddenGroups', 'providerGroups', 'getCompanionState', 'guideStatus',
  'toggleFavourite', 'toggleHidden', 'hiddenChannels', 'markWatched',
  'getVodHome', 'getVodCategories', 'getVodSlice', 'getMovie', 'getSeries', 'getVodPlayable',
  'saveVodProgress', 'setVodFavourite', 'setVodWatched', 'clearVodProgress', 'setVodTracks', 'refreshVod', 'preloadVod',
  'getSettings', 'saveSettings', 'clearCache', 'diagnostics',
  'companionStart', 'companionStop', 'companionStatus',
] as const satisfies readonly (keyof AppApi)[];

// Compile-time check: every public method except the test-only `idle` is listed above.
const exhaustive: [Exclude<Exclude<keyof AppApi, 'idle'>, (typeof APP_API_METHODS)[number]>] extends [never] ? true : never = true;
void exhaustive;
