import { SourceAuthError, SourceNetworkError } from '../errors.ts';
import type { FetchFn, Programme } from '../types.ts';

export interface XtreamCategory { id: string; name: string }
export interface XtreamStream {
  streamId: number;
  name: string;
  icon?: string;
  epgChannelId?: string;
  categoryId?: string;
  num?: number;
}
export interface XtreamAccount { expiresAt?: number; maxConnections?: number }

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

const str = (v: unknown): string | undefined =>
  v === null || v === undefined || String(v).trim() === '' ? undefined : String(v).trim();
const posInt = (v: unknown): number | undefined => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export class XtreamClient {
  private readonly base: string;

  constructor(
    private readonly cfg: { server: string; username: string; password: string },
    private readonly fetchFn: FetchFn,
  ) {
    this.base = normalizeServer(cfg.server);
  }

  private credQuery(): string {
    return new URLSearchParams({ username: this.cfg.username, password: this.cfg.password }).toString();
  }

  private async api(action?: string, extra: Record<string, string> = {}): Promise<unknown> {
    const params = new URLSearchParams({ username: this.cfg.username, password: this.cfg.password });
    if (action) params.set('action', action);
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/player_api.php?${params.toString()}`);
    } catch {
      throw new SourceNetworkError('Could not reach the provider.');
    }
    if (res.status === 401 || res.status === 403) throw new SourceAuthError();
    if (!res.ok) throw new SourceNetworkError(`The provider returned an error (HTTP ${res.status}).`, res.status);
    try {
      return await res.json();
    } catch {
      throw new SourceNetworkError('Unexpected response from the provider.');
    }
  }

  async authenticate(): Promise<XtreamAccount> {
    const data = (await this.api()) as { user_info?: Record<string, unknown> };
    const info = data?.user_info;
    if (!info || String(info.auth) !== '1') throw new SourceAuthError();
    if (String(info.status ?? '').toLowerCase() === 'expired') {
      throw new SourceAuthError('The provider account has expired.');
    }
    const account: XtreamAccount = {};
    const exp = posInt(info.exp_date);
    if (exp) account.expiresAt = exp * 1000;
    const max = posInt(info.max_connections);
    if (max) account.maxConnections = max;
    return account;
  }

  async liveCategories(): Promise<XtreamCategory[]> {
    const data = await this.api('get_live_categories');
    if (!Array.isArray(data)) return [];
    return data
      .map((c: Record<string, unknown>) => ({ id: str(c.category_id), name: str(c.category_name) }))
      .filter((c): c is XtreamCategory => !!c.id && !!c.name);
  }

  async liveStreams(): Promise<XtreamStream[]> {
    const data = await this.api('get_live_streams');
    if (!Array.isArray(data)) return [];
    const out: XtreamStream[] = [];
    for (const s of data as Record<string, unknown>[]) {
      const streamId = posInt(s.stream_id);
      const name = str(s.name);
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
      out.push(stream);
    }
    return out;
  }

  streamUrl(streamId: number, ext: 'ts' | 'm3u8'): string {
    const u = encodeURIComponent(this.cfg.username);
    const p = encodeURIComponent(this.cfg.password);
    return `${this.base}/live/${u}/${p}/${streamId}.${ext}`;
  }

  xmltvUrl(): string {
    return `${this.base}/xmltv.php?${this.credQuery()}`;
  }

  async shortEpg(streamId: number, epgId: string, limit = 2): Promise<Programme[]> {
    const data = (await this.api('get_short_epg', { stream_id: String(streamId), limit: String(limit) })) as {
      epg_listings?: Record<string, unknown>[];
    };
    const out: Programme[] = [];
    for (const l of data?.epg_listings ?? []) {
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
