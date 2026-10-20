import { SourceAuthError, SourceNetworkError, SourceRefusedError } from '../errors.ts';
import { responseText } from '../net/textStream.ts';
import { jsonArrayBatches } from '../net/jsonArrayStream.ts';
import { API_TIMEOUT_MS, BODY_IDLE_MS, DOWNLOAD_TIMEOUT_MS } from '../net/timeout.ts';
import { sourceHeadersOf } from '../net/headers.ts';
import type { FetchFn, Programme, SourceHttpSettings, StreamHeaders } from '../types.ts';
import type { MovieDetail, SeriesDetail, VodCategory, VodItem } from '../vod/types.ts';
import { CATCHUP_DEFAULT_DAYS, CATCHUP_MAX_DAYS } from '../catchup/m3uCatchup.ts';
import { serverOffsetFrom } from '../catchup/zone.ts';
import { isObj, nameStr, nonNegInt, posInt, str } from './json.ts';
import {
  parseSeriesInfo, parseSeriesList, parseVodCategories, parseVodInfo, parseVodStreams,
} from './vod.ts';

/** The message of a `SourceNetworkError` for an answer that is not the JSON the action should return. */
export const UNEXPECTED_RESPONSE = 'Unexpected response from the provider.';

export interface XtreamCategory { id: string; name: string }
export interface XtreamStream {
  streamId: number;
  name: string;
  icon?: string;
  epgChannelId?: string;
  categoryId?: string;
  num?: number;
  /** `tv_archive` 1: the archive length in days (`tv_archive_duration`, 1–30, 3 when missing or 0). */
  archiveDays?: number;
}
export interface XtreamAccount {
  expiresAt?: number; maxConnections?: number; activeConnections?: number;
  /** `server_info.timezone` (IANA name), when present. */
  serverTimeZone?: string;
  /** Panel wall clock minus UTC in minutes (`time_now` vs `timestamp_now`), rounded to 15 min. */
  serverOffsetMin?: number;
}
/** One `get_simple_data_table` listing: a programme with the panel's own archive answer. */
export interface ArchiveListing extends Programme { hasArchive: boolean }

export function normalizeServer(server: string): string {
  let s = server.trim();
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s.replace(/\/+$/, '');
}

function decodeBase64Utf8(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return b64;
  }
}

export class XtreamClient {
  private readonly base: string;
  private readonly idleMs: number;
  /** The source's User-Agent and Referer, sent with every `player_api` call (`FetchInit.sourceHeaders`). */
  private readonly sourceHeaders: StreamHeaders | undefined;

  constructor(
    private readonly cfg: { server: string; username: string; password: string } & SourceHttpSettings,
    private readonly fetchFn: FetchFn,
    /** `idleMs`: JSON body inactivity timeout (default `BODY_IDLE_MS`, as for playlist and guide bodies). */
    opts: { idleMs?: number } = {},
  ) {
    this.base = normalizeServer(cfg.server);
    this.idleMs = opts.idleMs ?? BODY_IDLE_MS;
    this.sourceHeaders = sourceHeadersOf(cfg);
  }

  private credQuery(): string {
    return new URLSearchParams({ username: this.cfg.username, password: this.cfg.password }).toString();
  }

  /** One `player_api.php` request, its status mapped: a 2xx response with a body, or a neutral error. */
  private async request(action: string | undefined, extra: Record<string, string>, signal: AbortSignal | undefined, timeoutMs: number): Promise<Response> {
    const params = new URLSearchParams({ username: this.cfg.username, password: this.cfg.password });
    if (action) params.set('action', action);
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/player_api.php?${params.toString()}`, {
        timeoutMs, ...(signal ? { signal } : {}), ...(this.sourceHeaders ? { sourceHeaders: this.sourceHeaders } : {}),
      });
    } catch (err) {
      if (err instanceof SourceNetworkError || err instanceof SourceRefusedError) throw err;
      throw new SourceNetworkError('Could not reach the provider.');
    }
    if (res.status === 401 || res.status === 403) throw new SourceAuthError();
    if (!res.ok) throw new SourceNetworkError(`The provider returned an error (HTTP ${res.status}).`, res.status);
    if (!res.body) throw new SourceNetworkError(UNEXPECTED_RESPONSE);
    return res;
  }

  private async api(action?: string, extra: Record<string, string> = {}, signal?: AbortSignal): Promise<unknown> {
    const res = await this.request(action, extra, signal, API_TIMEOUT_MS);
    const unexpected = () => new SourceNetworkError(UNEXPECTED_RESPONSE);
    let text = '';
    try {
      for await (const chunk of responseText(res, `${this.base}/player_api.php`, { idleMs: this.idleMs })) text += chunk;
    } catch (err) {
      // Our own neutral body errors (stalled, cancelled) are kept; anything else reads as a bad answer.
      if (err instanceof SourceNetworkError) throw err;
      throw unexpected();
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw unexpected();
    }
  }

  /**
   * A whole list action (no `category_id`), parsed while it downloads: `parse` runs on each batch of raw elements, so
   * the body is never held as one string. Headers get the download timeout (panels build the full answer before the
   * first byte); the body the inactivity timeout. A non-array answer goes to `parse` as is (it parses to no items).
   */
  private async *streamList<T>(action: string, parse: (data: unknown) => T[], signal?: AbortSignal): AsyncGenerator<T[]> {
    const res = await this.request(action, {}, signal, DOWNLOAD_TIMEOUT_MS);
    const text = responseText(res, `${this.base}/player_api.php`, { idleMs: this.idleMs, ...(signal ? { signal } : {}) });
    try {
      for await (const b of jsonArrayBatches(text)) {
        const items = parse(b.nonArray ? b.items[0] : b.items);
        if (items.length) yield items;
      }
    } catch (err) {
      if (err instanceof SourceNetworkError) throw err;
      throw new SourceNetworkError(UNEXPECTED_RESPONSE);
    }
  }

  async authenticate(): Promise<XtreamAccount> {
    const data = await this.api();
    const info = isObj(data) ? data.user_info : undefined;
    if (!isObj(info) || String(info.auth) !== '1') throw new SourceAuthError();
    if (String(info.status ?? '').toLowerCase() === 'expired') {
      throw new SourceAuthError('The provider account has expired.');
    }
    const account: XtreamAccount = {};
    const exp = posInt(info.exp_date);
    if (exp) account.expiresAt = exp * 1000;
    const max = posInt(info.max_connections);
    if (max) account.maxConnections = max;
    const active = nonNegInt(info.active_cons);
    if (active !== undefined) account.activeConnections = active;
    const server = isObj(data) ? data.server_info : undefined;
    if (isObj(server)) {
      const zone = str(server.timezone);
      if (zone) account.serverTimeZone = zone;
      const offset = serverOffsetFrom(server.time_now, server.timestamp_now);
      if (offset !== undefined) account.serverOffsetMin = offset;
    }
    return account;
  }

  async liveCategories(): Promise<XtreamCategory[]> {
    const data = await this.api('get_live_categories');
    if (!Array.isArray(data)) return [];
    return data
      .filter(isObj)
      .map((c) => ({ id: str(c.category_id), name: nameStr(c.category_name) }))
      .filter((c): c is XtreamCategory => !!c.id && !!c.name);
  }

  async liveStreams(): Promise<XtreamStream[]> {
    const data = await this.api('get_live_streams');
    if (!Array.isArray(data)) return [];
    const out: XtreamStream[] = [];
    for (const s of data) {
      if (!isObj(s)) continue;
      const streamId = posInt(s.stream_id);
      const name = nameStr(s.name);
      if (!streamId || !name) continue;
      const stream: XtreamStream = { streamId, name };
      const icon = str(s.stream_icon);
      if (icon) stream.icon = icon;
      const epg = str(s.epg_channel_id);
      if (epg) stream.epgChannelId = epg;
      const cat = str(s.category_id);
      if (cat) stream.categoryId = cat;
      const num = posInt(s.num);
      if (num) stream.num = num;
      if (String(s.tv_archive ?? '') === '1') {
        const days = posInt(s.tv_archive_duration);
        stream.archiveDays = days ? Math.min(CATCHUP_MAX_DAYS, days) : CATCHUP_DEFAULT_DAYS;
      }
      out.push(stream);
    }
    return out;
  }

  private mediaUrl(kind: 'live' | 'movie' | 'series', xid: number, ext: string): string {
    return `${this.base}/${kind}/${encodeURIComponent(this.cfg.username)}/${encodeURIComponent(this.cfg.password)}/${xid}.${ext}`;
  }

  streamUrl(streamId: number, ext: 'ts' | 'm3u8'): string {
    return this.mediaUrl('live', streamId, ext);
  }

  async vodCategories(signal?: AbortSignal): Promise<VodCategory[]> {
    return parseVodCategories(await this.api('get_vod_categories', {}, signal), 'movie');
  }

  async vodStreams(sourceId: string, categoryId?: string, signal?: AbortSignal): Promise<VodItem[]> {
    return parseVodStreams(await this.api('get_vod_streams', categoryId ? { category_id: categoryId } : {}, signal), sourceId);
  }

  /** Every movie in one streamed request, in batches. */
  vodStreamBatches(sourceId: string, signal?: AbortSignal): AsyncGenerator<VodItem[]> {
    return this.streamList('get_vod_streams', (d) => parseVodStreams(d, sourceId), signal);
  }

  /** Every series in one streamed request, in batches. */
  seriesBatches(sourceId: string, signal?: AbortSignal): AsyncGenerator<VodItem[]> {
    return this.streamList('get_series', (d) => parseSeriesList(d, sourceId), signal);
  }

  async vodInfo(xid: number): Promise<MovieDetail> {
    return parseVodInfo(await this.api('get_vod_info', { vod_id: String(xid) }));
  }

  async seriesCategories(signal?: AbortSignal): Promise<VodCategory[]> {
    return parseVodCategories(await this.api('get_series_categories', {}, signal), 'series');
  }

  async seriesList(sourceId: string, categoryId?: string, signal?: AbortSignal): Promise<VodItem[]> {
    return parseSeriesList(await this.api('get_series', categoryId ? { category_id: categoryId } : {}, signal), sourceId);
  }

  async seriesInfo(sourceId: string, xid: number): Promise<SeriesDetail> {
    return parseSeriesInfo(await this.api('get_series_info', { series_id: String(xid) }), sourceId);
  }

  movieUrl(xid: number, ext: string): string {
    return this.mediaUrl('movie', xid, ext);
  }

  episodeUrl(xid: number, ext: string): string {
    return this.mediaUrl('series', xid, ext);
  }

  xmltvUrl(): string {
    return `${this.base}/xmltv.php?${this.credQuery()}`;
  }

  /**
   * `get_simple_data_table`: the panel's listings for one stream, past ones included, with its per-programme
   * `has_archive`. Used lazily for the focused Guide row only (spec 2026-10-20-catch-up §1.4).
   */
  async simpleDataTable(streamId: number, epgId: string): Promise<ArchiveListing[]> {
    const data = await this.api('get_simple_data_table', { stream_id: String(streamId) });
    const listings = isObj(data) ? data.epg_listings : undefined;
    const out: ArchiveListing[] = [];
    if (!Array.isArray(listings)) return out;
    for (const l of listings) {
      if (!isObj(l)) continue;
      const start = posInt(l.start_timestamp);
      const stop = posInt(l.stop_timestamp);
      if (!start || !stop || stop <= start) continue;
      const p: ArchiveListing = { epgId, start: start * 1000, stop: stop * 1000, title: decodeBase64Utf8(String(l.title ?? '')), hasArchive: String(l.has_archive ?? '') === '1' };
      const desc = str(l.description);
      if (desc) p.desc = decodeBase64Utf8(desc);
      out.push(p);
    }
    return out;
  }

  async shortEpg(streamId: number, epgId: string, limit = 2): Promise<Programme[]> {
    const data = await this.api('get_short_epg', { stream_id: String(streamId), limit: String(limit) });
    const listings = isObj(data) ? data.epg_listings : undefined;
    const out: Programme[] = [];
    if (!Array.isArray(listings)) return out;
    for (const l of listings) {
      if (!isObj(l)) continue;
      const start = posInt(l.start_timestamp);
      const stop = posInt(l.stop_timestamp);
      if (!start || !stop) continue;
      const p: Programme = { epgId, start: start * 1000, stop: stop * 1000, title: decodeBase64Utf8(String(l.title ?? '')) };
      const desc = str(l.description);
      if (desc) p.desc = decodeBase64Utf8(desc);
      out.push(p);
    }
    return out;
  }
}
