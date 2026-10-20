export interface Channel {
  id: string;
  sourceId: string;
  name: string;
  url: string;
  logo?: string;
  group: string;
  epgId?: string;
  number: number;
  /** Per-channel guide shift in hours (from tvg-shift). */
  epgShift?: number;
  /** Per-channel request headers from the playlist (`#EXTVLCOPT`, `#EXTHTTP`, the URL pipe). */
  headers?: StreamHeaders;
  /** The source keeps an archive of this channel's past programmes (spec 2026-10-20-catch-up §3.1). */
  catchup?: ChannelCatchup;
}

export type CatchupMode = 'default' | 'append' | 'shift' | 'flussonic' | 'xc';

export interface ChannelCatchup {
  mode: CatchupMode;
  /** Archive length in days, 1–30. */
  days: number;
  /** Index into the source's catch-up templates (modes default and append; absent for shift, flussonic and xc). */
  tpl?: number;
  /** `catchup-correction` in minutes, when the playlist sets one. */
  corrMin?: number;
}

/**
 * Catch-up time settings, both kinds. `catchupOffsetMin`: the user's correction (Settings → source → Advanced →
 * Catch-up time), a fixed offset from UTC in minutes; undefined = Auto. The server clock fields come from the last
 * Xtream login (or, for an M3U with `xc` channels, the one `player_api.php` probe at refresh).
 */
export interface CatchupSettings {
  catchupOffsetMin?: number;
  /** `server_info.timezone` (IANA name), when present. */
  serverTimeZone?: string;
  /** Panel wall clock minus UTC in minutes, from `server_info.time_now` vs `timestamp_now`; rounded to 15 min. */
  serverOffsetMin?: number;
}

/**
 * Request headers for a stream. Browsers forbid scripts to set them, so only players that can (Samsung AVPlay's
 * `USER_AGENT`, future native apps) apply them. Stored on the device only; never logged.
 */
export interface StreamHeaders {
  userAgent?: string;
  referrer?: string;
}

/** Per-source request header settings (Settings → source → Advanced). A channel's own header wins over these. */
export interface SourceHttpSettings {
  userAgent?: string;
  referrer?: string;
}

export interface Programme {
  epgId: string;
  start: number;
  stop: number;
  title: string;
  desc?: string;
}

export interface XtreamSourceConfig extends SourceHttpSettings, CatchupSettings {
  kind: 'xtream';
  id: string;
  name: string;
  server: string;
  username: string;
  password: string;
  /** `user_info.max_connections` from the last login or refresh. */
  maxConnections?: number;
  /** `user_info.active_cons` from the last login or refresh. */
  activeConnections?: number;
}

export interface M3uSourceConfig extends SourceHttpSettings, CatchupSettings {
  kind: 'm3u';
  id: string;
  name: string;
  playlistUrl: string;
  epgUrl?: string;
}

export type SourceConfig = XtreamSourceConfig | M3uSourceConfig;

export interface GroupInfo {
  id: string;
  name: string;
  count: number;
}

/** `RequestInit` plus a per-call header timeout, honoured (and stripped) by `withTimeout`. */
/**
 * `sourceHeaders`: the source's User-Agent and Referer settings for a list request (playlist, XMLTV, `player_api`).
 * Browsers forbid both headers on `fetch`, so the app's fetch turns them into a route URL where it has one (the dev
 * proxy today, the host route later) and strips the field; elsewhere they are dropped. Never logged.
 */
export type FetchInit = RequestInit & { timeoutMs?: number; sourceHeaders?: StreamHeaders };
export type FetchFn = (url: string, init?: FetchInit) => Promise<Response>;
