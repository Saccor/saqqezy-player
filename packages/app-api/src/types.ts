import type { AppSettings, GroupInfo, MovieDetail, SeriesDetail, SeriesPointer, SourceCooldown, StreamHeaders, VodKind } from '@iptv/core';

export type { SourceCooldown, StreamHeaders };
import type { CompanionChannel, CompanionSourceSummary, CompanionState } from '@iptv/companion-protocol';
import type { RpcError } from './rpc.ts';

export interface ProgrammeLite { title: string; start: number; stop: number; desc?: string }

export interface ChannelRow {
  id: string; number: number; name: string; logo?: string; group: string;
  favourite: boolean;
  /** Now/next from the stored guide or a cached short-EPG answer. Absent from `getEpgRows` rows (lite: the Guide draws its own programmes). */
  now?: ProgrammeLite; next?: ProgrammeLite;
}

export interface PlayableChannel extends ChannelRow {
  url: string;
  alternateUrl?: string;
  /** Request headers for the stream: the channel's own (from the playlist) win over the source's settings. Never log. */
  headers?: StreamHeaders;
  /** The key of this stream's refusal cooldown (source and host): matches a `cooldown` event's `streamKey`. */
  cooldownKey?: string;
  /** This stream's host cooldown when the answer was made, if it was not clear (the source's is in `InitState`). */
  cooldown?: SourceCooldown;
}

export interface SourceSummary { id: string; name: string; kind: 'xtream' | 'm3u'; active: boolean }

// Compile-time drift check: SourceSummary and the companion protocol's copy must stay mutually assignable.
type Assert<T extends true> = T;
export type _SourceSummaryInSync = Assert<
  [SourceSummary] extends [CompanionSourceSummary] ? ([CompanionSourceSummary] extends [SourceSummary] ? true : false) : false
>;

export interface InitState {
  sources: SourceSummary[]; activeSourceId?: string; groups: GroupInfo[];
  lastChannelId?: string; lastGroupId?: string; settings: AppSettings;
  /** The active source's cooldown, refused or unreachable (with an active source only). */
  cooldown?: SourceCooldown;
  /** The active source has movies or series (from its last ingest or a fetched catalogue); false without one. */
  hasVod: boolean;
}

/** A programme airing now that matched a search (times on the displayed, shifted timeline). */
export interface ProgrammeHit { channel: ChannelRow; title: string; start: number; stop: number }
/** A title airing later: its next airing, plus how many more upcoming airings exist across channels. */
export interface TitleHit { title: string; channel: ChannelRow; start: number; stop: number; more: number }
export interface SearchResult {
  channels: ChannelRow[];
  onNow: ProgrammeHit[];
  later: TitleHit[];
  /** The guide's title index is being built or loaded: programme sections are empty for now. */
  guidePending: boolean;
  /** Matching movies and series of the active source (from catalogues stored on the device), at most 20 each. */
  movies: VodTile[];
  series: VodTile[];
  /** The movie or series title index is being built: those sections fill in after `searchReady`. */
  vodPending: boolean;
}

export type AppEvent =
  | { type: 'progress'; phase: 'playlist' | 'epg'; count: number }
  | { type: 'refreshed'; what: 'playlist' | 'epg'; sourceId: string }
  | { type: 'refreshFailed'; what: 'playlist' | 'epg'; sourceId: string; error: RpcError }
  | { type: 'offline'; value: boolean }
  /**
   * A cooldown changed (a refusal, the unreachable breaker, an answer, a retry, or the end of a wait). Without
   * `streamKey` it is the source's own (API, playlist, EPG, and every stream); with it, only the streams on one host
   * (`PlayableChannel.cooldownKey`).
   */
  | { type: 'cooldown'; sourceId: string; streamKey?: string; cooldown: SourceCooldown }
  /** Background short-EPG answers changed the now/next of these channels: re-read their rows. */
  | { type: 'nowNextUpdated'; channelIds: string[] }
  /** A search index of `sourceId` (guide titles, or movie and series titles) became ready: re-run an open search. */
  | { type: 'searchReady'; sourceId: string }
  /** The active source's layout changed (version is the new `Layout.version`); `origin` says who changed it. */
  /** `recentOnly`: the batch changed nothing but "recently watched" (a zap); the companion is not told. */
  | { type: 'layoutChanged'; version: number; origin: LayoutOrigin; recentOnly?: boolean }
  /**
   * The active source or the source list changed (added, edited, deleted, switched). `activeSourceId` is the active
   * source afterwards (absent without sources); `origin` says who asked: this device's UI or a paired companion.
   */
  | { type: 'sourcesChanged'; activeSourceId?: string; origin: LayoutOrigin }
  /** The phone companion session changed state. */
  | { type: 'companion'; status: CompanionStatus }
  /** A catalogue fetch started for the active source (first open or a stale refresh). */
  | { type: 'vodLoading'; sourceId: string; kind: VodKind }
  /** A first load got further: the VOD screen can show the titles so far (`count`). Throttled in the worker. */
  | { type: 'vodProgress'; sourceId: string; kind: VodKind; count: number }
  /** A catalogue fetch finished and was stored: re-read the VOD screen. */
  | { type: 'vodRefreshed'; sourceId: string; kind: VodKind; count: number; truncated: boolean }
  /** A catalogue fetch failed (the error is credential-free). Automatic fetching of this kind stops until `refreshVod`. */
  | { type: 'vodRefreshFailed'; sourceId: string; kind: VodKind; error: RpcError };

/** Why a session ended (with state `expired`). Built from relay close reasons and local causes; never secret. */
export type CompanionEndReason = 'expired' | 'replaced' | 'rate-limit' | 'quota' | 'unreachable' | 'peer-errors' | 'stopped';

/**
 * The TV side of a companion pairing session. `expired` covers every session end that was not `stop()`.
 * `waiting` also covers a paired session whose companion went quiet (no message for 75 s); it continues.
 */
export interface CompanionStatus {
  state: 'idle' | 'waiting' | 'connected' | 'reconnecting' | 'expired';
  /** The paired companion's own label (from its last hello). */
  peerLabel?: string;
  expiresAt?: number;
  /** With state `expired`: why the session ended. */
  reason?: CompanionEndReason;
}

/** What the pairing screen shows. Both values are secrets: render them, never log or persist them. */
export interface CompanionStartResult { qrUrl?: string; code?: string; expiresAt: number }

/** What AppApi needs from the companion host (implemented by CompanionHost). */
export interface CompanionControl {
  start(mode: 'qr' | 'code'): Promise<CompanionStartResult>;
  stop(): void;
  status(): CompanionStatus;
  /** Every AppApi event, so the host can forward layout changes and progress. Must not throw. */
  handleEvent(e: AppEvent): void;
  /** The companion state's channels, guide coverage or sources changed (no AppEvent says so). Must not throw. */
  stateChanged?(): void;
}

/** Who applied a layout change: this device's UI, or a paired companion. */
export type LayoutOrigin = 'local' | 'remote';

export interface LayoutOpsResult {
  /** The layout version after the batch (unchanged when nothing changed). */
  version: number;
  /** Ops that were not applied, by their index in the batch. */
  rejected: { index: number; reason: string }[];
}

/** A user list (Favourites included) with its browsable group id and visible channel count. */
export interface ListSummary { id: string; groupId: string; name: string; count: number }

/** Defined in @iptv/companion-protocol (app-api depends on it); re-exported here for compatibility. */
export type { CompanionChannel, CompanionState };

export interface DiagnosticsInfo {
  appVersion: string;
  sources: { id: string; name: string; kind: string; channels: number; skipped: number; playlistAt: number; epgAt: number }[];
  /** Messages are already credential-free. */
  lastErrors: { at: number; where: string; message: string }[];
  settings: AppSettings;
}

/** One poster in a row or grid. */
export interface VodTile {
  id: string;
  kind: VodKind;
  title: string;
  categoryId: string;
  poster?: string;
  year?: number;
  rating?: number;
  watched: boolean;
  favourite: boolean;
  /** 0–1 when in progress. */
  progress?: number;
  /** Series in Continue watching: "S2 · E4". */
  badge?: string;
  /** Versions of this title (language and quality), when more than one. */
  versions?: number;
  /** Best quality among the versions ("4K", "FHD", "HD", "SD"), when known. */
  quality?: string;
}

/** One version of a title in the Versions list. The TV names it ("Swedish · 4K"). */
export interface VersionView {
  /** The movie or series item id to play or show. */
  id: string;
  /** ISO 639-1, when detected. */
  lang?: string;
  /** "4K", "FHD", "HD", "SD", when known. */
  quality?: string;
  /** Extra labels ("HDR", "MULTI", …). */
  tags: string[];
  /** What Play picks on its own. */
  auto: boolean;
}

/** A home row. `items` is empty past the first rows: fetch them with `getVodSlice(kind, id, …)`. */
export interface VodRow { id: string; title: string; total: number; items: VodTile[] }

export interface VodHome {
  status: 'ready' | 'loading' | 'empty' | 'error';
  rows: VodRow[];
  /** The source has more titles than the app keeps (the 200,000 cap). */
  truncated: boolean;
  /** With status `error`. */
  error?: RpcError;
  /** A first load is still running: the rows hold this many titles so far. */
  progress?: number;
  /** Some categories could not be fetched. */
  partial?: boolean;
}

/** A grid rail entry: pseudo-categories first, then the source's categories. */
export interface VodCategoryView { id: string; name: string; count: number }

export interface VodTracks { audio?: string; subtitle?: string }

/** One language a title has subtitles in online: how many files, and the file a click loads. */
export interface OnlineSubtitleLanguage {
  /** ISO 639-1, sometimes with a region ("pt-BR"). */
  language: string;
  count: number;
  /** The file a click loads: the best version. */
  fileId: number;
  /** Every version, best first ("Try another version" walks them). */
  files: number[];
  /** The best version was made for the exact file playing (exact match on, its hash matched). */
  synced: boolean;
}

export interface MovieView {
  tile: VodTile;
  /** `null` when the detail could not be loaded (the list fields still show, Play still works). */
  detail: MovieDetail | null;
  resumeMs: number;
  tracks: VodTracks;
  /** "More in <category>", without this movie. */
  more: VodTile[];
  /** Every version, Play's pick first; empty when the title has one. */
  versions: VersionView[];
  /** The version Play plays (its detail, resume and tracks are the ones above). */
  playId: string;
  /** Shown separately by the user ("Combine again" undoes it). */
  split?: boolean;
}

export interface EpisodeView {
  id: string;
  season: number;
  episode: number;
  title: string;
  plot?: string;
  runtimeMin?: number;
  still?: string;
  watched: boolean;
  progress?: number;
}

export interface SeasonView { number: number; name: string; episodes: EpisodeView[] }

/** What the series detail's primary button plays. */
export interface SeriesPrimary { episodeId: string; season: number; episode: number; resumeMs: number; mode: 'continue' | 'start' }

export interface SeriesView {
  tile: VodTile;
  detail: Omit<SeriesDetail, 'seasons'> | null;
  seasons: SeasonView[];
  primary?: SeriesPrimary;
  /** Every version, the shown one first when it is the automatic pick; empty when the series has one. */
  versions: VersionView[];
  /** The version whose seasons are shown: pass it as `seriesId` when playing its episodes. */
  versionId: string;
  /** Shown separately by the user ("Combine again" undoes it). */
  split?: boolean;
}

export interface VodPlayable {
  kind: 'movie' | 'episode';
  itemId: string;
  /** Carries credentials: never display or log it. */
  url: string;
  title: string;
  /** Episodes: "S2 · E4 · Episode title". */
  episodeLabel?: string;
  resumeMs: number;
  durationMs?: number;
  tracks: VodTracks;
  /** Episodes: pass back with every `saveVodProgress` / `setVodWatched`. */
  series?: SeriesPointer;
  /** Episodes: what the next-episode card offers. */
  next?: { id: string; label: string };
  /** Episodes: the previous episode (Channel down). */
  prev?: { id: string; label: string };
  /** The source's User-Agent and Referer settings, when set. Never log. */
  headers?: StreamHeaders;
  /** As `PlayableChannel.cooldownKey`. */
  cooldownKey?: string;
  /** As `PlayableChannel.cooldown`. */
  cooldown?: SourceCooldown;
}

export interface SportsEventTile {
  key: string; title: string; sides?: [string, string]; subTitle?: string; icon?: string;
  start: number; stop: number; channelCount: number; followed: boolean;
}

export type StartRowId = 'continue' | 'live' | 'sports' | 'newMovies' | 'newSeries' | 'topMovies' | 'topSeries';
export type StartCell =
  | { type: 'vod'; tile: VodTile }
  | { type: 'channel'; channel: ChannelRow; last?: true }
  | { type: 'event'; event: SportsEventTile }
  /** `order: 'rating'`: the whole kind best rated first (Top rated); otherwise that kind's Recently added. */
  | { type: 'viewAll'; target: 'sports' | 'movie' | 'series'; total: number; order?: 'rating' };
export interface StartRow { id: StartRowId; title: string; cells: StartCell[] }
export interface StartHome { rows: StartRow[]; at: number }
