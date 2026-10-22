import {
  ChannelIndex, DEFAULT_SETTINGS, FAV_LIST_ID, GROUP_FAV, GROUP_RECENT, MAX_OPS_PER_BATCH, QUALITY_LABELS, SubtitleError, alternateStreamUrl, applyOps,
  applyShift, emptyLayout, orderLiveSources, countryLabel, isSure, regionKeys,
  isVodLayoutOpBatch, sureRegionKeys, type ChannelRegionView, type RegionSettings, type RegionsRecord, type VodLayoutOp,
  compareAirings, epgKey, isLayoutOp, isLayoutOpBatch, languageChoices, mergeHeaders, nowNext, queryTitles, redactUrl, refreshFailKey, streamCooldownKey, streamKeySource,
  type AppSettings, type Channel, type GroupInfo, type IngestResult, type Layout, type LayoutOp, type NewSource, type Programme,
  type CooldownCause, type ProviderGroupInfo, type SeriesPointer, type SportsIndexRecord, type SourceConfig, type SourceCooldown, type SourceService, type Storage,
  type StreamHeaders, type TitleIndexData, type VodKind, type VodService, type VodSort,
  alignSubtitle, englishLanguageName, rankSubtitles, type SyncResult, type SyncSample, type SyncSetting, type LoadedSubtitle, type SourceSubtitle, type OnlineSubtitle, type OpenSubtitlesClient, type SubtitleInput, type SubtitleSearch, type SubtitleService,
  BACKUP_ENVELOPE_MAX_CHARS, BACKUP_FP_SCOPE, BackupError, BackupService, isBackupEnvelope,
  type BackupEnvelope, type RestoreSummary,
} from '@iptv/core';
import { CatchupController, playableState, type CatchupContext } from './catchupController.ts';
import { worseCooldown } from './cooldown.ts';
import { LiveSourceMemory, livePickKey } from './liveSources.ts';
import { toRpcError } from './rpc.ts';
import { ShortEpgCache, shortEpgUntil } from './shortEpgCache.ts';
import { maxShiftMs, shiftSpan, type ShiftSpan } from './shiftSpan.ts';
import {
  firstFormat, formatMemoKey, formatOf, isFormatMemo, isStreamFormat, type FormatMemo, type StreamFormat,
} from './streamFormat.ts';
import { SportsController, matchTiles, type MatchSettings, type MatchTiles } from './sportsController.ts';
import { assembleStartHome, START_CAPS, type StartParts, type StartTrendPart, type StartTrendTile } from './startHome.ts';
import { TrendingService } from './trending.ts';
import { VodController, type VodSearchHits } from './vodController.ts';
import type {
  CatchupNotAvailable, CatchupPlayable,
  AppEvent, ChannelRow, CompanionChannel, CompanionControl, CompanionStartResult, CompanionStatus, CompanionState, DiagnosticsInfo, InitState, LayoutOpsResult, LayoutOrigin,
  ListSummary, MovieView, LiveSourceView, PlayableChannel, ProgrammeHit, ProgrammeLite, SearchResult, SeriesView, SourceSummary, SportsEventTile, StartHome, TitleHit, MatchFilterChips, MatchCompetitionChips,
  OnlineSubtitleLanguage, SubtitleVersion, VodCategoryView, VodHome, VodPlayable, VodTile, VodTracks,
  GroupVisibility, RegionCount, RegionsOverview,
} from './types.ts';

/** A source subtitle file's display name: its label, else its language, then where it comes from. */
export function sourceSubtitleName(sub: SourceSubtitle): string {
  const what = sub.label?.trim() || englishLanguageName(sub.language) || 'Subtitles';
  return `${what} (from source)`;
}

const NOW_NEXT_TTL_MS = 60_000;
/**
 * Rows wait this long for their stored now/next, then go out without it (answered later as nowNextUpdated). A
 * healthy read takes a few ms even on a TV; this only trips while the guide store is locked by a long write.
 */
const NOW_NEXT_WAIT_MS = 400;
const ERROR_RING = 20;
const HOUR = 3_600_000;
/** Extra stored-guide margin around "now" when picking now/next, so long programmes are still found. */
const NOW_NEXT_MARGIN_MS = 6 * HOUR;
/** Programme search: channel hits kept when programmes match too, the on-now cap, titles asked of the index. */
const SEARCH_CHANNELS_WITH_PROGRAMMES = 10;
const SEARCH_ON_NOW = 20;
/** Most movies, and most series, one search returns. */
export const SEARCH_VOD_MAX = 20;
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

/** How long "Restore from your phone" waits for the phone (§6.5 S1). */
export const RESTORE_WAIT_MS = 5 * 60_000;

export class AppApi {
  private readonly service: SourceService;
  private readonly storage: Storage;
  private readonly emit: (e: AppEvent) => void;
  private readonly now: () => number;
  private readonly appVersion: string;

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
  private readonly sports: SportsController;
  private sportsRec: { sourceId: string; rec: SportsIndexRecord } | undefined;
  /** Bumped when the candidate-to-channel mapping can change (see SportsController.events). */
  private sportsMapping = 0;
  private readonly vodc: VodController | undefined;
  private readonly vod: VodService | undefined;
  private readonly subtitles: SubtitleService | undefined;
  private readonly onlineSubtitles: OpenSubtitlesClient | undefined;
  private readonly fileHash: ((url: string, headers?: StreamHeaders) => Promise<string | undefined>) | undefined;
  /** Movie hashes read this session, per stream URL, least recently used first; cleared on a source switch. */
  private readonly movieHashes = new Map<string, MovieHashEntry>();
  /** "Try another version" lists per title, language and frame rate, least recently used first; cleared on a source switch. */
  private readonly versionLists = new Map<string, Promise<SubtitleVersion[]>>();
  private readonly trending: TrendingService | undefined;
  private readonly catchup: CatchupController;
  private readonly backupIterations: number | undefined;
  private backupSvc: BackupService | undefined;
  /** Until when a restore sent from the phone is accepted (the user opened "Restore from your phone"). */
  private restoreUntil = 0;
  /**
   * The restore being applied now (under the index lock): who asked, and what it changed for the active source. Its
   * layout and VOD events are held back and sent once when it is done (`finishRestore`).
   */
  private restoring: RestoreRun | undefined;

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
    this.sports = new SportsController({ storage: deps.storage, now: this.now });
    this.appVersion = deps.appVersion ?? '0.0.0';
    this.liveMem = new LiveSourceMemory(deps.storage, this.now);
    this.companion = deps.companion?.(this, (status) => {
      // Why a session ended, for diagnostics (relay close reasons carry no secrets).
      if (status.state === 'expired' && status.reason) this.note('companion', `Phone session ended: ${status.reason}.`);
      deps.emit({ type: 'companion', status });
    });
    this.vod = deps.vod;
    this.backupIterations = deps.backupIterations;
    this.subtitles = deps.subtitles;
    this.onlineSubtitles = deps.onlineSubtitles;
    this.fileHash = deps.fileHash;
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
      await this.applyPendingBackup(source);
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
      this.titleRebuilds.delete(id);
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
        byChannel = await this.service.programmesFor(id, this.originals(channels), lo, hi);
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
      return this.sports.competitions(await this.sportsView(), category, st.pinnedCompetitions, st.hiddenCompetitions);
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
      return rows.sort((x, y) => compareAirings(
        { favourite: x.favourite, airingNow: (at.get(x.id)?.start ?? Infinity) <= now, name: x.name, number: x.number },
        { favourite: y.favourite, airingNow: (at.get(y.id)?.start ?? Infinity) <= now, name: y.name, number: y.number },
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
      const lastId = await this.storage.getMeta<string>(`lastChannel:${id}`).catch(() => undefined);
      const last = lastId ? this.index.get(lastId) : undefined;
      // On now fills from favourites, then recents; only the rows that can show are built (at most the cap in all).
      const favs = this.index.slice(GROUP_FAV, 0, START_CAPS.live);
      const taken = new Set(favs.map((c) => c.id));
      if (last) taken.add(last.id);
      const recents = this.index.slice(GROUP_RECENT, 0, START_CAPS.live)
        .filter((c) => !taken.has(c.id)).slice(0, Math.max(0, START_CAPS.live - taken.size));
      // The stored trending copies (a meta read; never waits on the network) before the VOD rows match against them.
      await safe(() => this.trending?.prime() ?? Promise.resolve(), undefined);
      const [lastRows, favourites, recentRows, sports, movie, series] = await Promise.all([
        safe(() => (last ? this.toRows([last]) : Promise.resolve([])), [] as ChannelRow[]),
        safe(() => this.toRows(favs), [] as ChannelRow[]),
        safe(() => this.toRows(recents), [] as ChannelRow[]),
        safe(() => this.matchTiles(), { row: [], all: [], total: 0, filtered: false } as MatchTiles),
        safe(() => this.vodc?.startRows('movie') ?? Promise.resolve(undefined), undefined),
        safe(() => this.vodc?.startRows('series') ?? Promise.resolve(undefined), undefined),
      ]);
      const parts: StartParts = { favourites, recents: recentRows, sports: sports.row, sportsTotal: sports.total };
      if (sports.filtered) parts.sportsFiltered = true;
      if (lastRows[0]) parts.lastChannel = lastRows[0];
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
      return { ...result, movies: vod.movies, series: vod.series, vodPending: vod.pending };
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

  private channelSearch(query: string, limit: number): Promise<Omit<SearchResult, 'movies' | 'series' | 'vodPending'>> {
    return (async () => {
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
        this.toRows([...onNow.map((h) => h.c), ...later.map((h) => h.c)]),
      ]);
      return {
        channels: channelRows,
        onNow: onNow.map((h, i): ProgrammeHit => ({ channel: progRows[i]!, title: h.title, start: h.start, stop: h.stop })),
        later: later.map((h, i): TitleHit => ({ channel: progRows[onNow.length + i]!, title: h.title, start: h.start, stop: h.stop, more: h.more })),
        guidePending: false,
      };
    })();
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
    return this.run('loadSubtitle', () => {
      const [svc, src] = this.subtitlesOrThrow();
      return svc.load(src, itemId, input);
    });
  }

  /**
   * Loads a subtitle file the source lists for the title (`VodPlayable.subtitles`), keeping its language. Its name
   * comes from its label or language, never from the link (which can carry the account's credentials).
   */
  loadSourceSubtitle(itemId: string, sub: SourceSubtitle): Promise<LoadedSubtitle> {
    return this.run('loadSourceSubtitle', () => {
      const [svc, src] = this.subtitlesOrThrow();
      const name = sourceSubtitleName(sub);
      return svc.load(src, itemId, { url: sub.url }, sub.language ? { language: sub.language, name } : { name });
    });
  }

  /**
   * Automatic sync: the delay and speed that line the title's loaded file up with what the player recorded of the
   * stream's own subtitles (`alignSubtitle`), or undefined when there is no clear improvement on `current`. Runs here,
   * off the UI thread. Changes nothing: the player applies a result like a user's own delay.
   */
  syncSubtitle(itemId: string, sample: SyncSample, current: SyncSetting): Promise<SyncResult | undefined> {
    return this.run('syncSubtitle', async () => {
      if (!this.subtitles || !this.activeId) return undefined;
      const loaded = await this.subtitles.get(this.activeId, itemId);
      return loaded ? alignSubtitle(loaded.cues, sample, current) : undefined;
    });
  }

  /** The subtitles loaded earlier for a title, if any. */
  getSubtitle(itemId: string): Promise<LoadedSubtitle | undefined> {
    return this.run('getSubtitle', async () => {
      if (!this.subtitles || !this.activeId) return undefined;
      return this.subtitles.get(this.activeId, itemId);
    });
  }

  clearSubtitle(itemId: string): Promise<void> {
    return this.run('clearSubtitle', () => {
      const [svc, src] = this.subtitlesOrThrow();
      return svc.clear(src, itemId);
    });
  }

  /** Whether "Find subtitles online" can be offered (an app key is configured). */
  onlineSubtitlesAvailable(): Promise<boolean> {
    return Promise.resolve(this.onlineSubtitles !== undefined && this.subtitles !== undefined);
  }

  /**
   * The languages this movie (or episode, with `seriesId`) has subtitles in online: one row per language, the
   * preferred language from Settings first, each with the file a click loads. `videoFps` (the playing video's frame
   * rate, when known) ranks the versions timed for it first.
   */
  findSubtitlesOnline(itemId: string, seriesId?: string, videoFps?: number): Promise<OnlineSubtitleLanguage[]> {
    return this.run('findSubtitlesOnline', async () => {
      const client = this.onlineOrThrow();
      const { query, preferred } = await this.subtitleQuery(itemId, seriesId);
      const found = await client.search(query);
      return languageChoices(found, preferred, videoFps).map((c) => ({
        language: c.language, count: c.count, fileId: c.best.fileId, files: c.files.map((f) => f.fileId), synced: c.synced,
        release: c.best.release, ...(c.best.fps ? { fps: c.best.fps } : {}), ...(c.cc ? { cc: true } : {}),
      }));
    });
  }

  /**
   * Every version of the title's subtitles in one language, best first (ranked with `videoFps`). At most two searches
   * (pages 1 and 2; page 2 only when page 1 says there is more), so the service's rate limit is respected.
   */
  subtitleVersions(itemId: string, language: string, seriesId?: string, videoFps?: number): Promise<SubtitleVersion[]> {
    return this.run('subtitleVersions', async () => {
      this.onlineOrThrow();
      const lang = language.trim();
      if (!lang) return [];
      // Kept for the session (a reopen of the title asks nothing); a failed search is not kept. With exact match on,
      // the list belongs to the file playing (a picked version under the same id is another file) and to the setting.
      const exact = this.exactMatchOn(await this.currentSettings());
      const file = exact ? (await this.vodOrThrow().playable(itemId, seriesId))?.url ?? '' : '';
      const key = JSON.stringify([itemId, seriesId ?? '', lang, videoFps ?? 0, exact, file]);
      let list = this.versionLists.get(key);
      if (list) this.versionLists.delete(key); // Re-inserted below: the most recently used is last.
      else list = this.searchVersions(itemId, lang, seriesId, videoFps);
      this.versionLists.set(key, list);
      if (this.versionLists.size > VERSION_LISTS_MAX) {
        const leastRecent = this.versionLists.keys().next().value;
        if (leastRecent !== undefined) this.versionLists.delete(leastRecent);
      }
      const kept = list;
      return kept.catch((err: unknown) => {
        if (this.versionLists.get(key) === kept) this.versionLists.delete(key);
        throw err;
      });
    });
  }

  /** The search behind `subtitleVersions`: pages 1 and 2 at most. */
  private async searchVersions(itemId: string, lang: string, seriesId: string | undefined, videoFps: number | undefined): Promise<SubtitleVersion[]> {
    const client = this.onlineOrThrow();
    const { query } = await this.subtitleQuery(itemId, seriesId);
    query.languages = [lang];
    const first = await client.searchPage(query);
    const more = first.totalPages !== undefined ? first.totalPages > 1 : first.subtitles.length >= SUBTITLE_SEARCH_PAGE_SIZE;
    const all: OnlineSubtitle[] = [...first.subtitles];
    if (more) all.push(...(await client.searchPage({ ...query, page: 2 })).subtitles);
    const seen = new Set<number>();
    const unique = all.filter((s) => (seen.has(s.fileId) ? false : (seen.add(s.fileId), true)));
    return rankSubtitles(unique, videoFps).map((s) => ({
      fileId: s.fileId, release: s.release, ...(s.fps ? { fps: s.fps } : {}), synced: s.hashMatch, downloads: s.downloads,
      ...(s.hearingImpaired ? { hearingImpaired: true } : {}),
    }));
  }

  /**
   * Exact match reads 128 KB of the playing file: a second request while the title streams. An account limited to one
   * connection may refuse it (or count it against the user), so there it is never read, whatever the setting says.
   */
  private exactMatchOn(settings: AppSettings): boolean {
    return settings.subtitleExactMatch && this.fileHash !== undefined && this.sourceMaxConnections !== 1;
  }

  /** The search for a title, with the stream file's hash when exact match is on (`movieHash`). */
  private async subtitleQuery(itemId: string, seriesId?: string): Promise<{ query: SubtitleSearch; preferred: string }> {
    const vod = this.vodOrThrow();
    const query = await vod.subtitleSearch(itemId, seriesId);
    if (!query) throw new SubtitleError("This title can't be found right now.");
    const settings = await this.currentSettings();
    // Exact match: the stream file's hash marks the versions timed for it (a failed read just leaves it out).
    if (this.exactMatchOn(settings)) {
      const playable = await vod.playable(itemId, seriesId);
      // As `getVodPlayable`: the playlist entry's headers win over the source's settings.
      const hash = playable?.url ? await this.movieHash(playable.url, mergeHeaders(this.sourceHeaders, playable.headers)) : undefined;
      if (hash) query.moviehash = hash;
    }
    return { query, preferred: settings.subtitleLanguage };
  }

  /**
   * The hash of the file at `url`, read once per file (keyed by its URL: a picked version under the same id is another
   * file). A failed read is kept for MOVIE_HASH_RETRY_MS so a refusing server is not asked again at every search.
   */
  private async movieHash(url: string, headers: StreamHeaders | undefined): Promise<string | undefined> {
    const fileHash = this.fileHash;
    if (!fileHash) return undefined;
    let entry = this.movieHashes.get(url);
    if (entry) {
      this.movieHashes.delete(url); // Re-inserted below: the most recently used is last.
      if (entry.failedAt !== undefined && this.now() - entry.failedAt >= MOVIE_HASH_RETRY_MS) entry = undefined;
    }
    if (!entry) {
      const fresh: MovieHashEntry = { hash: Promise.resolve(undefined) };
      fresh.hash = fileHash(url, headers).catch(() => undefined).then((h) => {
        if (!h) fresh.failedAt = this.now();
        return h;
      });
      entry = fresh;
    }
    this.movieHashes.set(url, entry);
    if (this.movieHashes.size > MOVIE_HASH_CACHE_MAX) {
      const leastRecent = this.movieHashes.keys().next().value;
      if (leastRecent !== undefined) this.movieHashes.delete(leastRecent);
    }
    return entry.hash;
  }

  /** How much later (positive) or earlier the title's loaded subtitles show; kept with that file. */
  setSubtitleDelay(itemId: string, delayMs: number): Promise<void> {
    return this.run('setSubtitleDelay', () => {
      const [svc, src] = this.subtitlesOrThrow();
      return svc.setDelay(src, itemId, delayMs);
    });
  }

  /** How fast the title's loaded subtitles run against the video (a frame-rate fix); kept with that file. */
  setSubtitleSpeed(itemId: string, speed: number): Promise<void> {
    return this.run('setSubtitleSpeed', () => {
      const [svc, src] = this.subtitlesOrThrow();
      return svc.setSpeed(src, itemId, speed);
    });
  }

  /**
   * Downloads one file found online and keeps it for the title, like a loaded file, under `name` ("Swedish"). With
   * `details`, its language (so its other versions can be listed later) and the frame rate it was timed for.
   */
  loadOnlineSubtitle(itemId: string, fileId: number, name: string, details?: { language?: string; fps?: number; cc?: boolean }): Promise<LoadedSubtitle> {
    return this.run('loadOnlineSubtitle', async () => {
      const client = this.onlineOrThrow();
      const [svc, src] = this.subtitlesOrThrow();
      const file = await client.download(fileId);
      return svc.load(src, itemId, { bytes: file.bytes, name }, details && { ...details, fileId });
    });
  }

  private onlineOrThrow(): OpenSubtitlesClient {
    if (!this.onlineSubtitles) throw new Error('Online subtitles are not available.');
    return this.onlineSubtitles;
  }

  private subtitlesOrThrow(): [SubtitleService, string] {
    if (!this.subtitles) throw new Error('Loading subtitles is not available.');
    if (!this.activeId) throw new Error('Add a source first.');
    return [this.subtitles, this.activeId];
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
    const reregion = !sameRegions(before.regions, this.settings.regions);
    if (opts.locked && (refold || reregion)) {
      this.setIndex(this.channels, this.index.layout(), this.coverage);
      this.invalidateNowNext();
      if (this.restoring) this.restoring.layout = true;
      else this.emit({ type: 'layoutChanged', version: this.index.layout().version, origin: 'local' });
    } else if (refold) await this.refold();
    else if (reregion) await this.reregion();
    const regroup = before.combineDuplicates !== this.settings.combineDuplicates
      || before.combineCategories !== this.settings.combineCategories || !sameRegions(before.regions, this.settings.regions);
    if (regroup || before.preferredLanguages.join() !== this.settings.preferredLanguages.join()) this.vodc?.settingsChanged(regroup);
    return this.settings;
  }

  // ---- backup and restore (sync phase S1) ----

  /**
   * Makes an encrypted backup and sends it to the connected phone, which keeps it. Resolves with the recovery code
   * (shown once, never stored) after the phone said it saved the backup.
   */
  backupToPhone(): Promise<{ code: string; records: number }> {
    return this.run('backupToPhone', async () => {
      const companion = this.companion;
      if (!companion?.sendBackup || companion.status().state !== 'connected') {
        throw Object.assign(new Error('Connect your phone first: Settings → Manage on phone.'), { name: 'NoCompanion' });
      }
      const made = await this.backups().create();
      await companion.sendBackup(made.envelope);
      return { code: made.code, records: made.records };
    });
  }

  /** Makes an encrypted backup as a file's text (off TVs: the UI saves it). */
  backupToFile(): Promise<{ code: string; data: string; fileName: string; records: number }> {
    return this.run('backupToFile', async () => {
      const made = await this.backups().create();
      const day = new Date(made.envelope.at).toISOString().slice(0, 10);
      return { code: made.code, data: JSON.stringify(made.envelope), fileName: `tv-backup-${day}.json`, records: made.records };
    });
  }

  /** Restores a backup file's text with its recovery code. */
  restoreFromFile(data: string, code: string): Promise<RestoreSummary> {
    return this.run('restoreFromFile', async () => {
      let envelope: unknown;
      try {
        envelope = typeof data === 'string' && data.length <= BACKUP_ENVELOPE_MAX_CHARS + 4096 ? JSON.parse(data) : undefined;
      } catch {
        envelope = undefined;
      }
      if (!isBackupEnvelope(envelope)) throw new BackupError('invalid', 'This file is not a backup from this app.');
      return this.restoreBackup(envelope, code, 'local');
    });
  }

  /** "Restore from your phone": the TV accepts one restore from the phone for RESTORE_WAIT_MS (or stops waiting). */
  armPhoneRestore(on: boolean): Promise<{ until: number | undefined }> {
    return this.run('armPhoneRestore', async () => {
      this.restoreUntil = on ? this.now() + RESTORE_WAIT_MS : 0;
      return { until: on ? this.restoreUntil : undefined };
    });
  }

  /**
   * A restore sent by the paired phone (companion host only; not exposed to the UI). Accepted only while the TV waits
   * for it (`armPhoneRestore`); a success ends the wait, a wrong code keeps it so the user can try again.
   */
  restoreFromCompanion(envelope: BackupEnvelope, code: string): Promise<RestoreSummary> {
    return this.run('restoreFromCompanion', async () => {
      if (this.now() >= this.restoreUntil) {
        throw Object.assign(new Error('On the TV, open Settings → Storage → Restore from your phone first.'), { name: 'NotReady' });
      }
      const res = await this.restoreBackup(envelope, code, 'remote');
      this.restoreUntil = 0;
      return res;
    });
  }

  private backups(): BackupService {
    const vod = this.vod;
    this.backupSvc ??= new BackupService({
      storage: this.storage, clock: this.service.syncClock, now: this.now, iterations: this.backupIterations,
      vod: vod && {
        getVodPicks: (id, kind) => vod.getVodPicks(id, kind),
        getVodSplits: (id, kind) => vod.getVodSplits(id, kind),
        getVodLayout: (id, kind) => vod.getVodLayout(id, kind),
        applyRestore: async (id, plan) => {
          await vod.applyRestore(id, plan);
          // Noted for the active source only: another source's VOD state is read when it becomes active.
          const run = this.restoring;
          if (!run || id !== this.activeId) return;
          if (plan.vod.length) run.vodUser = true;
          if (plan.picks.length || plan.splits.length || plan.vodLayout?.length) run.vodGrouping = true;
        },
      },
      loadLayout: (id) => (id === this.activeId ? Promise.resolve(this.index.layout()) : this.service.loadLayout(id)),
      applyLayout: (id, ops) => this.applyRestoredLayout(id, ops),
      getSettings: () => this.currentSettings(),
      saveSettings: (patch) => this.applySettings(patch, { stamp: false, locked: true }),
    });
    return this.backupSvc;
  }

  /**
   * Opens the backup first, outside the index lock: the PBKDF2 derivation is the slow step on a TV and touches no
   * state, so channel calls never queue behind it. Only the merge runs under the lock (the active source's layout
   * changes through its index). Then refreshes exactly what changed and tells the UI.
   */
  private async restoreBackup(envelope: unknown, code: string, origin: LayoutOrigin): Promise<RestoreSummary> {
    const opened = await this.backups().open(envelope, code);
    const run = newRestoreRun(origin);
    const res = await this.withIndex(() => this.restoringAs(run, () => this.backups().apply(opened)))
      .finally(() => this.finishRestore(run));
    this.emit({ type: 'backupRestored', origin, applied: res.applied, pending: res.pending, sources: res.sources, at: res.at });
    return res;
  }

  /** Applies what a restored backup kept for `source` (just added). Never fails the add. */
  private async applyPendingBackup(source: SourceConfig): Promise<void> {
    try {
      if (!(await this.storage.listSyncMeta(BACKUP_FP_SCOPE)).length) return;
      const run = newRestoreRun('local');
      await this.withIndex(() => this.restoringAs(run, () => this.backups().applyPending(source)))
        .finally(() => this.finishRestore(run));
    } catch (err) {
      this.record('applyPendingBackup', err);
    }
  }

  /** Runs a restore's merge with `run` noting what it changes. Caller holds the index lock. */
  private async restoringAs<T>(run: RestoreRun, fn: () => Promise<T>): Promise<T> {
    this.restoring = run;
    try {
      return await fn();
    } finally {
      this.restoring = undefined;
    }
  }

  /**
   * After a restore (a failed one too, for what it applied), the screens re-read exactly what changed: one
   * `layoutChanged` marked `restored` (no toast of its own) when the active layout or its index changed, and the VOD
   * user map or category config is read again (`vodRefreshed`). Restored settings went through `applySettings`.
   */
  private finishRestore(run: RestoreRun): void {
    if (run.layout) {
      this.emit({
        type: 'layoutChanged', version: this.index.layout().version, origin: run.origin === 'remote' ? 'remote' : 'local', restored: true,
      });
    }
    const id = this.activeId;
    if (id && (run.vodUser || run.vodGrouping)) this.vodc?.restored(id, { user: run.vodUser, grouping: run.vodGrouping });
  }

  /** Restored layout ops: the active source through its index (caller holds the index lock), others in storage. */
  private async applyRestoredLayout(id: string, ops: LayoutOp[]): Promise<void> {
    if (id !== this.activeId) {
      await this.service.updateLayout(id, (l) => {
        const r = applyOps(l, ops);
        return r.changed ? r.layout : undefined;
      });
      return;
    }
    const before = this.index.layout();
    const res = applyOps(before, ops);
    if (res.changed) await this.commitLayoutLocked(id, before, res.layout, [], this.restoring?.origin ?? 'local');
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
          ...catchupDiagnostics(s, stats),
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
    while (this.queues.size || this.shortJobs.size || this.titleJobs.size || this.regionJobs.size) {
      await Promise.all([...this.queues.values(), ...this.shortJobs, ...this.titleJobs, ...this.regionJobs]);
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
    this.movieHashes.clear();
    this.versionLists.clear();
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
    const s = (this.settings ?? DEFAULT_SETTINGS).regions;
    const key = `${s.mode}|${s.codes.join(',')}`;
    if (this.regionView?.rec === r.rec && this.regionView.key === key) return this.regionView.view;
    const view: ChannelRegionView = { detected: r.rec.groups, codes: [...s.codes], mode: s.mode };
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
    this.shifts = shiftSpan(channels);
    this.coverage = coverage;
    const fold = (this.settings ?? DEFAULT_SETTINGS).combineChannels;
    const regions = this.regionViewFor();
    this.index = new ChannelIndex(channels, layout, coverage, regions ? { fold, regions } : { fold });
    this.favSet = undefined;
    this.companionStale();
    this.titles = undefined;
    this.titlesEpoch++;
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
    if (this.restoring) {
      this.restoring.layout = true;
      return;
    }
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
  }

  private async matchTiles(): Promise<MatchTiles> {
    const view = await this.sportsView();
    const st = await this.currentSettings();
    const s: MatchSettings = {
      followed: st.followedTeams, pinned: st.pinnedCompetitions, hidden: st.hiddenCompetitions, categories: st.matchCategories,
    };
    // G8: a small match still shows in the row when it airs on a channel of a chosen country (Your countries on).
    if (st.regions.mode !== 'off' && st.regions.codes.length) s.countries = st.regions.codes;
    return matchTiles(view, this.now(), s, this.sports.aliases());
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
    const maxShift = maxShiftMs(this.shifts, settings.epgOffsetHours);
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
    if (error.name === 'SourceNetworkError' && error.status === undefined) {
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
    try {
      await this.service.refreshEpg(id, (p) => this.emit({ type: 'progress', ...p }), { automatic });
    } catch (err) {
      this.failed('epg', id, 'refreshEpg', err);
    }
    await this.reloadCoverage(id);
    this.dropSports();
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
    let playlist: boolean;
    try {
      // An empty channel cache means "not loaded yet" (or lost), unless the source only has movies and series: then
      // the normal staleness rule applies, so a VOD-only playlist is not downloaded again on every cold start.
      // A failed automatic refresh holds the next one off (15 min, 1 h, 6 h) even with an empty cache; a manual
      // refresh (`refresh`) is never held off.
      playlist = (this.activeId === id && this.totalChannels() === 0 && await this.expectsChannels(id)
        && !(await this.service.refreshBackedOff(id, 'playlist')))
        || await this.service.needsPlaylistRefresh(id);
    } catch (err) {
      this.failed('playlist', id, 'backgroundRefresh', err);
    }
    if (playlist) await this.refreshPlaylistFor(id, true);
    let epg: boolean;
    try {
      epg = await this.service.needsEpgRefresh(id);
    } catch (err) {
      this.failed('epg', id, 'backgroundRefresh', err);
    }
    if (epg) await this.refreshEpgFor(id, true);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = Symbol('late');
    const first = await Promise.race([
      lookup,
      new Promise<typeof late>((resolve) => { timer = setTimeout(() => resolve(late), this.nowNextWaitMs); }),
    ]).finally(() => clearTimeout(timer));
    if (first !== late) {
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
/**
 * The subtitle search's page size, used only when an answer leaves out `total_pages`: a page this full may have a
 * next one. (OpenSubtitles REST v1 answers 50 per page by default.)
 */
export const SUBTITLE_SEARCH_PAGE_SIZE = 50;
/** How many files' movie hashes the session remembers (the least recently used dropped first). */
const MOVIE_HASH_CACHE_MAX = 50;
/** How many "Try another version" lists are kept for the session. */
const VERSION_LISTS_MAX = 30;
/** How long a failed movie-hash read is remembered before the file is asked again. */
export const MOVIE_HASH_RETRY_MS = 10 * 60_000;
/** A movie-hash read: the hash (undefined when it failed) and, once it failed, when. */
interface MovieHashEntry { hash: Promise<string | undefined>; failedAt?: number }
/** One remembered live audio choice: the channel and its track key (`<language>:<label>`), oldest first. */
interface LiveAudioEntry { id: string; key: string }
const liveAudioKey = (sourceId: string) => `liveAudio:${sourceId}`;

export const APP_API_METHODS = [
  'init', 'listSources', 'getSource', 'addSource', 'updateSource', 'deleteSource', 'setActiveSource', 'refresh',
  'retrySource', 'reportStreamRefused', 'reportStreamAnswered', 'networkOnline',
  'getGroups', 'getChannelSlice', 'indexOf', 'getPlayable', 'neighbour', 'byNumber', 'getEpgRows', 'search',
  'getSportsEvents', 'getMatchFilters', 'getMatchCompetitions', 'getEventChannels', 'getStartHome', 'getStartHomeCached', 'getCatchupPlayable', 'refineArchive', 'catchupDays', 'setCatchupOffset',
  'getLayout', 'getActiveLayout', 'applyLayoutOps', 'listLists', 'channelLists', 'hiddenGroups', 'providerGroups', 'getCompanionState', 'guideStatus',
  'getRegions', 'setRegions', 'setGroupVisibility', 'setGroupRegion', 'getVodRegions', 'applyVodLayoutOps',
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

/** What a restore changed for the active source, so `finishRestore` refreshes exactly that. */
interface RestoreRun { origin: LayoutOrigin; layout: boolean; vodUser: boolean; vodGrouping: boolean }
const newRestoreRun = (origin: LayoutOrigin): RestoreRun => ({ origin, layout: false, vodUser: false, vodGrouping: false });

function sameRegions(a: RegionSettings, b: RegionSettings): boolean {
  return a.mode === b.mode && a.codes.join() === b.codes.join();
}
