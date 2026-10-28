import type { AppSettings, ArchiveState, BackupEnvelope, RegionMode, RegionSettings, CatchupMode, GroupInfo, MovieDetail, SeriesDetail, SeriesPointer, SourceCooldown, SourceSubtitle, StreamHeaders, VideoRange, VodKind } from '@iptv/core';

export type { ArchiveState, SourceCooldown, SourceSubtitle, StreamHeaders, VideoRange };
import type { CompanionChannel, CompanionSourceSummary, CompanionState } from '@iptv/companion-protocol';
import type { RpcError } from './rpc.ts';

export interface ProgrammeLite {
  title: string; start: number; stop: number; desc?: string;
  /** The source's own archive answer for this programme (Xtream `has_archive`), when its row was refined. */
  archive?: boolean;
}

export interface ChannelRow {
  id: string; number: number; name: string; logo?: string; group: string;
  favourite: boolean;
  /** Now/next from the stored guide or a cached short-EPG answer. Absent from `getEpgRows` rows (lite: the Guide draws its own programmes). */
  now?: ProgrammeLite; next?: ProgrammeLite;
  /** Archive days when the channel has catch-up; the UI computes marks with `archiveState`. */
  archiveDays?: number;
  /** A combined channel (Settings → Combine duplicate channels): how many streams it has, set when more than one. */
  sourceCount?: number;
  /** A combined channel: the best quality among its streams ("4K", "FHD", "HD", "SD"), when known. */
  quality?: string;
}

/** One stream of a combined channel, for Choose source and failover. */
export interface LiveSourceView {
  /** The stream's channel id (play it with `getPlayable(id, { exact: true })`). */
  id: string;
  /** Its own name, plus its group when two streams share a name. */
  label: string;
  quality?: string;
  /** Failed to play in the last few minutes, or its host is waiting after a refusal: tried last. */
  bad: boolean;
  /** Its host is waiting after a refusal or while unreachable: never tried automatically. */
  blocked: boolean;
}

/** A past programme (or the current one from its start) from the source's archive (spec 2026-10-20-catch-up §3.4). */
export interface CatchupPlayable {
  kind: 'catchup';
  /** The URL form, for the playback journal only. */
  mode?: CatchupMode;
  channelId: string;
  channelName: string;
  title: string;
  /** Displayed programme times. */
  start: number; stop: number;
  /** Where in the programme this URL starts (ms from `start`); 0 unless re-opened by a seek. */
  openedAtMs: number;
  /** Carries credentials: never display or log it. */
  url: string;
  alternateUrl?: string;
  headers?: StreamHeaders;
  cooldownKey?: string;
  cooldown?: SourceCooldown;
  /** The smallest start step the URL form can express: 60 000 for xc and minute formats, 1 000 otherwise. */
  stepMs: number;
  /** The next programme on this channel, when it is also `available` (for the end card). */
  next?: { start: number; stop: number; title: string };
}

/** Why `getCatchupPlayable` opened nothing. */
export interface CatchupNotAvailable { notAvailable: ArchiveState }

export interface PlayableChannel extends ChannelRow {
  url: string;
  alternateUrl?: string;
  /** Request headers for the stream: the channel's own (from the playlist) win over the source's settings. Never log. */
  headers?: StreamHeaders;
  /** The key of this stream's refusal cooldown (source and host): matches a `cooldown` event's `streamKey`. */
  cooldownKey?: string;
  /** This stream's host cooldown when the answer was made, if it was not clear (the source's is in `InitState`). */
  cooldown?: SourceCooldown;
  /**
   * A combined channel: the row's id (favourites, focus, zapping), while `id` is the stream that plays. Name and
   * number are the row's. Unset for a channel with one stream.
   */
  rowId?: string;
  /** A combined channel: its streams best first, [0] the one this answer plays (or the one asked for exactly). */
  sources?: LiveSourceView[];
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
/** A folder matching a search: a channel folder (the user's list or a provider group) or a movie or series category. */
export interface FolderHit { kind: 'live' | 'movie' | 'series'; id: string; name: string; count: number }
export interface SearchResult {
  /** The best matching channels, at most the asked limit. */
  channels: ChannelRow[];
  /** Every matching channel of the active source (`channels` may show fewer). */
  channelTotal: number;
  /** Matching channels in groups Your countries hides ("Only these"); not in `channels`. */
  hiddenCount: number;
  onNow: ProgrammeHit[];
  later: TitleHit[];
  /** The guide's title index is being built or loaded: programme sections are empty for now. */
  guidePending: boolean;
  /** Folders whose name matches: channel folders first, then movie and series categories; at most 20. */
  folders: FolderHit[];
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
  /** The source's own archive listings for this channel arrived (`refineArchive`): redraw its Guide row. */
  | { type: 'archiveRefined'; channelId: string }
  /** A search index of `sourceId` (guide titles, or movie and series titles) became ready: re-run an open search. */
  | { type: 'searchReady'; sourceId: string }
  /** The active source's layout changed (version is the new `Layout.version`); `origin` says who changed it. */
  /** `recentOnly`: the batch changed nothing but "recently watched" (a zap); the companion is not told. */
  /** `restored`: a restored backup changed it (sent once, before `backupRestored`, which carries the one toast). */
  | { type: 'layoutChanged'; version: number; origin: LayoutOrigin; recentOnly?: boolean; restored?: boolean }
  /**
   * The active source or the source list changed (added, edited, deleted, switched). `activeSourceId` is the active
   * source afterwards (absent without sources); `origin` says who asked: this device's UI or a paired companion.
   */
  | { type: 'sourcesChanged'; activeSourceId?: string; origin: LayoutOrigin }
  /** The phone companion session changed state. */
  | { type: 'companion'; status: CompanionStatus }
  /** A backup was restored (`origin`: a file on this device, or sent by the phone). Counts as in `RestoreSummary`. */
  | { type: 'backupRestored'; origin: LayoutOrigin; applied: number; pending: number; sources: number; at: number }
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
  /**
   * Sends a sealed backup to the connected phone (protocol 3) and resolves once the phone says it kept it. Rejects
   * with `NoCompanion` (no phone), `OldCompanion` (the phone's page predates backups) or `Timeout`.
   */
  sendBackup?(backup: BackupEnvelope): Promise<void>;
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

/**
 * A source's guide import this session: `importing` (programmes stored so far, since `startedAt`), `idle` (none
 * running; `startedAt` 0 when none ran), or `failed` with its credential-free error.
 */
export interface GuideImportState {
  stage: 'idle' | 'importing' | 'failed';
  count: number;
  startedAt: number;
  error?: RpcError;
}

export interface DiagnosticsInfo {
  appVersion: string;
  sources: {
    id: string; name: string; kind: string; channels: number; skipped: number; playlistAt: number; epgAt: number;
    /** Always sent by app-api; optional for older callers and fixtures. */
    guideImport?: GuideImportState;
    /** Channels with catch-up and ones the app cannot build URLs for (absent when none). */
    catchupChannels?: number; catchupUnsupported?: number;
    /** How catch-up times are written: "Europe/Stockholm", "UTC+1:00 (fixed offset)", "UTC" or "manual +1:00". */
    catchupTime?: string;
  }[];
  /** Messages are already credential-free. */
  lastErrors: { at: number; where: string; message: string; name?: string; code?: number | string; status?: number }[];
  settings: AppSettings;
  /** What this device lets the app keep, in bytes (absent when it cannot say). */
  storage?: { used: number; quota: number };
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
/** One entry of a kind's category list. `fold`: another country's category, folded under that region key. */
export interface VodCategoryView { id: string; name: string; count: number; fold?: string }

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
  /** The best version's release name, as the service gives it ("" when none). */
  release: string;
  /** The frame rate the best version was timed for, when known. */
  fps?: number;
  /** The language's hearing-impaired (CC/SDH) row: its files are all hearing-impaired. */
  cc?: boolean;
}

/** One version of a title's subtitles in one language, best first in `subtitleVersions`. */
export interface SubtitleVersion {
  fileId: number;
  release: string;
  /** The frame rate it was timed for, when known. */
  fps?: number;
  /** Made for the exact file playing (exact match on, its hash matched). */
  synced: boolean;
  downloads: number;
  /** Made for the hearing impaired (CC/SDH). */
  hearingImpaired?: boolean;
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

/**
 * What the source says about a title's languages, for tracks whose own data names none (spec
 * 2026-10-22-track-languages). All ISO 639-1.
 */
export interface LanguageHints {
  /** The first audio stream's language, from the source's probe data. */
  firstAudio?: string;
  /** The title's (or its category's) language prefix ("SE | …"). */
  title?: string;
  /** What the prefix names: the speech, or the subtitles (a title tagged SUB). */
  titleScope?: 'audio' | 'subtitles';
}

export interface VodPlayable {
  kind: 'movie' | 'episode';
  itemId: string;
  /** Carries credentials: never display or log it. */
  url: string;
  /** Catch-up only (the TV's stand-in title): the second archive URL form, tried once before anything played. */
  alternateUrl?: string;
  title: string;
  /** Episodes: "S2 · E4 · Episode title". */
  episodeLabel?: string;
  resumeMs: number;
  durationMs?: number;
  tracks: VodTracks;
  /** The picture's dynamic range, when the source or the title tells (Dolby Vision warning). */
  video?: VideoRange;
  /** Subtitle files the source lists for this title. Their links can carry credentials: never display or log them. */
  subtitles?: SourceSubtitle[];
  /** Languages the source gives, for tracks that name none. */
  languageHints?: LanguageHints;
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
  /** The channels the picker shows (fold rows when combining). */
  start: number; stop: number; channelCount: number; followed: boolean;
  /** Competition text from the user's guide, as written (v2 guide records). */
  competition?: string;
  /** On air now (started at most 3 h ago); v2 guide records. */
  onAir?: boolean;
}
/** Matches in your guide: chips from the user's own guide; `id` is the folded text a setting stores. `pinned`: put first. */
export interface MatchFilterChip { id: string; label: string; pinned?: true }
export interface MatchFilterChips { competitions: MatchFilterChip[]; categories: MatchFilterChip[] }
/** View all's second chip row: one category's competitions (the first 8), the rest behind More…. */
export interface MatchCompetitionChips { chips: MatchFilterChip[]; more: MatchFilterChip[] }

export type StartRowId =
  | 'continue' | 'live' | 'sports' | 'trendingMovies' | 'trendingSeries' | 'newLibrary' | 'topMovies' | 'topSeries';
export type StartCell =
  /** `rank`: a Top 10 row's number, 1..N among the library's strongly matched titles in feed order. */
  | { type: 'vod'; tile: VodTile; rank?: number }
  | { type: 'channel'; channel: ChannelRow; last?: true }
  | { type: 'event'; event: SportsEventTile }
  /** `order: 'rating'`: the whole kind best rated first (Top rated); otherwise that kind's Recently added. */
  | { type: 'viewAll'; target: 'sports' | 'movie' | 'series'; total: number; order?: 'rating' };
export interface StartRow { id: StartRowId; title: string; cells: StartCell[] }
export interface StartHome { rows: StartRow[]; at: number }

/** One detected country (or `lang:xx`) of the active source, with what it covers. */
export interface RegionCount { code: string; label: string; groups: number; channels: number }

/** Your countries for the active source (report 2026-10-20 §2.2, §4.1): what the picker and Manage groups show. */
export interface RegionsOverview {
  mode: RegionMode;
  codes: string[];
  /** Countries chosen but none of this source's groups match: the rule is off; the UI shows a notice. */
  stale: boolean;
  /** Detected countries, largest first (by channels). */
  countries: RegionCount[];
  /** Groups with a guess below the cut-off ("Not sure"), no override. */
  notSure: { groups: number; channels: number };
  /** Groups with no region at all. */
  other: { groups: number; channels: number };
}

/** One country (or language) Your countries can pick: folders per section, sure detections only (spec 2026-10-22). */
export interface CountryChoice {
  key: string;
  label: string;
  isLanguage: boolean;
  /** Live TV groups the user has not hidden. */
  live: number;
  /** Categories of a catalogue already known this session; absent when not. */
  movies?: number;
  series?: number;
}

/** The flag grid's data: one worker call, from cached records only (never a catalogue load). */
export interface CountryChoices {
  /** This TV's country first, then most folders (live + movies + series), ties by label. */
  choices: CountryChoice[];
  /** From the TV locale, when it is among the choices. */
  deviceCountry?: string;
  regions: RegionSettings;
  foldCountries: boolean;
  combineCategories: boolean;
  /** Codes picked (mode not off) but none matches this source. */
  stale: boolean;
  /** Folders that go first with the current picks. */
  counts: { live: number; movies?: number; series?: number };
}

/** One Your countries change, saved in one settings write. */
export interface CountriesPatch { codes?: string[]; mode?: RegionMode; foldCountries?: boolean }

/** `show`: shown on purpose; `hide`: hidden; `rule`: back to the region rule. */
export type GroupVisibility = 'show' | 'hide' | 'rule';
