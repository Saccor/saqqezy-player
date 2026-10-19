export const CORE_VERSION = '0.0.0';
export * from './types.ts';
export * from './constants.ts';
export * from './errors.ts';
export { fnv1a } from './hash.ts';
export { splitLines } from './text/lines.ts';
export { normalize } from './text/normalize.ts';
export { searchKey } from './text/searchKey.ts';
export { parseM3u, type M3uEntry, type ParseStats } from './m3u/parse.ts';
export { m3uEntriesToChannels } from './m3u/toChannels.ts';
export { ChannelIndex, type ProviderGroupInfo } from './index/channelIndex.ts';
export { orderGroupChannels } from './index/order.ts';
export { type Storage, MAX_PROGRAMME_MS } from './storage.ts';
export * from './vod/types.ts';
export { splitYear, parseEpisodeMarker } from './vod/title.ts';
export { buildVodList, emptyVodList, seasonsOf } from './vod/list.ts';
export { VodCatalog } from './vod/catalog.ts';
export { buildVodSearchIndex, searchVodIndex, vodIndexEntry, vodSearchIndexBytes, type VodIndexEntry, type VodSearchIndex } from './vod/searchIndex.ts';
export { fetchXtreamCatalog, xtreamVodApi, VodFetchCancelled, type XtreamVodApi } from './vod/fetchXtream.ts';
export {
  CONTINUE_MAX, MIN_RESUME_MS, WATCHED_RATIO,
  applyProgress, clearProgress, continueMovies, continueSeries, emptyUserState, episodeLabel, isBeforeSeriesPoint, isInProgress,
  nextEpisode, prevEpisode, resumeMs, setFavourite, setTracks, setWatched, type SeriesContinue,
} from './vod/progress.ts';
export { classifyEntry, splitM3uVod, type EntryKind } from './m3u/vodSplit.ts';
export { VodService, type VodServiceDeps } from './service/vodService.ts';
export {
  XtreamClient, normalizeServer,
  type XtreamAccount, type XtreamCategory, type XtreamStream,
} from './xtream/client.ts';
export { xtreamToChannels } from './xtream/toChannels.ts';
export { API_TIMEOUT_MS, BODY_IDLE_MS, DOWNLOAD_TIMEOUT_MS, withTimeout } from './net/timeout.ts';
export { alternateStreamUrl } from './net/alternate.ts';
export {
  COOLDOWN_STEPS_MS, REFUSAL_STATUSES, RETRY_AFTER_MAX_MS, RETRY_AFTER_MIN_MS, RefusalGuard, UNREACHABLE_FAILS, UNREACHABLE_STEPS_MS,
  UNREACHABLE_WINDOW_MS, streamCooldownKey, streamKeySource, type CooldownCause, type CooldownListener, type RefusalGuardDeps, type SourceCooldown,
} from './net/refusalGuard.ts';
export { parseRetryAfter } from './net/retryAfter.ts';
export { HEADER_VALUE_MAX, cleanHeaderValue, mergeHeaders, withCleanHttpSettings } from './net/headers.ts';
export {
  REFRESH_BACKOFF_MS, REFRESH_WHATS, countsAsRefreshFailure, refreshFailKey, type RefreshFailRecord, type RefreshWhat,
} from './service/refreshBackoff.ts';
export { DEFAULT_SETTINGS, SUBTITLE_LANGUAGES, sanitizeSettings, type AppSettings, type LiveDelaySetting } from './settings.ts';
export { responseText, type BodyReadOptions } from './net/textStream.ts';
export { parseXmltvDate } from './xmltv/date.ts';
export { parseXmltv, type XmltvItem, type XmltvStats } from './xmltv/parse.ts';
export { EpgMatcher, applyShift, epgKey, inWindow, nowNext } from './epg/window.ts';
export {
  SourceService,
  type EpgResult, type IngestResult, type NewSource, type Progress, type RefreshOptions, type SourceServiceDeps,
} from './service/sourceService.ts';
export * from './layout/index.ts';
export {
  MAX_TITLE_AIRINGS, TitleIndexBuilder, isTitleIndexData, queryTitles,
  type TitleAiring, type TitleIndexData, type TitleMatch,
} from './search/titleIndex.ts';
export { SUBTITLE_MAX_BYTES, cueAt, decodeSubtitle, parseSubtitles, type SubtitleCue } from './subtitles/parse.ts';
export {
  SUBTITLE_KEEP, SubtitleError, SubtitleService, type LoadedSubtitle, type SubtitleInput, type SubtitleServiceDeps,
} from './subtitles/service.ts';
export {
  OpenSubtitlesClient, bestSubtitle, languageChoices, searchParams, searchTitle,
  type LanguageChoice, type OnlineSubtitle, type OpenSubtitlesDeps, type SubtitleSearch,
} from './subtitles/openSubtitles.ts';
