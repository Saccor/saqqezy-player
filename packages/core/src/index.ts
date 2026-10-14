export const CORE_VERSION = '0.0.0';
export * from './types.ts';
export * from './constants.ts';
export * from './errors.ts';
export { fnv1a } from './hash.ts';
export { splitLines } from './text/lines.ts';
export { normalize } from './text/normalize.ts';
export { parseM3u, type M3uEntry, type ParseStats } from './m3u/parse.ts';
export { m3uEntriesToChannels } from './m3u/toChannels.ts';
export { ChannelIndex, type ProviderGroupInfo } from './index/channelIndex.ts';
export { type Storage, MAX_PROGRAMME_MS } from './storage.ts';
export {
  XtreamClient, normalizeServer,
  type XtreamAccount, type XtreamCategory, type XtreamStream,
} from './xtream/client.ts';
export { xtreamToChannels } from './xtream/toChannels.ts';
export { API_TIMEOUT_MS, BODY_IDLE_MS, DOWNLOAD_TIMEOUT_MS, withTimeout } from './net/timeout.ts';
export { alternateStreamUrl } from './net/alternate.ts';
export { DEFAULT_SETTINGS, sanitizeSettings, type AppSettings } from './settings.ts';
export { responseText, type BodyReadOptions } from './net/textStream.ts';
export { parseXmltvDate } from './xmltv/date.ts';
export { parseXmltv, type XmltvItem, type XmltvStats } from './xmltv/parse.ts';
export { EpgMatcher, applyShift, epgKey, inWindow, nowNext } from './epg/window.ts';
export {
  SourceService,
  type EpgResult, type IngestResult, type NewSource, type Progress, type SourceServiceDeps,
} from './service/sourceService.ts';
export * from './layout/index.ts';
