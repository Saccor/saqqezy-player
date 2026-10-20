export const CORE_VERSION = '0.0.0';
export * from './types.ts';
export * from './constants.ts';
export * from './errors.ts';
export { fnv1a } from './hash.ts';
export { splitLines } from './text/lines.ts';
export { normalize } from './text/normalize.ts';
export { searchKey } from './text/searchKey.ts';
export { parseM3u, type M3uCatchupRaw, type M3uEntry, type ParseStats } from './m3u/parse.ts';
export { archiveState, daysLeft, playableState, type ArchiveState } from './catchup/availability.ts';
export { buildCatchupUrl, type BuiltCatchup } from './catchup/buildUrl.ts';
export { CATCHUP_DEFAULT_DAYS, CATCHUP_MAX_DAYS, CATCHUP_MAX_TEMPLATES, CatchupCollector, resolveCatchup } from './catchup/m3uCatchup.ts';
export { renderTemplate, templateStepMs, validTemplate, type TemplateTimes } from './catchup/template.ts';
export { parseXcLiveUrl, xcDurationMin, xcStart, xcTimeshiftPhpUrl, xcTimeshiftUrl, type XcParts } from './catchup/xc.ts';
export {
  CATCHUP_OFFSET_MAX, CATCHUP_OFFSET_MIN, formatOffset, intlZonesWork, pickZone, serverOffsetFrom, wallClock, withCleanCatchupOffset, zoneLabel,
  type CatchupZone, type WallClock, type ZoneChoice, type ZoneHow, type ZoneInputs,
} from './catchup/zone.ts';
export { m3uEntriesToChannels } from './m3u/toChannels.ts';
export { ChannelIndex, type ChannelIndexOptions, type ChannelRegionView, type ProviderGroupInfo, type RegionState } from './index/channelIndex.ts';
export { orderGroupChannels } from './index/order.ts';
export { type Storage, type SyncMetaEntry, MAX_PROGRAMME_MS } from './storage.ts';
export * from './vod/types.ts';
export { splitYear, parseEpisodeMarker } from './vod/title.ts';
export { buildVodList, emptyVodList, seasonsOf } from './vod/list.ts';
export { VodCatalog, type VodMember } from './vod/catalog.ts';
export { parseVodTitle, categoryBase, QUALITY_LABELS, QUALITY_UNKNOWN, type ParsedTitle } from './vod/titleParse.ts';
export { groupVod, mergedCategoryId, type VodGroup, type VodGroups } from './vod/grouping.ts';
export {
  applyVodOps, detectVodRegions, emptyVodLayout, isVodLayoutOp, isVodLayoutOpBatch, normalizeVodLayout, vodCategoryView, vodLayoutKey,
  type VodApplyResult, type VodCategoryView, type VodLayout, type VodLayoutOp, type VodRegionView,
} from './vod/layout.ts';
export {
  TRENDING_FEED_MAX, buildTrendingIndex, matchTrending, matchTrendingHits, parseTrendingFeed,
  type TrendingCandidate, type TrendingFeed, type TrendingFeedItem, type TrendingHit, type TrendingIndex,
} from './vod/trending.ts';
export { orderVersions, preferredLanguages, type VersionCandidate, type VersionContext } from './vod/versions.ts';
export { parseChannelName, type ParsedChannelName } from './live/channelName.ts';
export {
  REGION_DETECTOR_VERSION, REGION_SURE, countryLabel, countryLanguages, detectRegions, isSure, knownCountries, normalizeCountry,
  buildRegionsRecord, readRegionsRecord, regionInputs, regionKeys, regionsKey, tallyTvg, type RegionsRecord, type GroupRegion, type RegionGroupInput, type RegionVia, type TvgTally,
} from './text/regions.ts';
export { regionRule, sureRegionKeys, type RegionRule, type RegionRuleInput } from './index/regionRule.ts';
export { foldChannels, type ChannelFold, type ChannelFolds } from './live/fold.ts';
export { orderLiveSources, type LiveSourceCandidate, type LiveSourceContext } from './live/sources.ts';
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
export { HEADER_VALUE_MAX, cleanHeaderValue, mergeHeaders, sourceHeadersOf, withCleanHttpSettings } from './net/headers.ts';
export {
  REFRESH_BACKOFF_MS, REFRESH_WHATS, countsAsRefreshFailure, refreshFailKey, type RefreshFailRecord, type RefreshWhat,
} from './service/refreshBackoff.ts';
export { DEFAULT_SETTINGS, FOLLOWED_TEAMS_MAX, FOLLOWED_TEAM_LEN, PREFERRED_LANGUAGES_MAX, REGIONS_MAX, regionCode, type RegionMode, type RegionSettings, SUBTITLE_LANGUAGES, sanitizeSettings, type AppSettings, type LiveDelaySetting, type OpenOn, type PosterSize } from './settings.ts';
export { responseText, type BodyReadOptions } from './net/textStream.ts';
export { parseXmltvDate } from './xmltv/date.ts';
export { parseXmltv, type ProgrammeExtra, type XmltvItem, type XmltvStats } from './xmltv/parse.ts';
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
  SUBTITLE_DELAY_MAX_MS, SUBTITLE_KEEP, SubtitleError, SubtitleService, type LoadedSubtitle, type SubtitleInput, type SubtitleServiceDeps,
} from './subtitles/service.ts';
export {
  OpenSubtitlesClient, bestSubtitle, languageChoices, rankSubtitles, searchParams, searchTitle,
  type LanguageChoice, type OnlineSubtitle, type OpenSubtitlesDeps, type SubtitleSearch,
} from './subtitles/openSubtitles.ts';
export { HASH_CHUNK, fetchMovieHash, openSubtitlesHash } from './subtitles/movieHash.ts';
export { scoreProgramme, EVENT_THRESHOLD, type Detection } from './sports/detect.ts';
export { foldText, jaroWinkler, normSide, resolveAlias, sideMatch } from './sports/match.ts';
export { compareAirings, isBackupName, qualityRank, type AiringOrderKey } from './sports/quality.ts';
export { groupEvents, type GroupInput, type SportsGroup } from './sports/group.ts';
export { isFollowed } from './sports/follow.ts';
export { SportsIndexBuilder, isSportsIndexRecord, SPORTS_MAX_CANDIDATES, type SportsCandidate, type SportsIndexRecord } from './sports/index.ts';
export * from './sync/index.ts';
