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

export interface XtreamSourceConfig extends SourceHttpSettings {
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

export interface M3uSourceConfig extends SourceHttpSettings {
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
export type FetchInit = RequestInit & { timeoutMs?: number };
export type FetchFn = (url: string, init?: FetchInit) => Promise<Response>;
