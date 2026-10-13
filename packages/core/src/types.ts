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
}

export interface Programme {
  epgId: string;
  start: number;
  stop: number;
  title: string;
  desc?: string;
}

export interface XtreamSourceConfig {
  kind: 'xtream';
  id: string;
  name: string;
  server: string;
  username: string;
  password: string;
}

export interface M3uSourceConfig {
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

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
