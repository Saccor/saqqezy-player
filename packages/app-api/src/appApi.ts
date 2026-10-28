import {
  ChannelIndex, DEFAULT_SETTINGS, FAV_LIST_ID, GROUP_ALL, GROUP_FAV, GROUP_RECENT, MAX_OPS_PER_BATCH, QUALITY_LABELS, alternateStreamUrl, applyOps,
  applyShift, emptyLayout, orderLiveSources, countryLabel, isSure, regionKeys, normalizeCountry, sanitizeSettings,
  isVodLayoutOpBatch, sureRegionKeys, type ChannelRegionView, type RegionSettings, type RegionsRecord, type VodLayoutOp,
  compareAirings, epgKey, isUnreachable, isLayoutOp, isLayoutOpBatch, mergeHeaders, nowNext, queryTitles, redactUrl, refreshFailKey, streamCooldownKey, streamKeySource,
  type AppSettings, type Channel, type GroupInfo, type IngestResult, type Layout, type LayoutOp, type NewSource, type Programme,
  type CooldownCause, type ProviderGroupInfo, type SeriesPointer, type SportsIndexRecord, type SourceConfig, type SourceCooldown, type SourceService, type Storage,
  type StreamHeaders, type TitleIndexData, type VodKind, type VodService, type VodSort,
  type SyncResult, type SyncSample, type SyncSetting, type LoadedSubtitle, type SourceSubtitle, type OpenSubtitlesClient, type SubtitleInput, type SubtitleService,
  type BackupEnvelope, type RestoreSummary, compileQuery, nameKeys, nameMatchScore, NO_MATCH,
} from '@iptv/core';
import { CatchupController, playableState, type CatchupContext } from './catchupController.ts';
import { worseCooldown } from './cooldown.ts';
import { LiveSourceMemory, livePickKey } from './liveSources.ts';
import { toRpcError, type RpcError } from './rpc.ts';
import { ShortEpgCache, shortEpgUntil } from './shortEpgCache.ts';
import { maxShiftMs, shiftSpan, type ShiftSpan } from './shiftSpan.ts';
import {
  firstFormat, formatMemoKey, formatOf, isFormatMemo, isStreamFormat, type FormatMemo, type StreamFormat,
} from './streamFormat.ts';
import { SportsController, matchTiles, type MatchSettings, type MatchTiles } from './sportsController.ts';
import { SubtitleController } from './subtitleController.ts';
import { BackupController } from './backupController.ts';
import { TitleIndexController } from './titleIndexController.ts';
import { assembleStartHome, type StartParts, type StartTrendPart, type StartTrendTile } from './startHome.ts';
import { TrendingService } from './trending.ts';
import { VodController, type VodSearchHits } from './vodController.ts';
import type {
  CatchupNotAvailable, CatchupPlayable,
  AppEvent, ChannelRow, GuideImportState, CompanionChannel, CompanionControl, CompanionStartResult, CompanionStatus, CompanionState, DiagnosticsInfo, InitState, LayoutOpsResult, LayoutOrigin,
  FolderHit, ListSummary, MovieView, LiveSourceView, PlayableChannel, ProgrammeHit, ProgrammeLite, SearchResult, SeriesView, SourceSummary, SportsEventTile, StartHome, TitleHit, MatchFilterChips, MatchCompetitionChips,
  OnlineSubtitleLanguage, SubtitleVersion, VodCategoryView, VodHome, VodPlayable, VodTile, VodTracks,
  GroupVisibility, RegionCount, RegionsOverview, CountriesPatch, CountryChoices,
} from './types.ts';
import { buildCountryChoices } from './countryChoices.ts';

export { MOVIE_HASH_RETRY_MS, SUBTITLE_SEARCH_PAGE_SIZE, sourceSubtitleName } from './subtitleController.ts';

const NOW_NEXT_TTL_MS = 60_000;
/**
 * Rows wait this long for their stored now/next, then go out without it (answered later as nowNextUpdated). A
 * healthy read takes a few ms even on a TV; this only trips while the guide store is locked by a long write.
 */
const NOW_NEXT_WAIT_MS = 400;
/** `withinWait`'s answer when the read outlasted `nowNextWaitMs` (it goes on in the background). */
const LATE = Symbol('late');
/** Late Guide reads kept for the re-read their `nowNextUpdated` asks for, at most. */
const EPG_LATE_MAX = 8;
const ERROR_RING = 20;
const HOUR = 3_600_000;
/** Extra stored-guide margin around "now" when picking now/next, so long programmes are still found. */
const NOW_NEXT_MARGIN_MS = 6 * HOUR;
/** Programme search: the on-now cap. */
const SEARCH_ON_NOW = 20;
/** Most folders (lists, provider groups, VOD categories together) one search returns. */
const SEARCH_FOLDERS = 20;
/** Most movies, and most series, one search returns. */
const SEARCH_VOD_MAX = 20;
const SEARCH_TITLES = 100;

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
  /** `navigator.storage.estimate` (bytes used and available to this app); absent where the device has none. */
  storageEstimate?: () => Promise<{ usage?: number; quota?: number }>;
  /**
   * Builds the phone companion host (the worker passes a CompanionHost factory). `onStatus` emits
   * `{ type: 'companion', status }`. Without it the companion methods report `idle` / not available.
   */
  companion?: (api: AppApi, onStatus: (status: CompanionStatus) => void) => CompanionControl;
  /** Movies and series. Without it, the VOD methods reject with "Movies and series are not available." */
  vod?: VodService;
  /** Subtitles loaded from a link or a file. Without it, those methods reject with "Loading subtitles is not available." */
  subtitles?: SubtitleService;
  /** Subtitles found online for a title. Without it, "Find subtitles online" is not offered. */
  onlineSubtitles?: OpenSubtitlesClient;
  /**
   * The OpenSubtitles hash of a VOD file (`fetchMovieHash` over the app's fetch), read only when Settings asks for
   * exact matches, with the stream's User-Agent and Referer (`headers`); undefined when it cannot be read.
   */
  fileHash?: (url: string, headers?: StreamHeaders) => Promise<string | undefined>;
  /**
   * The public trending feed (spec 2026-10-20-trending-design §4): its base URL and the fetch to read it with (a bare
   * GET; nothing about the user is sent). Without it Start has no trending rows and nothing is ever requested.
   */
  trending?: { baseUrl: string; fetch: (url: string, init: RequestInit) => Promise<Response> };
  /** PBKDF2 iterations of new backups (tests only; the default is BACKUP_PBKDF2_ITERATIONS). */
  backupIterations?: number;
  /** How long rows wait for their stored now/next (tests only; the default is NOW_NEXT_WAIT_MS). */
  nowNextWaitMs?: number;
}

export { RESTORE_WAIT_MS } from './backupController.ts';

export class AppApi {
  private readonly service: SourceService;
  private readonly storage: Storage;
  private readonly emit: (e: AppEvent) => void;
  private readonly now: () => number;
  private readonly appVersion: string;
  private readonly storageEstimate: AppApiDeps['storageEstimate'];

  private activeId: string | undefined;
  /** The last Start page answer for the active source (also kept in meta `startHome:<id>`). */
  private startCache: { sourceId: string; home: StartHome } | undefined;
  /** The active source's User-Agent and Referer settings (read with the index, so a zap never reads storage). */
  private sourceHeaders: StreamHeaders | undefined;
  /** The active Xtream account's connection limit, when known (exact match never reads the file on a 1-connection account). */
  private sourceMaxConnections: number | undefined;
  /** The active source's kind, kept from `activate` so a focus never reads the source list to learn it. */
  private sourceKind: SourceConfig['kind'] | undefined;
  private index = new ChannelIndex([]);
  /** The active source's cached region record (undefined until one exists: then nothing is region-filtered). */
  private regionRec: { sourceId: string; rec: RegionsRecord } | undefined;
  /** The view handed to the index; kept while its inputs are the same, so `withLayout` reuses region work. */
  private regionView: { rec: RegionsRecord; key: string; view: ChannelRegionView } | undefined;
  /** Region rebuilds in flight (awaited by the test-only `idle`). */
  private readonly regionJobs = new Set<Promise<void>>();
  /** This TV's country (ISO alpha-2, closed table), sent once by the UI at boot (`setDeviceCountry`). */
  private deviceCountry: string | undefined;
  /** The active source's channels as stored (playlist names), kept so layout and coverage rebuilds never refetch. */
  private channels: Channel[] = [];
  /** The channels' guide-shift span, from `setIndex` (programme search needs its widest shift per keystroke). */
  private shifts: ShiftSpan = { min: 0, max: 0 };
  /** epgKeys with stored guide data for the active source; undefined until a guide was loaded. */
  private coverage: Set<string> | undefined;
  /** Combined channels: the source that played last per row, and streams that failed recently. */
  private readonly liveMem: LiveSourceMemory;
  private favSet: Set<string> | undefined;
  private settings: AppSettings | undefined;
  private nnCache = new Map<string, { at: number; nn: NowNext }>();
  /** Bumped whenever cached now/next may be stale, so in-flight lookups do not repopulate the cache. */
  private generation = 0;
  private offline = false;
  /** `{sourceId}\u0000{what}` of the refreshes that failed while the device was offline (cleared when online again). */
  private offlineFails = new Set<string>();
  /** Per-source serial queue: background refreshes, explicit refreshes and deletes run one at a time. */
  private readonly queues = new Map<string, Promise<void>>();
  /** Background task per source; `rerun` asks a running task to loop once more when it finishes. */
  private readonly background = new Map<string, { started: boolean; rerun: boolean }>();
  /** Serialises flag mutations with index swaps, so a toggle is never lost or saved to the wrong source. */
  private indexLock: Promise<void> = Promise.resolve();
  /** Channels whose background short-EPG lookup is running (not started twice). */
  private readonly shortPending = new Set<string>();
  /** Background short-EPG lookups and late now/next reads in flight (awaited by the test-only `idle`). */
  private readonly shortJobs = new Set<Promise<void>>();
  /** Guide reads of `getEpgRows` that outlasted the wait: running (`epgPending`) and answered (`epgLate`), by rows. */
  private readonly epgPending = new Set<string>();
  private readonly epgLate = new Map<string, Map<string, Programme[]>>();
  /** Page keys whose late read failed this generation: they ask the grid to re-read once, not on every failure. */
  private readonly epgFailed = new Set<string>();
  /** Each source's guide import, for Diagnostics (this session only). */
  private readonly guideImports = new Map<string, GuideImportState>();
  /** Channels whose stored now/next read outlasted `nowNextWaitMs` and still runs (not read twice). */
  private readonly nnPending = new Set<string>();
  /** How long rows wait for their stored now/next before going out without it. */
  private readonly nowNextWaitMs: number;
  /** Short-EPG answers, kept until the programme found ends (15 min when nothing was found). */
  private readonly shortCache = new ShortEpgCache();
  /** The browse row the focus rests on (`focusChannel`) and the channel last asked to play: the only short-EPG targets. */
  private focusedId: string | undefined;
  private playingId: string | undefined;
  /** Per source: the stream format that played last (`notePlayed`), read from storage once; null when none. */
  private readonly formats = new Map<string, FormatMemo | null>();
  /** The active source's title index, loaded on the first search. */
  private readonly titles: TitleIndexController;
  private readonly errors: DiagnosticsInfo['lastErrors'] = [];
  private readonly recorded = new WeakSet<object>();
  private readonly companion: CompanionControl | undefined;
  private readonly sports: SportsController;
  private sportsRec: { sourceId: string; rec: SportsIndexRecord } | undefined;
  /** Bumped when the candidate-to-channel mapping can change (see SportsController.events). */
  private sportsMapping = 0;
  private readonly vodc: VodController | undefined;
  private readonly vod: VodService | undefined;
  private readonly subs: SubtitleController;
  private readonly trending: TrendingService | undefined;
  private readonly catchup: CatchupController;
  private readonly backup: BackupController;

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
    this.nowNextWaitMs = deps.nowNextWaitMs ?? NOW_NEXT_WAIT_MS;
    this.subs = new SubtitleController({
      ...(deps.subtitles ? { subtitles: deps.subtitles } : {}),
      ...(deps.onlineSubtitles ? { onlineSubtitles: deps.onlineSubtitles } : {}),
      ...(deps.fileHash ? { fileHash: deps.fileHash } : {}),
      now: this.now,
      activeId: () => this.activeId,
      sourceHeaders: () => this.sourceHeaders,
      sourceMaxConnections: () => this.sourceMaxConnections,
      settings: () => this.currentSettings(),
      vod: () => this.vodOrThrow(),
    });
    this.titles = new TitleIndexController({
      service: this.service, emit: this.emit,
      activeId: () => this.activeId,
      enqueue: (id, fn) => this.enqueue(id, fn),
      note: (message) => this.note('search', message),
      record: (where, err) => { this.record(where, err); },
    });
    this.backup = new BackupController({
      service: this.service, storage: deps.storage, emit: this.emit, now: this.now, iterations: deps.backupIterations, vod: deps.vod,
      companion: () => this.companion,
      activeId: () => this.activeId,
      layout: () => this.index.layout(),
      commitLayout: (id, before, layout, origin) => this.commitLayoutLocked(id, before, layout, [], origin),
      withIndex: (fn) => this.withIndex(fn),
      settings: () => this.currentSettings(),
      saveSettings: (patch) => this.applySettings(patch, { stamp: false, locked: true }),
      vodRestored: (id, what) => this.vodc?.restored(id, what),
      record: (where, err) => { this.record(where, err); },
    });
    this.sports = new SportsController({ storage: deps.storage, now: this.now });
    this.appVersion = deps.appVersion ?? '0.0.0';
    this.storageEstimate = deps.storageEstimate;
    this.liveMem = new LiveSourceMemory(deps.storage, this.now);
    this.companion = deps.companion?.(this, (status) => {
      // Why a session ended, for diagnostics (relay close reasons carry no secrets).
      if (status.state === 'expired' && status.reason) this.note('companion', `Phone session ended: ${status.reason}.`);
      deps.emit({ type: 'companion', status });
    });
    this.vod = deps.vod;
    const uiLanguage = () => (typeof navigator === 'undefined' ? undefined : navigator.language);
    this.trending = deps.trending?.baseUrl.trim()
      ? new TrendingService({
        baseUrl: deps.trending.baseUrl.trim(), fetch: deps.trending.fetch, storage: deps.storage, now: this.now,
        // The UI has no language setting yet: the device language stands in for it.
        language: uiLanguage, record: (where, err) => { this.record(where, err); },
      })
      : undefined;
    const trending = this.trending;
    this.vodc = deps.vod
      ? new VodController({
        vod: deps.vod, emit: this.emit, record: (where, err) => this.record(where, err),
        settings: () => this.currentSettings(),
        locale: uiLanguage,
        ...(trending ? { trending: (kind: VodKind) => trending.feed(kind), trendingSettled: (kind: VodKind) => trending.settled(kind) } : {}),
      })
      : undefined;
    this.service.guard.onChange((sourceId, cooldown, cause) => this.cooldownChanged(sourceId, cooldown, cause));
    this.catchup = new CatchupController({
      service: this.service, now: this.now,
      onRefined: (channelId) => this.emit({ type: 'archiveRefined', channelId }),
      note: (message) => this.note('catchup', message),
    });
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
      // A restored backup may hold this source's lists, hidden channels and progress (pending until now).
      await this.backup.applyPending(source);
      this.sourcesChanged(origin);
      return { sourceId: source.id, channelCount: result.channelCount };
    });
  }

  updateSource(source: SourceConfig, origin: LayoutOrigin = 'local'): Promise<{ channelCount: number }> {
    return this.run('updateSource', async () => {
      // The account may change under a running VOD fetch: cancel it before anything is rewritten.
      if (this.activeId === source.id) this.vodc?.invalidate(source.id);
      // Saving a source is a deliberate attempt (the user may just have fixed the login): it may probe a cooling source,
      // and each of its stream hosts.
      await this.service.guard.retryAll(source.id);
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
      this.shortCache.dropSource(id);
      this.formats.delete(id);
      this.guideImports.delete(id);
      this.titles.forget(id);
      if (this.startCache?.sourceId === id) this.startCache = undefined;
      this.dropSports();
      this.liveMem.forget(id);
      for (const key of [`flags:${id}`, `layout:${id}`, `epgCoverage:${id}`, `lastChannel:${id}`, `lastGroup:${id}`, `titleIndex:${id}`, `sportsIndex:${id}`, `epgLongest:${id}`, `startHome:${id}`, formatMemoKey(id), liveAudioKey(id), livePickKey(id)]) {
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

  /**
   * Manual Retry: lets one probe reach the active source now (the cooldown step is kept), and the host of `url` (the
   * stream on screen) when given. Answers the worse of the two cooldowns.
   */
  retrySource(url?: string): Promise<SourceCooldown> {
    return this.run('retrySource', async () => {
      const id = this.activeId;
      if (!id) return { state: 'clear' };
      const guard = this.service.guard;
      await guard.retry(id);
      const host = url === undefined ? undefined : streamCooldownKey(id, url);
      if (host === undefined) return guard.status(id);
      await guard.retry(host);
      return worseCooldown(await guard.status(id), await guard.status(host));
    });
  }

  /**
   * The player gave up on the stream at `url` of `sourceId` because the source refused it: only the streams on that
   * host pause (spec 2026-10-16-source-retry §5). The URL is used for its host only; never logged. `retryAfterMs` (the
   * status probe's `Retry-After`) replaces this step's wait, clamped by the guard.
   */
  reportStreamRefused(sourceId: string, url: string, retryAfterMs?: number): Promise<void> {
    return this.run('reportStreamRefused', () => this.service.guard.report(
      streamCooldownKey(sourceId, url), 'refused', retryAfterMs === undefined ? undefined : { retryAfterMs },
    ));
  }

  /**
   * The device is back online: an unreachable wait of the active source was (likely) our own outage, so it ends now
   * and the background pass runs again (its first request is the probe). A refusal wait is left alone.
   */
  networkOnline(): Promise<void> {
    return this.run('networkOnline', async () => {
      const id = this.activeId;
      if (!id) return;
      let restart = false;
      // The refresh backoff (15 min, 1 h, 6 h) is for a source that fails us. A refresh whose last failure happened
      // while we were offline said nothing about the source, so its backoff record goes. Failures from before the
      // outage keep theirs, and a manual refresh always runs anyway. (VOD catalogue refreshes don't set offline,
      // so their backoff stays as recorded.)
      for (const what of ['playlist', 'epg'] as const) {
        if (!this.offlineFails.delete(`${id}\u0000${what}`)) continue;
        try {
          await this.storage.setMeta(refreshFailKey(id, what), null);
          restart = true;
        } catch (err) {
          this.record('networkOnline', err);
        }
      }
      const guard = this.service.guard;
      const status = await guard.status(id);
      if (status.state === 'waiting' && status.reason === 'unreachable') {
        await guard.retry(id);
        restart = true;
      }
      if (restart && id === this.activeId) this.startBackground(id);
    });
  }

  /** The stream at `url` of `sourceId` played: its host answers us, and so does the source. */
  reportStreamAnswered(sourceId: string, url: string): Promise<void> {
    return this.run('reportStreamAnswered', async () => {
      await this.service.guard.report(streamCooldownKey(sourceId, url), 'answered');
      await this.service.guard.report(sourceId, 'answered');
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

  /**
   * The stream to play for `channelId`. A combined channel plays its best source (spec 2026-10-19-live-grouping §4),
   * or with `exact` the given stream; either way the answer carries the row's name, number and id, and the ordered
   * sources for failover and Choose source.
   */
  getPlayable(channelId: string, opts?: { exact?: boolean }): Promise<PlayableChannel | undefined> {
    return this.run('getPlayable', () => this.livePlayable(channelId, opts?.exact === true));
  }

  neighbour(groupId: string, channelId: string, delta: number): Promise<PlayableChannel | undefined> {
    return this.run('neighbour', async () => {
      const c = this.index.neighbour(groupId, channelId, delta);
      return c && this.livePlayable(c.id, false);
    });
  }

  byNumber(n: number): Promise<PlayableChannel | undefined> {
    return this.run('byNumber', async () => {
      const c = this.index.byNumber(n);
      return c && this.livePlayable(c.id, false);
    });
  }

  /** A combined channel's streams, best first (Choose source). One element for a single channel. */
  liveSources(channelId: string): Promise<LiveSourceView[]> {
    return this.run('liveSources', async () => {
      const rowId = this.index.rowOf(channelId);
      return rowId ? this.orderedSources(rowId) : [];
    });
  }

  /** The user chose `channelId` for its row in Choose source: it plays first from now on. */
  pickLiveSource(rowId: string, channelId: string): Promise<void> {
    return this.run('pickLiveSource', async () => {
      const id = this.activeId;
      const key = this.index.foldKey(channelId);
      if (!id || key === undefined || this.index.rowOf(channelId) !== this.index.rowOf(rowId)) return;
      await this.liveMem.remember(id, key, channelId);
    });
  }

  /** A stream of a combined channel failed to play: it is tried last for ten minutes (memory only). */
  reportSourceFailed(channelId: string): Promise<void> {
    return this.run('reportSourceFailed', async () => {
      if (this.index.get(channelId)) this.liveMem.failed(channelId);
    });
  }

  /**
   * The browse row the user's focus rests on (undefined: none). A channel without a stored guide gets one background
   * short-EPG lookup (cached; see `startShortEpg`); its answer arrives as `nowNextUpdated`. Lookups still queued for an
   * earlier focus are dropped unless that channel is playing.
   */
  focusChannel(channelId: string | undefined): Promise<void> {
    return this.run('focusChannel', async () => {
      this.focusedId = channelId;
      const c = channelId === undefined ? undefined : this.index.rowChannel(channelId);
      if (c) await this.wantShortEpg(c);
    });
  }

  /**
   * A stream of `channelId` showed its first frame in `format`. The format that played is remembered for the active
   * source (this device only: a format name, no URL or credentials) and tried first from then on (spec
   * 2026-10-15-gentle-source §3.4). Unknown names, channels with one format and reports for a source that is no longer
   * active are ignored.
   */
  notePlayed(channelId: string, format: StreamFormat): Promise<void> {
    return this.run('notePlayed', async () => {
      const id = this.activeId;
      const c = this.index.get(channelId);
      if (id && c) await this.notePlayedSource(id, c);
      if (!id || !c || !isStreamFormat(format) || alternateStreamUrl(c.url) === undefined) return;
      const memo: FormatMemo = { format, pref: (await this.currentSettings()).preferredFormat };
      const old = await this.lastFormat(id);
      if (old?.format === memo.format && old.pref === memo.pref) return;
      if (this.activeId !== id) return; // deleted or switched away meanwhile: no orphan key
      this.formats.set(id, memo);
      await this.storage.setMeta(formatMemoKey(id), memo);
    });
  }

  getEpgRows(groupId: string, offset: number, count: number, from: number, to: number):
    Promise<{ total: number; rows: { channel: ChannelRow; programmes: ProgrammeLite[] }[] }> {
    return this.run('getEpgRows', async () => {
      const channels = this.index.slice(groupId, offset, count);
      // The guide grid draws the programmes it is given, never a row's now/next: lite rows, and no storage read
      // for them (nor a background short-EPG lookup). A row with no stored programmes in the window shows its cached
      // short-EPG answer, if any (`focusChannel` / play asked for it; announced with `nowNextUpdated`).
      const rows = this.liteRows(channels);
      const id = this.activeId;
      const settings = await this.currentSettings();
      const shifts = channels.map((c) => settings.epgOffsetHours + (c.epgShift ?? 0));
      let byChannel = new Map<string, Programme[]>();
      if (id && channels.length) {
        // Displayed = stored + shift, so the stored window is [from - shift, to - shift]; widen it to cover every channel.
        const lo = from - Math.max(...shifts) * HOUR;
        const hi = to - Math.min(...shifts) * HOUR;
        byChannel = await this.guideRead(id, channels, lo, hi);
      }
      const t = this.now();
      const inWindow = (list: Programme[], hours: number) => list
        .map((p) => applyShift(p, hours))
        .filter((p) => p.stop > from && p.start < to);
      return {
        total: this.index.groupSize(groupId),
        rows: channels.map((c, i) => {
          const hours = shifts[i]!;
          let shown = inWindow(byChannel.get(c.id) ?? [], hours);
          // Nothing stored here: the channel's cached short-EPG answer (focus rest or play; never asked from here).
          if (shown.length === 0 && id) shown = inWindow(this.shortCache.get(id, c.id, t) ?? [], hours);
          let programmes = shown.sort((a, b) => a.start - b.start).map(toLite);
          if (id && c.cu) programmes = this.catchup.decorate(id, c.id, programmes, hours, from, to);
          return { channel: rows[i]!, programmes };
        }),
      };
    });
  }

  /**
   * The archive URL of the programme of `channelId` that starts at `start` (displayed time), from `offsetMs` into it
   * (spec 2026-10-20-catch-up §3.4). Anything but a past archived programme or the current one answers `notAvailable`.
   */
  getCatchupPlayable(channelId: string, start: number, offsetMs = 0): Promise<CatchupPlayable | CatchupNotAvailable> {
    return this.run('getCatchupPlayable', async () => {
      const ctx = await this.catchupContext(channelId);
      if (!ctx) return { notAvailable: 'none' };
      const prog = (await this.programmeAt(ctx, start)) ?? this.catchup.refinedProgramme(ctx, start);
      if (!prog) return { notAvailable: 'none' };
      const state = this.catchup.state(ctx, prog);
      if (!playableState(state)) return { notAvailable: state };
      // xc: the format live plays in on this source (the memo or the setting), as for the channel itself.
      const xcExt = ctx.channel.cu?.mode === 'xc' ? formatOf((await this.streamUrls(ctx.channel)).url) : undefined;
      const built = await this.catchup.build(ctx, prog, offsetMs, xcExt);
      if (!built) return { notAvailable: 'none' };
      const out: CatchupPlayable = {
        kind: 'catchup', channelId, channelName: this.index.get(channelId)?.name ?? ctx.channel.name, title: prog.title,
        start: prog.start, stop: prog.stop, openedAtMs: built.openStart - prog.start, url: built.url, stepMs: built.stepMs,
      };
      if (ctx.channel.cu) out.mode = ctx.channel.cu.mode;
      if (built.alternateUrl) out.alternateUrl = built.alternateUrl;
      const headers = mergeHeaders(this.sourceHeaders, ctx.channel.headers);
      if (headers) out.headers = headers;
      const next = (await this.programmeAt(ctx, prog.stop)) ?? this.catchup.refinedAfter(ctx, prog.stop);
      if (next && this.catchup.state(ctx, next) === 'available') out.next = { start: next.start, stop: next.stop, title: next.title };
      await this.addStreamCooldown(out);
      return out;
    });
  }

  /** Settings → source → Catch-up time (minutes from UTC; undefined = Auto). No playlist refresh. */
  setCatchupOffset(sourceId: string, minutes: number | undefined): Promise<number | undefined> {
    return this.run('setCatchupOffset', async () => (await this.service.setCatchupOffset(sourceId, minutes)).catchupOffsetMin);
  }

  /** The active source's largest catch-up archive in days (0 without catch-up): how far back the Guide reaches. */
  catchupDays(): Promise<number> {
    return this.run('catchupDays', async () => this.channels.reduce((m, c) => Math.max(m, c.cu?.days ?? 0), 0));
  }

  /**
   * Xtream: the source's own archive listings for the focused Guide row (one request per channel per 30 min, one in
   * flight, spaced by the short-EPG slot). Emits `archiveRefined` when they arrive. A no-op for other sources.
   */
  refineArchive(channelId: string): Promise<void> {
    return this.run('refineArchive', async () => {
      if (this.sourceKind !== 'xtream') return;
      const ctx = await this.catchupContext(channelId);
      if (ctx) await this.catchup.refine(ctx);
    });
  }

  /** Matches in your guide, See all: every passing match, then non-match sport, at most 100 (design note §3). */
  getSportsEvents(): Promise<SportsEventTile[]> {
    return this.run('getSportsEvents', async () => (await this.matchTiles()).all);
  }

  /** The chips of Matches in your guide: competitions and categories as the user's guide writes them. */
  getMatchFilters(): Promise<MatchFilterChips> {
    return this.run('getMatchFilters', async () => this.sports.filters(await this.sportsView()));
  }

  /** View all's second chip row: the competitions of one guide category, pinned first, hidden ones left out. */
  getMatchCompetitions(category: string): Promise<MatchCompetitionChips> {
    return this.run('getMatchCompetitions', async () => {
      const st = await this.currentSettings();
      const view = await this.sportsView();
      // Only the matches the grid shows (ranked window, gated, capped) count: a chip never opens an empty grid.
      const shown = matchTiles(view, this.now(), { ...this.matchSettings(st), categories: [category] }, this.sports.aliases()).all;
      return this.sports.competitions(view, category, st.pinnedCompetitions, st.hiddenCompetitions, new Set(shown.map((t) => t.key)));
    });
  }

  getEventChannels(key: string): Promise<ChannelRow[]> {
    return this.run('getEventChannels', async () => {
      const e = (await this.sportsView()).events.find((g) => g.key === key);
      if (!e) return [];
      const at = new Map<string, { start: number }>();
      for (const a of e.airings) for (const id of a.channelIds) if (!at.has(id)) at.set(id, a);
      const chans = [...at.keys()].map((id) => this.index.get(id)).filter((c): c is Channel => c !== undefined);
      const rows = await this.toRows(chans);
      const now = this.now();
      const favs = this.favourites();
      const airingNow = (id: string) => (at.get(id)?.start ?? Infinity) <= now;
      // Favourite, airing now, then your countries (spec 2026-10-24 §2.3), then today's tail (backup, quality, number).
      return rows.sort((x, y) => Number(y.favourite) - Number(x.favourite)
        || Number(airingNow(y.id)) - Number(airingNow(x.id))
        || this.countryKey(favs, x.id) - this.countryKey(favs, y.id)
        || compareAirings(
          { favourite: false, airingNow: false, name: x.name, number: x.number },
          { favourite: false, airingNow: false, name: y.name, number: y.number },
        ));
    });
  }

  getStartHomeCached(): Promise<StartHome | undefined> {
    return this.run('getStartHomeCached', async () => {
      const id = this.activeId;
      if (!id) return undefined;
      if (this.startCache?.sourceId === id) return this.startCache.home;
      const stored = await this.storage.getMeta<StartHome | null>(`startHome:${id}`).catch(() => undefined);
      return stored && Array.isArray(stored.rows) ? stored : undefined;
    });
  }

  getStartHome(): Promise<StartHome> {
    return this.run('getStartHome', async () => {
      const id = this.activeId;
      if (!id) return { rows: [], at: this.now() };
      const safe = async <T>(f: () => Promise<T>, fallback: T): Promise<T> => {
        try { return await f(); } catch (err) { this.record('getStartHome', err); return fallback; }
      };
      // The stored trending copies (a meta read; never waits on the network) before the VOD rows match against them.
      await safe(() => this.trending?.prime() ?? Promise.resolve(), undefined);
      const [sports, movie, series] = await Promise.all([
        safe(() => this.matchTiles(), { row: [], all: [], total: 0, filtered: false } as MatchTiles),
        safe(() => this.vodc?.startRows('movie') ?? Promise.resolve(undefined), undefined),
        safe(() => this.vodc?.startRows('series') ?? Promise.resolve(undefined), undefined),
      ]);
      const parts: StartParts = { sports: sports.row, sportsTotal: sports.total };
      if (sports.filtered) parts.sportsFiltered = true;
      // Continue merges both kinds by last play: a kind still unknown counts as empty once the other is known.
      if (movie || series) {
        parts.continueMovies = movie?.continue ?? [];
        parts.continueSeries = series?.continue ?? [];
      }
      if (movie) parts.newMovies = { items: movie.recent, total: movie.recentTotal };
      if (series) parts.newSeries = { items: series.recent, total: series.recentTotal };
      if (movie) parts.topMovies = { items: movie.top, total: movie.topTotal };
      if (series) parts.topSeries = { items: series.top, total: series.topTotal };
      if (!this.trending) {
        // No feed configured: known empty, so a row cached by another build never lingers.
        parts.trendingMovies = { items: [] };
        parts.trendingSeries = { items: [] };
      } else {
        if (movie?.trending) parts.trendingMovies = trendPart(movie.trending, movie.trendingAt);
        if (series?.trending) parts.trendingSeries = trendPart(series.trending, series.trendingAt);
      }
      const cached = this.startCache?.sourceId === id ? this.startCache.home : await this.getStartHomeCached();
      const home = assembleStartHome(parts, this.now(), cached);
      // Switched away or deleted meanwhile: never mix sources, and persist nothing.
      if (this.activeId !== id) return { rows: [], at: home.at };
      this.startCache = { sourceId: id, home };
      // Start asks every minute; the stored page is rewritten only when the rows differ (no idle readwrite transactions).
      if (!cached || JSON.stringify(cached.rows) !== JSON.stringify(home.rows)) {
        await this.storage.setMeta(`startHome:${id}`, home).catch(() => undefined);
      }
      return home;
    });
  }

  search(query: string, limit: number): Promise<SearchResult> {
    return this.run('search', async () => {
      const [result, vod] = await Promise.all([this.channelSearch(query, limit), this.vodSearch(query, limit)]);
      return { ...result, folders: this.folderHits(query), movies: vod.movies, series: vod.series, vodPending: vod.pending };
    });
  }

  /**
   * Folders whose name has every word of `query` (spec 2026-10-24 §3.1): the user's lists (layout order), then provider
   * groups (your countries in pick order, then the index's order), word-start matches before the rest; then movie and
   * series categories of the resident catalogues. Never Recently watched, All channels or hidden groups. At most
   * SEARCH_FOLDERS; `[]` for a blank query. A failure never fails the search.
   */
  private folderHits(query: string): FolderHit[] {
    const q = compileQuery(query);
    if (!q || this.activeId === undefined) return [];
    try {
      const found: { hit: FolderHit; score: number }[] = [];
      const groups = this.index.groups().filter((g) => g.id !== GROUP_ALL && g.id !== GROUP_RECENT);
      const lists = groups.filter((g) => !g.id.startsWith('g:'));
      const provider = groups.filter((g) => g.id.startsWith('g:'))
        .map((g, i) => ({ g, i, k: this.index.regionRankOf(g.id) })).sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.g);
      for (const g of [...lists, ...provider]) {
        if (g.count === 0) continue; // an empty folder leads nowhere
        const score = nameMatchScore(nameKeys(g.name), q);
        if (score !== NO_MATCH) found.push({ hit: { kind: 'live', id: g.id, name: g.name, count: g.count }, score });
      }
      // Word-start matches before matches inside a word; stable, so lists, then your countries, stay first in each.
      const tier = (score: number) => (score <= 3 ? 0 : 1);
      const out = found.sort((a, b) => tier(a.score) - tier(b.score)).map((f) => f.hit);
      if (this.vodc) {
        for (const kind of ['movie', 'series'] as const) {
          for (const c of this.vodc.searchCategories(kind, query)) out.push({ kind, id: c.id, name: c.name, count: c.count });
        }
      }
      return out.slice(0, SEARCH_FOLDERS);
    } catch (err) {
      this.record('searchFolders', err);
      return [];
    }
  }

  /** Channels of the active source matching `query` (multiview's picker). No guide or VOD work; `[]` for a blank query. */
  searchChannels(query: string, limit: number): Promise<ChannelRow[]> {
    return this.run('searchChannels', async () => {
      if (query.trim() === '') return [];
      return this.toRows(this.index.search(query, Math.max(0, limit)));
    });
  }

  /** Movies and series for Search: never waits on building an index, and a failure never fails the search. */
  private async vodSearch(query: string, limit: number): Promise<VodSearchHits> {
    const none: VodSearchHits = { movies: [], series: [], pending: false };
    if (!this.vodc || query.trim() === '') return none;
    try {
      return await this.vodc.search(query, Math.min(SEARCH_VOD_MAX, Math.max(0, limit)));
    } catch (err) {
      this.record('searchVod', err);
      return none;
    }
  }

  private channelSearch(query: string, limit: number): Promise<Omit<SearchResult, 'folders' | 'movies' | 'series' | 'vodPending'>> {
    return (async () => {
      const id = this.activeId;
      const favs = this.favourites();
      const key = (c: Channel) => this.countryKey(favs, c.id);
      // Close matches (the bare name, or its start) before word-start matches before the rest; inside each, favourites,
      // then your countries in pick order, then the index's order. A channel number stays first.
      const scored = this.index.searchScored(query);
      const tier = (score: number) => (score < 0 ? -1 : score <= 1 ? 0 : score <= 3 ? 1 : 2);
      const found = scored.map((m, i) => ({ c: m.channel, i, t: tier(m.score), k: key(m.channel) }))
        .sort((a, b) => a.t - b.t || a.k - b.k || a.i - b.i).slice(0, limit).map((x) => x.c);
      const totals = { channelTotal: scored.length, hiddenCount: this.hiddenMatchCount(query) };
      const epoch = this.titles.epoch;
      // Without guide data there is nothing to prepare: channels only.
      const guided = id !== undefined && this.coverage !== undefined && query.trim() !== '';
      // Never waits on loading the index: without it in memory, channels come back now and `searchReady` follows.
      const data = guided ? this.titles.cached(id) : undefined;
      // Pending while a load or a rebuild is in flight; once both finished with no index, channels only.
      if (!data) {
        const guidePending = guided && this.titles.pending(id);
        return { channels: await this.toRows(found), onNow: [], later: [], guidePending, ...totals };
      }
      const hits = await this.programmeHits(data, query);
      // The source changed during the awaits: the index state now belongs to another source.
      if (this.activeId !== id || this.titles.epoch !== epoch) {
        return { channels: await this.toRows(found), onNow: [], later: [], guidePending: false, ...totals };
      }
      // Programmes never take the channels' places: each section has its own budget.
      const chans = found;
      const onNow = hits.onNow.slice(0, Math.min(SEARCH_ON_NOW, Math.max(0, limit)));
      const later = hits.later.slice(0, Math.max(0, limit));
      const [channelRows, progRows] = await Promise.all([
        this.toRows(chans),
        this.toRows([...onNow.map((h) => h.c), ...later.map((h) => h.c)]),
      ]);
      return {
        channels: channelRows,
        onNow: onNow.map((h, i): ProgrammeHit => ({ channel: progRows[i]!, title: h.title, start: h.start, stop: h.stop })),
        later: later.map((h, i): TitleHit => ({ channel: progRows[onNow.length + i]!, title: h.title, start: h.start, stop: h.stop, more: h.more })),
        guidePending: false,
        ...totals,
      };
    })();
  }

  /** Matches that only Your countries hides ("Only these"), for Search's "n more in hidden groups"; 0 on a failure. */
  private hiddenMatchCount(query: string): number {
    try {
      return this.index.searchRuleHidden(query, 0).count;
    } catch (err) {
      this.record('searchHidden', err);
      return 0;
    }
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
    return this.run('channelLists', async () => {
      const ids = this.index.memberIds(channelId);
      const of = ids.length ? ids : [channelId];
      return this.index.layout().lists.filter((l) => of.some((m) => l.channelIds.includes(m))).map((l) => l.id);
    });
  }

  hiddenGroups(): Promise<GroupInfo[]> {
    return this.run('hiddenGroups', async () => this.index.hiddenGroupInfos());
  }

  /** Every provider group of the active source, hidden ones included. */
  providerGroups(): Promise<ProviderGroupInfo[]> {
    return this.run('providerGroups', async () => this.index.allProviderGroups());
  }

  /**
   * Your countries for the active source: the setting, whether it is stale here, and the detected countries with
   * group and channel counts (largest first), plus "Not sure" and no-region totals. Counts every channel, hidden or not.
   */
  getRegions(): Promise<RegionsOverview> {
    return this.run('getRegions', async () => {
      const s = (await this.currentSettings()).regions;
      const rr = this.regionRec;
      const detected = rr && rr.sourceId === this.activeId ? rr.rec.groups : {};
      const own = this.index.layout().groupRegion;
      const by = new Map<string, RegionCount>();
      const notSure = { groups: 0, channels: 0 };
      const other = { groups: 0, channels: 0 };
      for (const g of this.index.allProviderGroups()) {
        if (g.regions.length) {
          for (const code of g.regions) {
            let c = by.get(code);
            if (!c) by.set(code, (c = { code, label: countryLabel(code), groups: 0, channels: 0 }));
            c.groups++;
            c.channels += g.count;
          }
          continue;
        }
        const d = Object.prototype.hasOwnProperty.call(own, g.id) ? undefined : detected[g.id];
        const bucket = d && !isSure(d) && regionKeys(d).length ? notSure : other;
        bucket.groups++;
        bucket.channels += g.count;
      }
      const countries = [...by.values()].sort((a, b) => b.channels - a.channels || b.groups - a.groups);
      return { mode: s.mode, codes: [...s.codes], stale: this.index.regionState().stale, countries, notSure, other };
    });
  }

  /** Saves your countries (codes and mode); the index is rebuilt with them. */
  setRegions(regions: RegionSettings): Promise<RegionSettings> {
    return this.run('setRegions', async () => (await this.saveSettings({ regions })).regions);
  }

  /**
   * Your countries' grid (spec 2026-10-22-your-countries-flags): detected countries with folder counts per section,
   * the setting, and how many folders go first. Cached records only: never loads a catalogue, never waits on a job.
   */
  getCountryChoices(): Promise<CountryChoices> {
    return this.run('getCountryChoices', async () => this.countryChoices(await this.currentSettings()));
  }

  /**
   * Saves a Your countries change in one settings write and answers with fresh choices. Picking countries (codes and
   * a mode other than off) turns "Combine categories across languages" off in the same save (owner decision Q4).
   */
  setCountries(patch: CountriesPatch): Promise<CountryChoices> {
    return this.run('setCountries', async () => {
      const cur = await this.currentSettings();
      const regions = sanitizeSettings({
        regions: { codes: Array.isArray(patch.codes) ? patch.codes : cur.regions.codes, mode: patch.mode ?? cur.regions.mode },
      }).regions;
      const next: Partial<AppSettings> = { regions };
      if (typeof patch.foldCountries === 'boolean') next.foldCountries = patch.foldCountries;
      if (regions.codes.length > 0 && regions.mode !== 'off') next.combineCategories = false;
      return this.countryChoices(await this.applySettings(next));
    });
  }

  /** The TV's own country, from its locale (undefined: unknown). Kept for this session; puts it first in the grid. */
  setDeviceCountry(code: string | undefined): Promise<void> {
    return this.run('setDeviceCountry', async () => {
      this.deviceCountry = typeof code === 'string' ? normalizeCountry(code) : undefined;
    });
  }

  private countryChoices(s: AppSettings): CountryChoices {
    return buildCountryChoices({
      live: this.index.allProviderGroups().map((g) => ({ keys: g.regions, hidden: g.hidden })),
      // While categories are merged across languages, Movies and Series are not sorted by country.
      vod: s.combineCategories ? [] : this.vodc?.regionSummaries() ?? [],
      regions: s.regions, foldCountries: s.foldCountries, combineCategories: s.combineCategories,
      ...(this.deviceCountry ? { deviceCountry: this.deviceCountry } : {}),
    });
  }

  /** Shows, hides, or returns to the region rule provider groups of the active source (one layout batch). */
  setGroupVisibility(ids: string[], visibility: GroupVisibility): Promise<LayoutOpsResult> {
    const ops: LayoutOp[] = visibility === 'show' ? [{ op: 'showGroups', ids }]
      : visibility === 'hide' ? [{ op: 'hideGroups', ids }]
        : [{ op: 'unhideGroups', ids }, { op: 'unshowGroups', ids }];
    return this.applyLayoutOps(ops);
  }

  /** The user's region for a group (`null`: back to detection; `[]`: no country). */
  setGroupRegion(id: string, codes: string[] | null): Promise<LayoutOpsResult> {
    return this.applyLayoutOps([{ op: 'setGroupRegion', id, codes }]);
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
      const view = this.regionViewFor();
      // Protocol 3: the phone runs the same region rule (`regionRule`) on its optimistic layout.
      if (view) state.regions = { mode: view.mode, codes: [...view.codes], keys: sureRegionKeys(view.detected) };
      return state;
    });
  }

  toggleFavourite(channelId: string): Promise<boolean> {
    return this.run('toggleFavourite', () => this.withIndex(async () => {
      const rowId = this.index.rowOf(channelId);
      if (!rowId) return false;
      // A combined channel is a favourite when any of its streams is; on adds the row, off clears every stream.
      const members = this.index.memberIds(rowId);
      const isFav = () => members.some((m) => this.favourites().has(m));
      const on = !isFav();
      await this.applyLayoutLocked([on
        ? { op: 'addToList', listId: FAV_LIST_ID, channelIds: [rowId] }
        : { op: 'removeFromList', listId: FAV_LIST_ID, channelIds: members }], 'local');
      return isFav(); // the real state: false if the change was refused
    }));
  }

  toggleHidden(channelId: string): Promise<boolean> {
    return this.run('toggleHidden', () => this.withIndex(async () => {
      if (!this.index.get(channelId)) return false;
      const on = !this.index.layout().hiddenChannels.includes(channelId);
      // A combined channel hides and shows with all its streams.
      await this.applyLayoutLocked([{ op: on ? 'hideChannels' : 'unhideChannels', ids: this.index.memberIds(channelId) }], 'local');
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

  /** Your countries over this kind's categories (counts are categories and titles). */
  getVodRegions(kind: VodKind): Promise<RegionsOverview> {
    return this.run('getVodRegions', () => this.vodFor(kind).regions(kind));
  }

  /** Hides, shows (over the region rule) or orders movie or series categories of the active source. */
  applyVodLayoutOps(kind: VodKind, ops: VodLayoutOp[]): Promise<LayoutOpsResult> {
    return this.run('applyVodLayoutOps', async () => {
      if (!isVodLayoutOpBatch(ops)) throw new Error('Unrecognised change.');
      const res = await this.vodFor(kind).applyLayoutOps(kind, ops);
      return { version: res?.layout.version ?? 0, rejected: res?.rejected ?? [] };
    });
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

  /** With `versionId` (from `SeriesView.versions`), shows that version's seasons. */
  /** The Versions list's missing languages, by version id (from the source's probe data). */
  getVersionLanguages(id: string): Promise<Record<string, string>> {
    return this.run('getVersionLanguages', () => this.vodOrThrow().versionLanguages(id));
  }

  getSeries(id: string, versionId?: string): Promise<SeriesView | undefined> {
    return this.run('getSeries', () => this.vodOrThrow().series(id, versionId));
  }

  /**
   * A combined movie's card id plays the version Play picks; `exact` (a choice in the Versions list) plays `itemId`
   * itself. Episodes pass the shown version's id (`SeriesView.versionId`) as `seriesId`.
   */
  getVodPlayable(itemId: string, seriesId?: string, exact?: boolean): Promise<VodPlayable | undefined> {
    return this.run('getVodPlayable', async () => {
      const out = await this.vodOrThrow().playable(itemId, seriesId, exact === true);
      if (!out) return out;
      // The playlist entry's own headers win over the source's settings, field by field.
      const headers = mergeHeaders(this.sourceHeaders, out.headers);
      if (headers) out.headers = headers;
      else delete out.headers;
      await this.addStreamCooldown(out);
      return out;
    });
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

  /** "Remove from Continue watching" on a series tile. */
  clearSeriesContinue(seriesId: string): Promise<void> {
    return this.run('clearSeriesContinue', () => this.vodOrThrow().clearSeriesContinue(seriesId));
  }

  /** Remembers the version picked in the Versions list for the title `itemId` belongs to. */
  pickVodVersion(itemId: string, versionId: string): Promise<void> {
    return this.run('pickVodVersion', () => this.vodOrThrow().pickVersion(itemId, versionId));
  }

  /** "Show separately" (`on`) or "Combine again" for a title; screens reload on `vodRefreshed`. */
  setVodSplit(itemId: string, on: boolean): Promise<void> {
    return this.run('setVodSplit', () => this.vodOrThrow().setSplit(itemId, on));
  }

  setVodTracks(itemId: string, tracks: VodTracks): Promise<void> {
    return this.run('setVodTracks', () => this.vodOrThrow().setTracks(itemId, tracks));
  }

  /**
   * Loads subtitles for one title (a movie or an episode) from a link or a file's bytes, and keeps them on this
   * device for that title. Rejects with a message to show (a `SubtitleError`).
   */
  loadSubtitle(itemId: string, input: SubtitleInput): Promise<LoadedSubtitle> {
    return this.run('loadSubtitle', () => this.subs.load(itemId, input));
  }

  /**
   * Loads a subtitle file the source lists for the title (`VodPlayable.subtitles`), keeping its language. Its name
   * comes from its label or language, never from the link (which can carry the account's credentials).
   */
  loadSourceSubtitle(itemId: string, sub: SourceSubtitle): Promise<LoadedSubtitle> {
    return this.run('loadSourceSubtitle', () => this.subs.loadSource(itemId, sub));
  }

  /**
   * Automatic sync: the delay and speed that line the title's loaded file up with what the player recorded of the
   * stream's own subtitles (`alignSubtitle`), or undefined when there is no clear improvement on `current`. Runs here,
   * off the UI thread. Changes nothing: the player applies a result like a user's own delay.
   */
  syncSubtitle(itemId: string, sample: SyncSample, current: SyncSetting): Promise<SyncResult | undefined> {
    return this.run('syncSubtitle', () => this.subs.sync(itemId, sample, current));
  }

  /** The subtitles loaded earlier for a title, if any. */
  getSubtitle(itemId: string): Promise<LoadedSubtitle | undefined> {
    return this.run('getSubtitle', () => this.subs.get(itemId));
  }

  clearSubtitle(itemId: string): Promise<void> {
    return this.run('clearSubtitle', () => this.subs.clear(itemId));
  }

  /** Whether "Find subtitles online" can be offered (an app key is configured). */
  onlineSubtitlesAvailable(): Promise<boolean> {
    return Promise.resolve(this.subs.onlineAvailable());
  }

  /**
   * The languages this movie (or episode, with `seriesId`) has subtitles in online: one row per language, the
   * preferred language from Settings first, each with the file a click loads. `videoFps` (the playing video's frame
   * rate, when known) ranks the versions timed for it first.
   */
  findSubtitlesOnline(itemId: string, seriesId?: string, videoFps?: number): Promise<OnlineSubtitleLanguage[]> {
    return this.run('findSubtitlesOnline', () => this.subs.findOnline(itemId, seriesId, videoFps));
  }

  /**
   * Every version of the title's subtitles in one language, best first (ranked with `videoFps`). At most two searches
   * (pages 1 and 2; page 2 only when page 1 says there is more), so the service's rate limit is respected.
   */
  subtitleVersions(itemId: string, language: string, seriesId?: string, videoFps?: number): Promise<SubtitleVersion[]> {
    return this.run('subtitleVersions', () => this.subs.versions(itemId, language, seriesId, videoFps));
  }

  /** How much later (positive) or earlier the title's loaded subtitles show; kept with that file. */
  setSubtitleDelay(itemId: string, delayMs: number): Promise<void> {
    return this.run('setSubtitleDelay', () => this.subs.setDelay(itemId, delayMs));
  }

  /** How fast the title's loaded subtitles run against the video (a frame-rate fix); kept with that file. */
  setSubtitleSpeed(itemId: string, speed: number): Promise<void> {
    return this.run('setSubtitleSpeed', () => this.subs.setSpeed(itemId, speed));
  }

  /**
   * Downloads one file found online and keeps it for the title, like a loaded file, under `name` ("Swedish"). With
   * `details`, its language (so its other versions can be listed later) and the frame rate it was timed for.
   */
  loadOnlineSubtitle(itemId: string, fileId: number, name: string, details?: { language?: string; fps?: number; cc?: boolean }): Promise<LoadedSubtitle> {
    return this.run('loadOnlineSubtitle', () => this.subs.loadOnline(itemId, fileId, name, details));
  }

  refreshVod(kind: VodKind): Promise<void> {
    return this.run('refreshVod', () => this.vodFor(kind).refresh(kind));
  }

  /** Idle-time warm-up after live playback starts: loads the stored catalogue into memory; never fetches. */
  preloadVod(kind: VodKind): Promise<void> {
    return this.run('preloadVod', () => this.vodFor(kind).preload(kind));
  }

  // ---- live audio memory ----

  /** The remembered live audio track (a track key) for a channel of the active source; undefined when none. */
  getLiveAudio(channelId: string): Promise<string | undefined> {
    return this.run('getLiveAudio', async () => {
      const id = this.activeId;
      if (!id) return undefined;
      return (await this.liveAudio(id)).find((e) => e.id === channelId)?.key;
    });
  }

  /**
   * Remembers (or with `undefined` forgets) the live audio track for a channel of the active source. Kept per source
   * under `liveAudio:<sourceId>`, the latest LIVE_AUDIO_MAX channels.
   */
  setLiveAudio(channelId: string, key: string | undefined): Promise<void> {
    return this.run('setLiveAudio', async () => {
      const id = this.activeId;
      if (!id) return;
      const kept = (await this.liveAudio(id)).filter((e) => e.id !== channelId);
      if (key !== undefined) kept.push({ id: channelId, key });
      const next = kept.slice(Math.max(0, kept.length - LIVE_AUDIO_MAX));
      if (this.activeId !== id) return; // switched away meanwhile: no orphan key
      await this.storage.setMeta(liveAudioKey(id), next.length > 0 ? next : null);
    });
  }

  private async liveAudio(sourceId: string): Promise<LiveAudioEntry[]> {
    const v = await this.storage.getMeta<unknown>(liveAudioKey(sourceId)).catch(() => undefined);
    if (!Array.isArray(v)) return [];
    return v.filter((e): e is LiveAudioEntry =>
      !!e && typeof e === 'object' && typeof (e as LiveAudioEntry).id === 'string' && typeof (e as LiveAudioEntry).key === 'string');
  }

  // ---- settings, cache, diagnostics ----

  getSettings(): Promise<AppSettings> {
    return this.run('getSettings', () => this.currentSettings());
  }

  saveSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
    return this.run('saveSettings', () => this.applySettings(partial));
  }

  /**
   * `saveSettings` body; a restore passes `stamp: false` (it adopts the stamps it brings) and `locked: true` (it holds
   * the index lock, so a rebuild for Combine channels or Your countries runs inline; `refold`/`reregion` would wait
   * for that lock forever).
   */
  private async applySettings(partial: Partial<AppSettings>, opts: { stamp?: boolean; locked?: boolean } = {}): Promise<AppSettings> {
    const before = await this.currentSettings();
    this.settings = await this.service.saveSettings(partial, { stamp: opts.stamp });
    // Cached now/next was picked on the old offset's timeline.
    this.invalidateNowNext();
    const refold = before.combineChannels !== this.settings.combineChannels;
    const reregion = !sameRegions(before.regions, this.settings.regions) || before.foldCountries !== this.settings.foldCountries;
    if (opts.locked && (refold || reregion)) {
      this.setIndex(this.channels, this.index.layout(), this.coverage);
      this.invalidateNowNext();
      if (!this.backup.noteLayout()) this.emit({ type: 'layoutChanged', version: this.index.layout().version, origin: 'local' });
    } else if (refold) await this.refold();
    else if (reregion) await this.reregion();
    const regroup = before.combineDuplicates !== this.settings.combineDuplicates
      || before.combineCategories !== this.settings.combineCategories || reregion;
    if (regroup || before.preferredLanguages.join() !== this.settings.preferredLanguages.join()) this.vodc?.settingsChanged(regroup);
    return this.settings;
  }

  // ---- backup and restore (sync phase S1) ----

  /**
   * Makes an encrypted backup and sends it to the connected phone, which keeps it. Resolves with the recovery code
   * (shown once, never stored) after the phone said it saved the backup.
   */
  backupToPhone(): Promise<{ code: string; records: number }> {
    return this.run('backupToPhone', () => this.backup.toPhone());
  }

  /** Makes an encrypted backup as a file's text (off TVs: the UI saves it). */
  backupToFile(): Promise<{ code: string; data: string; fileName: string; records: number }> {
    return this.run('backupToFile', () => this.backup.toFile());
  }

  /** Restores a backup file's text with its recovery code. */
  restoreFromFile(data: string, code: string): Promise<RestoreSummary> {
    return this.run('restoreFromFile', () => this.backup.fromFile(data, code));
  }

  /** "Restore from your phone": the TV accepts one restore from the phone for RESTORE_WAIT_MS (or stops waiting). */
  armPhoneRestore(on: boolean): Promise<{ until: number | undefined }> {
    return this.run('armPhoneRestore', () => this.backup.armPhone(on));
  }

  /**
   * A restore sent by the paired phone (companion host only; not exposed to the UI). Accepted only while the TV waits
   * for it (`armPhoneRestore`); a success ends the wait, a wrong code keeps it so the user can try again.
   */
  restoreFromCompanion(envelope: BackupEnvelope, code: string): Promise<RestoreSummary> {
    return this.run('restoreFromCompanion', () => this.backup.fromCompanion(envelope, code));
  }

  clearCache(): Promise<InitState> {
    return this.run('clearCache', async () => {
      const id = this.activeId;
      if (id) {
        await this.service.clearCachedData(id);
        this.dropSports();
        await this.activate(id);
        this.startBackground(id);
      }
      return this.initState();
    });
  }

  diagnostics(): Promise<DiagnosticsInfo> {
    return this.run('diagnostics', async () => {
      const sources = await Promise.all((await this.service.listSources()).map(async (s) => {
        const stats = await this.storage.getMeta<{ channelCount?: number; skipped?: number; catchupChannels?: number; catchupUnsupported?: number }>(`parseStats:${s.id}`);
        return {
          id: s.id,
          name: s.name,
          kind: s.kind,
          channels: stats?.channelCount ?? 0,
          skipped: stats?.skipped ?? 0,
          playlistAt: (await this.storage.getMeta<number>(`playlistAt:${s.id}`)) ?? 0,
          epgAt: (await this.storage.getMeta<number>(`epgAt:${s.id}`)) ?? 0,
          guideImport: { ...(this.guideImports.get(s.id) ?? { stage: 'idle', count: 0, startedAt: 0 }) },
          ...catchupDiagnostics(s, stats),
        };
      }));
      const storage = await this.storageUse();
      return {
        appVersion: this.appVersion,
        sources,
        lastErrors: this.errors.map((e) => ({ ...e })),
        settings: await this.currentSettings(),
        ...(storage ? { storage } : {}),
      };
    });
  }

  /** Bytes used and available, when the device can say (any failure reads as "unknown"). */
  private async storageUse(): Promise<{ used: number; quota: number } | undefined> {
    try {
      const e = await this.storageEstimate?.();
      if (e && typeof e.usage === 'number' && typeof e.quota === 'number' && e.quota > 0) return { used: e.usage, quota: e.quota };
    } catch {
      // Unknown: the line is left out.
    }
    return undefined;
  }

  /** Test-only: resolves once every per-source queue (background and explicit refreshes) is empty. Not exposed over RPC. */
  async idle(): Promise<void> {
    while (this.queues.size || this.shortJobs.size || this.titles.jobs.size || this.regionJobs.size) {
      await Promise.all([...this.queues.values(), ...this.shortJobs, ...this.titles.jobs, ...this.regionJobs]);
    }
    await this.vodc?.idle();
    await this.trending?.idle();
    await this.service.syncClock.idle();
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
    const raw = toRpcError(err);
    // The name and a string code go through the same scrub as the message: any of them may hold a link.
    const rpc: RpcError = { ...raw, name: scrub(raw.name), ...(typeof raw.code === 'string' ? { code: scrub(raw.code) } : {}) };
    const message = scrub(raw.message);
    const clean = message === raw.message && rpc.name === raw.name && rpc.code === raw.code;
    const out = err instanceof Error && clean
      ? err
      : Object.assign(new Error(message), {
        name: rpc.name, ...(rpc.status !== undefined ? { status: rpc.status } : {}), ...(rpc.code !== undefined ? { code: rpc.code } : {}),
        ...(isUnreachable(err) ? { unreachable: true } : {}),
      });
    if (this.recorded.has(out)) return out;
    this.recorded.add(out);
    this.note(where, message, rpc);
    return out;
  }

  /** Adds a credential-free message to the diagnostics ring. */
  private note(where: string, message: string, rpc?: RpcError): void {
    this.errors.push({
      at: this.now(), where, message,
      ...(rpc ? { name: rpc.name } : {}),
      ...(rpc?.code !== undefined ? { code: rpc.code } : {}),
      ...(rpc?.status !== undefined ? { status: rpc.status } : {}),
    });
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
    // Independent reads go out together: on a TV each IDB round trip costs more than the data.
    const [sources, settings, stats, lastChannel, lastGroup, cooldown] = await Promise.all([
      this.summaries(),
      this.currentSettings(),
      id ? this.storage.getMeta<IngestResult>(`parseStats:${id}`) : undefined,
      id ? this.storage.getMeta<string>(`lastChannel:${id}`) : undefined,
      id ? this.storage.getMeta<string>(`lastGroup:${id}`) : undefined,
      id ? this.service.guard.status(id) : undefined,
    ]);
    const state: InitState = { sources, groups: id ? this.index.groups() : [], settings, hasVod: false };
    if (id) {
      state.activeSourceId = id;
      state.hasVod = await this.hasVod(id, stats, sources);
      if (lastChannel) state.lastChannelId = lastChannel;
      if (lastGroup) state.lastGroupId = lastGroup;
      state.cooldown = cooldown;
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
    // Item ids and stream URLs belong to a source (and its headers may have changed): its file hashes go with it.
    this.subs.reset();
    return this.withIndex(async () => {
      const [channels, layout, coverage, sources, , regions] = id
        ? await Promise.all([
          this.storage.getChannels(id), this.service.loadLayout(id), this.service.loadEpgCoverage(id), this.service.listSources(),
          // Combine duplicate channels decides how the index is built: read beside the rest, never after it.
          this.currentSettings(),
          // Detected at ingest: one small read beside the rest. A cold start never runs detection.
          this.service.loadRegions(id),
        ])
        : [[], emptyLayout(), undefined, [], undefined, undefined];
      this.regionRec = id && regions ? { sourceId: id, rec: regions } : undefined;
      const source = sources.find((s) => s.id === id);
      if (id !== this.activeId) {
        // Another source: its channels are neither focused nor playing yet.
        this.focusedId = undefined;
        this.playingId = undefined;
      }
      this.activeId = id;
      this.sourceKind = source?.kind;
      this.sourceHeaders = mergeHeaders(undefined, source && { userAgent: source.userAgent, referrer: source.referrer });
      this.sourceMaxConnections = source?.kind === 'xtream' ? source.maxConnections : undefined;
      this.vodc?.reset(id);
      this.catchup.reset();
      this.setIndex(channels, layout, coverage);
      this.invalidateNowNext();
      if (id && !regions && channels.length) this.redetectLater(id);
    });
  }

  /**
   * No current region record (an older detector version, or none yet): rebuilt from the stored channels after the
   * index is swapped in, never before; then the index is rebuilt with it.
   */
  private redetectLater(id: string): void {
    const job = (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (this.activeId !== id) return;
      const rec = await this.service.redetectRegions(id).catch((err: unknown) => { this.record('redetectRegions', err); return undefined; });
      if (!rec) return;
      let swapped = false;
      await this.withIndex(async () => {
        if (this.activeId !== id) return;
        this.regionRec = { sourceId: id, rec };
        this.setIndex(this.channels, this.index.layout(), this.coverage);
        swapped = true;
      });
      if (swapped) this.emit({ type: 'layoutChanged', version: this.index.layout().version, origin: 'local' });
    })();
    this.regionJobs.add(job);
    void job.finally(() => this.regionJobs.delete(job));
  }

  /** Your countries changed: the same channels and layout under another region view. */
  private async reregion(): Promise<void> {
    await this.withIndex(async () => {
      this.setIndex(this.channels, this.index.layout(), this.coverage);
    });
    this.emit({ type: 'layoutChanged', version: this.index.layout().version, origin: 'local' });
  }

  /** The region view of the active source under the current settings; undefined without a record. */
  private regionViewFor(): ChannelRegionView | undefined {
    const r = this.regionRec;
    if (!r || r.sourceId !== this.activeId) return undefined;
    const s = this.settings ?? DEFAULT_SETTINGS;
    const key = `${s.regions.mode}|${s.regions.codes.join(',')}|${s.foldCountries ? 'fold' : 'flat'}`;
    if (this.regionView?.rec === r.rec && this.regionView.key === key) return this.regionView.view;
    const view: ChannelRegionView = { detected: r.rec.groups, codes: [...s.regions.codes], mode: s.regions.mode, fold: s.foldCountries };
    this.regionView = { rec: r.rec, key, view };
    return view;
  }

  /** Combine duplicate channels was switched: the same channels, layout and guide, folded or not. */
  private async refold(): Promise<void> {
    await this.withIndex(async () => {
      this.setIndex(this.channels, this.index.layout(), this.coverage);
      this.invalidateNowNext();
    });
    const version = this.index.layout().version;
    this.emit({ type: 'layoutChanged', version, origin: 'local' });
  }

  /** After a playlist refresh: rebuild the active index from the new channels, keeping the in-memory layout. */
  private rebuildIndex(id: string): Promise<void> {
    return this.withIndex(async () => {
      if (this.activeId !== id) return;
      const [channels, coverage, regions] = await Promise.all([
        this.storage.getChannels(id), this.service.loadEpgCoverage(id), this.service.loadRegions(id),
      ]);
      this.regionRec = regions ? { sourceId: id, rec: regions } : undefined;
      this.catchup.reset();
      this.setIndex(channels, this.index.layout(), coverage);
      this.invalidateNowNext();
    });
  }

  /**
   * After a guide refresh: rebuild the active index with the new coverage (the channels in memory are reused). The
   * same coverage keeps the index (a rebuild costs up to a second on a TV); what came from the old guide still goes.
   */
  private reloadCoverage(id: string): Promise<void> {
    return this.withIndex(async () => {
      if (this.activeId !== id) return;
      const coverage = await this.service.loadEpgCoverage(id);
      if (sameCoverage(this.coverage, coverage)) {
        this.dropGuideDerived();
      } else {
        this.setIndex(this.channels, this.index.layout(), coverage);
      }
      this.invalidateNowNext();
    });
  }

  /** Swaps in a fresh index. Caller holds the index lock. */
  private setIndex(channels: Channel[], layout: Layout, coverage: Set<string> | undefined): void {
    this.channels = channels;
    this.shifts = shiftSpan(channels);
    this.coverage = coverage;
    const fold = (this.settings ?? DEFAULT_SETTINGS).combineChannels;
    const regions = this.regionViewFor();
    this.index = new ChannelIndex(channels, layout, coverage, regions ? { fold, regions } : { fold });
    this.favSet = undefined;
    this.companionStale();
    this.dropGuideDerived();
  }

  /** Forgets what was built from the guide and the index: the title index and the sports mapping. */
  private dropGuideDerived(): void {
    this.titles.drop();
    this.dropSports();
    this.sportsMapping++;
  }

  /** Forgets the grouped events and the in-memory sports index record (the guide or the source changed). */
  private dropSports(): void {
    this.sports.invalidate();
    this.sportsRec = undefined;
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
    // On the TV a combined channel's row stands for all its streams: removing it from a list, hiding or showing it
    // covers every one. The phone edits single channels and stays exact.
    if (origin === 'local' && this.index.folding()) valid.splice(0, valid.length, ...valid.map((op) => this.forRow(op)));
    const res = applyOps(before, valid);
    for (const r of res.rejected) rejected.push({ index: at ? at[r.index]! : r.index, reason: r.reason });
    rejected.sort((a, b) => a.index - b.index);
    if (!res.changed) return { version, rejected };

    // Stamps the sync clocks of what changed (`markWatched` alone touches none: zapping writes no sync state).
    await this.commitLayoutLocked(id, before, res.layout, res.touched, origin);
    return { version: res.layout.version, rejected };
  }

  /** Stores the active source's new layout, swaps it into the index and tells the UI. Caller holds the index lock. */
  private async commitLayoutLocked(id: string, before: Layout, layout: Layout, touched: readonly string[], origin: LayoutOrigin): Promise<void> {
    await this.service.saveLayout(id, layout, touched);
    this.index = this.index.withLayout(layout);
    // Shown groups and group regions decide what the region rule hides: they map candidates to channels too.
    if (before.hiddenChannels !== layout.hiddenChannels || before.hiddenGroups !== layout.hiddenGroups || before.hideNoEpg !== layout.hideNoEpg
      || before.shownGroups !== layout.shownGroups || before.groupRegion !== layout.groupRegion) this.sportsMapping++;
    this.favSet = undefined;
    if (before.channelNames !== layout.channelNames) this.invalidateNowNext();
    // A restore tells the UI once, when it is done.
    if (this.backup.noteLayout()) return;
    const event: Extract<AppEvent, { type: 'layoutChanged' }> = { type: 'layoutChanged', version: layout.version, origin: origin === 'remote' ? 'remote' : 'local' };
    if (onlyRecentChanged(before, layout)) event.recentOnly = true;
    this.emit(event);
  }

  /** `op` with a combined channel's row id widened to every stream of the row (list removal, hide, show). */
  private forRow(op: LayoutOp): LayoutOp {
    const widen = (ids: readonly string[]) => [...new Set(ids.flatMap((id) => {
      const m = this.index.memberIds(id);
      return m.length ? m : [id];
    }))];
    switch (op.op) {
      case 'removeFromList': return { ...op, channelIds: widen(op.channelIds) };
      case 'hideChannels':
      case 'unhideChannels': return { ...op, ids: widen(op.ids) };
      default: return op;
    }
  }

  /**
   * The channels guide lookups use, under the same ids: a renamed channel's playlist original (its name and epgKey),
   * and for a combined channel the stream that carries its guide id.
   */
  private originals(channels: Channel[]): Channel[] {
    const names = this.index.layout().channelNames;
    if (!this.index.folding() && !channels.some((c) => HAS.call(names, c.id))) return channels;
    return channels.map((c) => this.index.guideChannel(c));
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
    this.epgLate.clear();
    this.epgFailed.clear();
  }

  private async matchTiles(): Promise<MatchTiles> {
    const view = await this.sportsView();
    const st = await this.currentSettings();
    return matchTiles(view, this.now(), this.matchSettings(st), this.sports.aliases());
  }

  private matchSettings(st: Awaited<ReturnType<AppApi['currentSettings']>>): MatchSettings {
    const s: MatchSettings = {
      followed: st.followedTeams, pinned: st.pinnedCompetitions, hidden: st.hiddenCompetitions, categories: st.matchCategories,
    };
    // G8: a small match still shows in the row when it airs on a channel of a chosen country (Your countries on).
    if (st.regions.mode !== 'off' && st.regions.codes.length) s.countries = st.regions.codes;
    return s;
  }

  private async sportsView() {
    const id = this.activeId;
    if (!id) return this.sports.view('', undefined, this.index, 0);
    const settings = await this.currentSettings();
    let rec = this.sportsRec?.sourceId === id ? this.sportsRec.rec : undefined;
    if (!rec) {
      rec = await this.service.sportsIndexFor(id);
      // Only a found record is kept: a missing one may still be on its way.
      if (rec && this.activeId === id) this.sportsRec = { sourceId: id, rec };
    }
    return this.sports.view(id, rec, this.index, settings.epgOffsetHours, this.sportsMapping);
  }

  /** Matching programmes on the displayed timeline: airing now (per channel) and later (one per title). */
  private async programmeHits(data: TitleIndexData, query: string): Promise<{
    onNow: { c: Channel; title: string; start: number; stop: number }[];
    later: { c: Channel; title: string; start: number; stop: number; more: number }[];
  }> {
    const settings = await this.currentSettings();
    const t = this.now();
    const shiftOf = (c: Channel) => (settings.epgOffsetHours + (c.epgShift ?? 0)) * HOUR;
    const maxShift = maxShiftMs(this.shifts, settings.epgOffsetHours);
    const favs = this.favourites();
    const onNow: { c: Channel; title: string; start: number; stop: number }[] = [];
    const later: { c: Channel; title: string; start: number; stop: number; more: number }[] = [];
    for (const m of queryTitles(data, query, t - maxShift, SEARCH_TITLES)) {
      let next: { c: Channel; start: number; stop: number } | undefined;
      let nextKey = Number.POSITIVE_INFINITY;
      let upcoming = 0;
      const titleNow: { c: Channel; title: string; start: number; stop: number }[] = [];
      // Airings tied on start come in index (epgKey) order; favourites, then your countries, then start, then the lower channel number.
      for (const a of m.airings) {
        for (const c of this.index.channelsForEpgKey(a.epgKey)) {
          const s = shiftOf(c);
          const start = a.start + s;
          const stop = a.stop + s;
          if (stop <= t) continue;
          if (start <= t) titleNow.push({ c, title: m.display, start, stop });
          else {
            upcoming++;
            const k = this.countryKey(favs, c.id);
            if (!next || k < nextKey || (k === nextKey && (start < next.start || (start === next.start && c.number < next.c.number)))) { next = { c, start, stop }; nextKey = k; }
          }
        }
      }
      titleNow.sort((x, y) => this.countryKey(favs, x.c.id) - this.countryKey(favs, y.c.id) || x.start - y.start || x.c.number - y.c.number);
      for (const h of titleNow) onNow.push(h);
      if (next) later.push({ ...next, title: m.display, more: upcoming - 1 });
    }
    return { onNow, later };
  }

  private favourites(): Set<string> {
    const fav = this.index.layout().lists.find((l) => l.id === FAV_LIST_ID);
    return (this.favSet ??= new Set(fav?.channelIds ?? []));
  }

  /** Sort key for Search and the match picker: favourites first (-1), then your countries in pick order, then the rest. */
  private countryKey(favs: ReadonlySet<string>, id: string): number {
    if (favs.has(id) || this.index.memberIds(id).some((m) => favs.has(m))) return -1;
    return this.index.countryRankOf(id);
  }

  private setOffline(value: boolean): void {
    // A refresh got through: what failed during the outage is not "failed while offline" anymore.
    if (!value) this.offlineFails.clear();
    if (this.offline === value) return;
    this.offline = value;
    this.emit({ type: 'offline', value });
  }

  /**
   * Tells the UI. When a wait ends, the background pass of the active source runs again (a stale list or guide is the
   * probe); when a probe got through, the refreshes skipped meanwhile run. A manual retry starts nothing here: the
   * user's own attempt (a stream, a saved source) is the probe.
   */
  private cooldownChanged(key: string, cooldown: SourceCooldown, cause: CooldownCause): void {
    const owner = streamKeySource(key);
    if (owner !== undefined) {
      // Only the streams on one host: the source's own requests are not affected.
      this.emit({ type: 'cooldown', sourceId: owner, streamKey: key, cooldown });
      return;
    }
    const sourceId = key;
    this.emit({ type: 'cooldown', sourceId, cooldown });
    if (sourceId !== this.activeId) return;
    if (cause === 'expired' || (cause === 'answered' && !this.background.has(sourceId))) this.startBackground(sourceId);
  }

  private failed(what: 'playlist' | 'epg', sourceId: string, where: string, err: unknown): never {
    const out = this.record(where, err);
    const error = toRpcError(out);
    // Only a request that never reached the source means offline: a stall, a timeout or an odd answer does not.
    if (isUnreachable(err)) {
      this.setOffline(true);
      this.offlineFails.add(`${sourceId}\u0000${what}`);
    }
    this.emit({ type: 'refreshFailed', what, sourceId, error });
    throw out;
  }

  /** `automatic`: a background refresh, whose failure records the refresh backoff. */
  private async refreshPlaylistFor(id: string, automatic = false): Promise<void> {
    let result: IngestResult | undefined;
    try {
      result = await this.service.refreshPlaylist(id, (p) => this.emit({ type: 'progress', ...p }), { automatic });
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
   * so the controller drops it and the TV is told (both kinds, with the ingest counts).
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
      // Both kinds, always: a kind whose count dropped to 0 must clear an open tab too.
      for (const kind of ['movie', 'series'] as const) {
        this.emit({ type: 'vodRefreshed', sourceId: id, kind, count: counts[kind], truncated: false });
      }
      // Keep the idle preload's benefit: reload the kind that was resident (reads storage only if nothing is resident).
      if (resident) void this.vodc.preload(resident).catch((err) => { this.record('preloadVod', err); });
    } catch (err) {
      this.record('refreshPlaylist', err);
    }
  }

  private async refreshEpgFor(id: string, automatic = false): Promise<void> {
    const state: GuideImportState = { stage: 'importing', count: 0, startedAt: this.now() };
    // Shown as importing once the import holds the source lock (or reports progress): while it waits behind
    // another task, Diagnostics keeps the previous state instead of "importing 0 programmes".
    let begun = false;
    const begin = () => {
      if (begun) return;
      begun = true;
      state.startedAt = this.now();
      this.guideImports.set(id, state);
    };
    try {
      // The active source's channels are in memory already: the import matches against them (no 54k re-read).
      const channels = () => (this.activeId === id && this.channels.length ? this.channels : undefined);
      await this.service.refreshEpg(id, (p) => {
        begin();
        state.count = p.count;
        this.emit({ type: 'progress', ...p });
      }, { automatic, channels, onStart: begin });
    } catch (err) {
      try {
        this.failed('epg', id, 'refreshEpg', err);
      } catch (out) {
        this.guideImports.set(id, { stage: 'failed', count: state.count, startedAt: state.startedAt, error: toRpcError(out) });
        throw out;
      }
    }
    this.guideImports.set(id, { ...state, stage: 'idle' });
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
    // A cooling source gets nothing, and no "couldn't refresh" toast: the cooldown copy says it all. The end of the
    // wait (or a retry) starts this pass again.
    if ((await this.service.guard.status(id)).state !== 'clear') return;
    // Each step is caught on its own: a failed channel refresh (already recorded, with its backoff, and emitted as
    // refreshFailed) must not keep the guide from updating. No retry is added: each step still runs at most once.
    let failure: unknown;
    let playlist = false;
    try {
      // An empty channel cache means "not loaded yet" (or lost), unless the source only has movies and series: then
      // the normal staleness rule applies, so a VOD-only playlist is not downloaded again on every cold start.
      // A failed automatic refresh holds the next one off (15 min, 1 h, 6 h) even with an empty cache; a manual
      // refresh (`refresh`) is never held off.
      playlist = (this.activeId === id && this.totalChannels() === 0 && await this.expectsChannels(id)
        && !(await this.service.refreshBackedOff(id, 'playlist')))
        || await this.service.needsPlaylistRefresh(id);
    } catch (err) {
      try { this.failed('playlist', id, 'backgroundRefresh', err); } catch (out) { failure = out; }
    }
    if (playlist) {
      try {
        await this.refreshPlaylistFor(id, true);
      } catch (err) {
        failure ??= err;
      }
    }
    // The failed step may have started a cooldown (a refusing source): then the guide waits like everything else.
    // So does a step whose request never reached the source (offline), when the guide comes from that same host: its
    // much larger download would fail the same way. A stall, a timeout or an odd answer still lets the guide run.
    if (failure !== undefined && ((isUnreachable(failure) && await this.guideSharesHost(id))
      || (await this.service.guard.status(id)).state !== 'clear')) {
      throw failure;
    }
    let epg = false;
    try {
      epg = await this.service.needsEpgRefresh(id);
    } catch (err) {
      try { this.failed('epg', id, 'backgroundRefresh', err); } catch (out) { failure ??= out; }
    }
    if (epg) {
      try {
        await this.refreshEpgFor(id, true);
      } catch (err) {
        failure ??= err;
      }
    }
    if (failure !== undefined) throw failure;
  }

  /** `guideOnPlaylistHost` for source `id`; a source that is gone counts as the same host (nothing to download). */
  private async guideSharesHost(id: string): Promise<boolean> {
    const source = (await this.service.listSources()).find((s) => s.id === id);
    return source === undefined || guideOnPlaylistHost(source);
  }

  /**
   * Whether an empty channel cache must be filled: the last ingest found channels (a lost cache), or the source is not
   * known to have movies or series (never loaded, or live only).
   */
  private async expectsChannels(id: string): Promise<boolean> {
    const stats = await this.storage.getMeta<IngestResult>(`parseStats:${id}`);
    return (stats?.channelCount ?? 0) > 0 || !(await this.hasVod(id, stats));
  }

  /**
   * Whether a source has movies or series, from stored meta only: the last ingest counted some (M3U) or found the
   * categories of a live-empty account (Xtream), or a catalogue was fetched (Xtream). An M3U `vodAt` is not used:
   * every M3U ingest stamps it, with or without titles.
   * `stats` and `sources` are passed by callers that already read them (one `parseStats` read per init).
   */
  private async hasVod(
    id: string, stats?: IngestResult | undefined, sources?: readonly { id: string; kind: SourceConfig['kind'] }[],
  ): Promise<boolean> {
    stats ??= await this.storage.getMeta<IngestResult>(`parseStats:${id}`);
    if ((stats?.movieCount ?? 0) > 0 || (stats?.seriesCount ?? 0) > 0 || stats?.vodCatalogue === true) return true;
    const source = (sources ?? await this.service.listSources()).find((s) => s.id === id);
    if (source?.kind !== 'xtream') return false;
    const [movieAt, seriesAt] = await Promise.all(
      (['movie', 'series'] as const).map((kind) => this.storage.getMeta<number>(`vodAt:${kind}:${id}`)),
    );
    return (movieAt ?? 0) > 0 || (seriesAt ?? 0) > 0;
  }

  /** Every channel of the active source, hidden ones (and those in hidden groups or without a guide) included. */
  private totalChannels(): number {
    return this.channels.length;
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
    // Rows whose guide read is still running from an earlier call: empty now, their answer comes as nowNextUpdated.
    const fresh = misses.filter((c) => !this.nnPending.has(c.id));
    for (const c of misses) if (this.nnPending.has(c.id)) out.set(c.id, {});
    if (fresh.length === 0) return out;
    const gen = this.generation;
    const store = (fetched: Map<string, NowNext>): Map<string, NowNext> => {
      const kept = new Map<string, NowNext>();
      for (const c of fresh) {
        const nn = fetched.get(c.id) ?? {};
        kept.set(c.id, nn);
        // A background short-EPG answer may already have landed for this channel: keep it.
        const landed = this.nnCache.get(c.id);
        if (gen === this.generation && !(landed && landed.at >= t)) this.nnCache.set(c.id, { at: t, nn });
      }
      return kept;
    };
    const lookup = this.lookupNowNext(id, fresh, t, false);
    const first = await this.withinWait(lookup);
    if (first !== LATE) {
      for (const [cid, nn] of store(first)) out.set(cid, nn);
      return out;
    }
    // The guide store is busy (a long clear or import in another tab): the rows go out without now/next, never held.
    for (const c of fresh) {
      out.set(c.id, {});
      this.nnPending.add(c.id);
    }
    const job = lookup.then((fetched) => {
      const kept = store(fetched);
      if (gen !== this.generation || this.activeId !== id) return;
      const changed = [...kept].filter(([, nn]) => nn.now || nn.next).map(([cid]) => cid);
      if (changed.length) this.emit({ type: 'nowNextUpdated', channelIds: changed });
    }).catch((err: unknown) => this.note('nowNext', err instanceof Error ? err.name : 'Error')).finally(() => {
      for (const c of fresh) this.nnPending.delete(c.id);
      this.shortJobs.delete(job);
    });
    this.shortJobs.add(job);
    return out;
  }

  /**
   * `read`, or `LATE` once it has taken `nowNextWaitMs` (it keeps running). A healthy guide read takes a few ms even on
   * a TV; this only trips while the guide store is busy (a long write of an import, or a clear in another tab).
   */
  private async withinWait<T>(read: Promise<T>): Promise<T | typeof LATE> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      read,
      new Promise<typeof LATE>((resolve) => { timer = setTimeout(() => resolve(LATE), this.nowNextWaitMs); }),
    ]).finally(() => clearTimeout(timer));
  }

  /**
   * The stored programmes of the Guide rows `channels`, like `nowNextCached`: a read that outlasts `nowNextWaitMs`
   * answers nothing now (the rows go out lite, never held) and `nowNextUpdated` once it is done. Its answer is kept
   * for the re-read that event asks for, which uses it once instead of reading again.
   */
  private async guideRead(id: string, channels: Channel[], lo: number, hi: number): Promise<Map<string, Programme[]>> {
    const key = `${id}\u0000${lo}\u0000${hi}\u0000${channels.map((c) => c.id).join('\u0001')}`;
    const ready = this.epgLate.get(key);
    if (ready) {
      this.epgLate.delete(key);
      return ready;
    }
    // The same rows' read from an earlier call still runs: lite now, its answer comes as nowNextUpdated.
    if (this.epgPending.has(key)) return new Map();
    const gen = this.generation;
    const read = this.service.programmesFor(id, this.originals(channels), lo, hi);
    const first = await this.withinWait(read);
    if (first !== LATE) return first;
    this.epgPending.add(key);
    let emit = true;
    const job = read.then((got) => {
      // An answer from a source that is no longer active is dropped without a word: nobody reads its rows now.
      if (this.activeId !== id) { emit = false; return; }
      // An answer from before a guide change is dropped; the rows still hear about it and read again.
      if (gen !== this.generation) return;
      this.epgLate.set(key, got);
      for (const old of this.epgLate.keys()) {
        if (this.epgLate.size <= EPG_LATE_MAX) break;
        this.epgLate.delete(old);
      }
    }).catch((err: unknown) => {
      this.note('epgRows', err instanceof Error ? err.name : 'Error');
      // A failing read asks for one re-read per page and generation; if reads always fail, the grid must not loop.
      if (this.epgFailed.has(key)) emit = false;
      else this.epgFailed.add(key);
    }).finally(() => {
      this.epgPending.delete(key);
      this.shortJobs.delete(job);
      // Also after a dropped or first failed read: lite rows must never wait for the next 15-minute guide tick.
      if (emit) this.emit({ type: 'nowNextUpdated', channelIds: channels.map((c) => c.id) });
    });
    this.shortJobs.add(job);
    return new Map();
  }

  /**
   * Now/next on the displayed (shifted) timeline: "now" is the programme whose shifted interval contains `t`.
   * Stored programmes only, fetched over a window wide enough for every channel's shift, so this never waits on
   * the network. A channel with nothing stored uses its cached short-EPG answer while that is good; without one it
   * gets an empty pair now and, with `shortEpg`, a background lookup (`startShortEpg`) whose answer is announced
   * with `nowNextUpdated`.
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
      let list = stored.get(c.id) ?? [];
      if (list.length === 0) {
        const cached = this.shortCache.get(id, c.id, t);
        if (cached) list = cached;
        else missing.push({ c, h });
      }
      out.set(c.id, nowNext(list.map((p) => applyShift(p, h)), t));
    });
    if (missing.length && shortEpg) this.startShortEpg(id, missing);
    return out;
  }

  /**
   * The focused or playing channel `c`: a background short-EPG lookup unless a fresh now/next answer already has
   * something for it. Decided from memory while browsing (no IDB traffic): only Xtream has a short EPG, and every
   * row the UI read in the last minute sits in `nnCache`. An empty fresh answer (the stored guide ran out, or the
   * channel is not in the guide) and a channel nobody read yet go through `lookupNowNext`, which reads once and
   * then asks the short EPG for whatever is still missing. Guide coverage alone is not enough: a covered channel
   * whose programmes ended must still get the short-EPG fallback.
   */
  private async wantShortEpg(c: Channel): Promise<void> {
    const id = this.activeId;
    if (!id || this.sourceKind !== 'xtream') return;
    const t = this.now();
    const hit = this.nnCache.get(c.id);
    if (hit && t - hit.at < NOW_NEXT_TTL_MS && (hit.nn.now !== undefined || hit.nn.next !== undefined)) return;
    await this.lookupNowNext(id, [c], t, true);
  }

  /** `wantShortEpg` without waiting (tracked for `idle`); a failure is noted by its name only. */
  private backgroundShortEpg(c: Channel): void {
    const job = this.wantShortEpg(c)
      .catch((err: unknown) => this.note('shortEpg', err instanceof Error ? err.name : 'Error'))
      .finally(() => this.shortJobs.delete(job));
    this.shortJobs.add(job);
  }

  /**
   * Fire-and-forget Xtream short-EPG lookup for channels without stored programmes (the service runs one request at
   * a time, spaces them per source, bounds the waiting queue and skips it while a guide refresh of the source runs).
   * A lookup is stale, and sends no request, once the generation or the active source changed, the source was
   * deleted, or the channel is neither the focused nor the playing one. Answers are cached per source while it is
   * still active (`shortCache`); only answers of the current generation update the rows.
   */
  private startShortEpg(id: string, missing: { c: Channel; h: number }[]): void {
    if (this.service.isRefreshingEpg(id) || this.service.guard.isBlocked(id)) return;
    const todo = missing.filter(({ c }) => !this.shortPending.has(c.id));
    if (todo.length === 0) return;
    for (const { c } of todo) this.shortPending.add(c.id);
    const gen = this.generation;
    const isStale = (c: Channel) =>
      gen !== this.generation || this.activeId !== id || (c.id !== this.focusedId && c.id !== this.playingId);
    const job = this.service.shortEpgFor(id, this.originals(todo.map((m) => m.c)), { isStale }).then((found) => {
      if (this.activeId !== id) return; // switched away or deleted meanwhile
      const t = this.now();
      const current = gen === this.generation;
      const changed: string[] = [];
      for (const { c, h } of todo) {
        const pair = found.get(c.id);
        if (!pair) continue; // skipped or dropped: nothing was asked
        const raw = [pair.now, pair.next].filter((p): p is Programme => p !== undefined);
        const nn = nowNext(raw.map((p) => applyShift(p, h)), t);
        this.shortCache.set(id, c.id, raw, shortEpgUntil(nn, t));
        if (!current) continue;
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

  /** The active source's catch-up context for `channelId` (undefined without catch-up). */
  private async catchupContext(channelId: string): Promise<CatchupContext | undefined> {
    const id = this.activeId;
    const shown = this.index.get(channelId);
    if (!id || !shown?.cu) return undefined;
    const [channel] = this.originals([shown]);
    const source = (await this.service.listSources()).find((s) => s.id === id);
    if (!source || !channel) return undefined;
    const settings = await this.currentSettings();
    return { sourceId: id, source, channel, shiftHours: settings.epgOffsetHours + (channel.epgShift ?? 0) };
  }

  /** The stored programme of the context's channel that starts at `start` (displayed). */
  private async programmeAt(ctx: CatchupContext, start: number): Promise<Programme | undefined> {
    const stored = start - ctx.shiftHours * HOUR;
    const found = await this.service.programmesFor(ctx.sourceId, [ctx.channel], stored - 60_000, stored + 60_000);
    return (found.get(ctx.channel.id) ?? []).map((p) => applyShift(p, ctx.shiftHours)).find((p) => Math.abs(p.start - start) < 60_000);
  }

  /** Rows without now/next (the Guide draws its own programmes): no storage read at all. */
  private liteRows(channels: Channel[]): ChannelRow[] {
    const favs = this.favourites();
    return channels.map((c) => this.baseRow(c, favs));
  }

  /** A row without now/next: a combined channel carries its stream count and best quality, and is a favourite when any stream is. */
  private baseRow(c: Channel, favs: ReadonlySet<string>): ChannelRow {
    const favourite = favs.has(c.id) || (c.quality !== undefined && this.index.memberIds(c.id).some((m) => favs.has(m)));
    const row: ChannelRow = { id: c.id, number: c.number, name: c.name, group: c.group, favourite };
    if (c.logo) row.logo = c.logo;
    if (c.cu) row.archiveDays = c.cu.days;
    if (c.sources !== undefined) row.sourceCount = c.sources;
    const q = c.quality === undefined ? '' : QUALITY_LABELS[c.quality] ?? '';
    if (q) row.quality = q;
    return row;
  }

  /** Rows with now/next from the stored guide and cached short-EPG answers. Never starts a short-EPG lookup. */
  private async toRows(channels: Channel[]): Promise<ChannelRow[]> {
    if (channels.length === 0) return [];
    const nn = await this.nowNextCached(channels);
    const favs = this.favourites();
    return channels.map((c) => {
      const pair = nn.get(c.id);
      const row = this.baseRow(c, favs);
      if (pair?.now) row.now = toLite(pair.now);
      if (pair?.next) row.next = toLite(pair.next);
      return row;
    });
  }

  /**
   * `channel`'s stream, shown as `shown` (a combined channel's row: its name, number and guide; else the channel).
   */
  private async playable(channel: Channel | undefined, shown: Channel | undefined = channel): Promise<PlayableChannel | undefined> {
    if (!channel || !shown) return undefined;
    // The row about to play (or being re-read while it plays): the only row, with the focused one, that may ask the
    // short EPG.
    this.playingId = shown.id;
    // The host's cooldown read starts now, beside the row (an alternate format keeps the host).
    const early = this.streamCooldown(channel.url);
    const [row] = await this.toRows([shown]);
    // Never on the zap path's clock: the lookup's local guide read runs in the background.
    if (!row!.now && !row!.next) this.backgroundShortEpg(shown);
    const { url, alternateUrl } = await this.streamUrls(channel);
    const out: PlayableChannel = { ...row!, id: channel.id, url };
    if (alternateUrl) out.alternateUrl = alternateUrl;
    // The channel's own headers (from the playlist) win over the source's settings, field by field.
    const headers = mergeHeaders(this.sourceHeaders, channel.headers);
    if (headers) out.headers = headers;
    await this.addStreamCooldown(out, early);
    return out;
  }

  /** `getPlayable` body: a combined channel's best (or exact) stream, under its row. */
  private async livePlayable(channelId: string, exact: boolean): Promise<PlayableChannel | undefined> {
    const rowId = this.index.rowOf(channelId);
    if (!rowId) return undefined;
    if (!this.index.folding() || this.index.memberIds(rowId).length < 2) return this.playable(this.index.get(channelId));
    const sources = await this.orderedSources(rowId);
    if (sources.length < 2) return this.playable(this.index.get(exact ? channelId : sources[0]?.id ?? channelId));
    const target = exact ? channelId : sources[0]!.id;
    const out = await this.playable(this.index.get(target), this.index.rowChannel(rowId));
    if (!out) return undefined;
    out.rowId = rowId;
    const at = sources.findIndex((s) => s.id === target);
    out.sources = at > 0 ? [sources[at]!, ...sources.slice(0, at), ...sources.slice(at + 1)] : sources;
    return out;
  }

  /** A row's streams best first (spec 2026-10-19-live-grouping §4). */
  private async orderedSources(rowId: string): Promise<LiveSourceView[]> {
    const id = this.activeId;
    const members = this.index.sources(rowId);
    if (!id || members.length === 0) return [];
    const key = this.index.foldKey(rowId);
    const last = key === undefined ? undefined : await this.liveMem.pick(id, key);
    const cands = await Promise.all(members.map(async (c) => {
      const info = this.index.memberInfo(c.id) ?? { quality: 4, backup: false, chosen: false };
      const blocked = (await this.service.guard.status(streamCooldownKey(id, c.url))).state !== 'clear';
      return {
        c, id: c.id, quality: info.quality, backup: info.backup, preferred: info.chosen, blocked,
        bad: blocked || this.liveMem.isBad(c.id),
      };
    }));
    const dupName = new Set<string>();
    const seen = new Set<string>();
    for (const x of cands) (seen.has(x.c.name) ? dupName : seen).add(x.c.name);
    return orderLiveSources(cands, last === undefined ? {} : { last }).map((x) => {
      const v: LiveSourceView = {
        id: x.id, label: dupName.has(x.c.name) ? `${x.c.name} · ${x.c.group}` : x.c.name, bad: x.bad, blocked: x.blocked,
      };
      const q = QUALITY_LABELS[x.quality];
      if (q) v.quality = q;
      return v;
    });
  }

  /** A stream showed its first frame: remembered for its row when the row has several, and no longer known-bad. */
  private async notePlayedSource(sourceId: string, c: Channel): Promise<void> {
    this.liveMem.played(c.id);
    if (!this.index.folding() || this.index.memberIds(c.id).length < 2) return;
    const key = this.index.foldKey(c.id);
    if (key !== undefined) await this.liveMem.remember(sourceId, key, c.id);
  }

  /** Starts reading the cooldown of `url`'s host (loaded from storage if needed). */
  private streamCooldown(url: string): { key: string; status: Promise<SourceCooldown> } | undefined {
    const id = this.activeId;
    if (!id) return undefined;
    const key = streamCooldownKey(id, url);
    return { key, status: this.service.guard.status(key) };
  }

  /**
   * The stream's host cooldown key, and its cooldown when not clear. `early`: a read already started for that host
   * (reused when the final URL kept it).
   */
  private async addStreamCooldown(
    out: { url: string; cooldownKey?: string; cooldown?: SourceCooldown },
    early?: { key: string; status: Promise<SourceCooldown> },
  ): Promise<void> {
    const read = early && this.activeId !== undefined && early.key === streamCooldownKey(this.activeId, out.url)
      ? early
      : this.streamCooldown(out.url);
    if (!read) return;
    out.cooldownKey = read.key;
    const c = await read.status;
    if (c.state !== 'clear') out.cooldown = c;
  }

  /**
   * The channel's URL in the format to try first and, for Xtream live URLs, the other format: the format that played
   * last on the active source, unless the preferred-format setting changed since; else the setting.
   */
  private async streamUrls(channel: Channel): Promise<{ url: string; alternateUrl?: string }> {
    const other = alternateStreamUrl(channel.url);
    if (!other) return { url: channel.url };
    const id = this.activeId;
    const memo = id === undefined ? undefined : await this.lastFormat(id);
    const first = firstFormat((await this.currentSettings()).preferredFormat, memo);
    return formatOf(channel.url) === first ? { url: channel.url, alternateUrl: other } : { url: other, alternateUrl: channel.url };
  }

  /** Source `id`'s format memo, read from storage on first use. */
  private async lastFormat(id: string): Promise<FormatMemo | undefined> {
    if (!this.formats.has(id)) {
      const v = await this.storage.getMeta<unknown>(formatMemoKey(id)).catch(() => undefined);
      this.formats.set(id, isFormatMemo(v) ? v : null);
    }
    return this.formats.get(id) ?? undefined;
  }
}

/**
 * Whether the guide of `source` is downloaded from the host its channel list comes from: an Xtream source always; an
 * M3U source when its guide link has the playlist's host (a guide elsewhere may still answer while the playlist host
 * is down). A link that does not parse counts as the same host: its download would fail anyway.
 */
function guideOnPlaylistHost(source: SourceConfig): boolean {
  if (source.kind === 'xtream' || !source.epgUrl) return true;
  try {
    return new URL(source.epgUrl).host === new URL(source.playlistUrl).host;
  } catch {
    return true;
  }
}

/** Whether two guide coverages hold the same channels (undefined: no guide configured, not "covers nothing"). */
function sameCoverage(a: Set<string> | undefined, b: Set<string> | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.size !== b.size) return false;
  for (const k of b) if (!a.has(k)) return false;
  return true;
}

/** Diagnostics fields for a source's catch-up: counts from the last ingest and how times are written. */
function catchupDiagnostics(s: SourceConfig, stats: { catchupChannels?: number; catchupUnsupported?: number } | undefined) {
  const out: { catchupChannels?: number; catchupUnsupported?: number; catchupTime?: string } = {};
  if (stats?.catchupChannels) out.catchupChannels = stats.catchupChannels;
  if (stats?.catchupUnsupported) out.catchupUnsupported = stats.catchupUnsupported;
  if (out.catchupChannels || out.catchupUnsupported) out.catchupTime = CatchupController.zoneText(s);
  return out;
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

/** How many channels' live audio choices a source remembers. */
export const LIVE_AUDIO_MAX = 200;
/** One remembered live audio choice: the channel and its track key (`<language>:<label>`), oldest first. */
interface LiveAudioEntry { id: string; key: string }
const liveAudioKey = (sourceId: string) => `liveAudio:${sourceId}`;

export const APP_API_METHODS = [
  'init', 'listSources', 'getSource', 'addSource', 'updateSource', 'deleteSource', 'setActiveSource', 'refresh',
  'retrySource', 'reportStreamRefused', 'reportStreamAnswered', 'networkOnline',
  'getGroups', 'getChannelSlice', 'indexOf', 'getPlayable', 'neighbour', 'byNumber', 'getEpgRows', 'search', 'searchChannels',
  'getSportsEvents', 'getMatchFilters', 'getMatchCompetitions', 'getEventChannels', 'getStartHome', 'getStartHomeCached', 'getCatchupPlayable', 'refineArchive', 'catchupDays', 'setCatchupOffset',
  'getLayout', 'getActiveLayout', 'applyLayoutOps', 'listLists', 'channelLists', 'hiddenGroups', 'providerGroups', 'getCompanionState', 'guideStatus',
  'getRegions', 'setRegions', 'getCountryChoices', 'setCountries', 'setDeviceCountry', 'setGroupVisibility', 'setGroupRegion', 'getVodRegions', 'applyVodLayoutOps',
  'toggleFavourite', 'toggleHidden', 'hiddenChannels', 'markWatched', 'liveSources', 'pickLiveSource', 'reportSourceFailed',
  'getVodHome', 'getVodCategories', 'getVodSlice', 'getMovie', 'getVersionLanguages', 'getSeries', 'getVodPlayable', 'pickVodVersion', 'setVodSplit',
  'saveVodProgress', 'setVodFavourite', 'setVodWatched', 'clearVodProgress', 'clearSeriesContinue', 'setVodTracks', 'loadSubtitle', 'loadSourceSubtitle', 'syncSubtitle', 'getSubtitle', 'clearSubtitle', 'onlineSubtitlesAvailable', 'findSubtitlesOnline', 'subtitleVersions', 'loadOnlineSubtitle', 'setSubtitleDelay', 'setSubtitleSpeed', 'refreshVod', 'preloadVod',
  'getLiveAudio', 'setLiveAudio',
  'getSettings', 'saveSettings', 'clearCache', 'diagnostics', 'focusChannel', 'notePlayed',
  'companionStart', 'companionStop', 'companionStatus',
  'backupToPhone', 'backupToFile', 'restoreFromFile', 'armPhoneRestore',
] as const satisfies readonly (keyof AppApi)[];

// Compile-time check: every public method except the test-only `idle` and the companion host's `restoreFromCompanion`
// (a phone restore must come through the paired channel, never from the UI port) is listed above.
const exhaustive: [Exclude<Exclude<keyof AppApi, 'idle' | 'restoreFromCompanion'>, (typeof APP_API_METHODS)[number]>] extends [never] ? true : never = true;
void exhaustive;

const trendPart = (items: StartTrendTile[], at: string | undefined): StartTrendPart => (at ? { items, at } : { items });


function sameRegions(a: RegionSettings, b: RegionSettings): boolean {
  return a.mode === b.mode && a.codes.join() === b.codes.join();
}
