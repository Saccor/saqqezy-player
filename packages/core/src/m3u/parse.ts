import { redactUrl } from '../errors.ts';
import { cleanHeaderValue } from '../net/headers.ts';
import { capName } from '../text/normalize.ts';
import type { StreamHeaders } from '../types.ts';

export interface M3uEntry {
  name: string;
  url: string;
  tvgId?: string;
  tvgName?: string;
  tvgLogo?: string;
  groupTitle?: string;
  tvgChno?: number;
  tvgShift?: number;
  /**
   * `tvg-country` and `tvg-language` as written (split on `,` / `;`, trimmed, no empties or duplicates): detection
   * signals for the region detector, not stored on `Channel`. Entries with the same raw value share one frozen list.
   */
  tvgCountry?: readonly string[];
  tvgLanguage?: readonly string[];
  /** Request headers from `#EXTVLCOPT:http-user-agent|http-referrer`, `#EXTHTTP:{…}` and the URL pipe. */
  headers?: StreamHeaders;
  /**
   * Set when the line had a URL pipe: the line as written. Channel, movie and episode ids are hashed from it (not from
   * the clean `url`), so they stay what they were before the pipe was stripped.
   */
  idKey?: string;
  /** Raw catch-up attributes (spec 2026-10-20-catch-up §1.1), the `#EXTM3U` header's as defaults; absent without any. */
  catchup?: M3uCatchupRaw;
}

/** `catchup`/`catchup-type`, `catchup-source`, `catchup-days` (or `timeshift`, `tvg-rec`) and `catchup-correction`. */
export interface M3uCatchupRaw { mode?: string; source?: string; days?: number; corrMin?: number }

/** What an entry's id is hashed from (and de-duplicated by): the line as written. */
export const entryIdKey = (e: M3uEntry): string => e.idKey ?? e.url;

export interface ParseStats {
  entries: number;
  skipped: number;
}

interface Pending {
  info: Omit<M3uEntry, 'url'>;
}

const ATTR_RE = /([A-Za-z0-9_-]+)="([^"]*)"/g;

/** Reads one catch-up attribute into `into` (created on first use); returns it, or undefined when `key` is not one. */
function catchupAttr(into: M3uCatchupRaw | undefined, key: string, value: string): M3uCatchupRaw | undefined {
  if (key === 'catchup' || key === 'catchup-type') {
    const out = into ?? {};
    out.mode = value.toLowerCase();
    return out;
  }
  if (key === 'catchup-source') {
    const out = into ?? {};
    out.source = value;
    return out;
  }
  if (key === 'catchup-days' || key === 'timeshift' || key === 'tvg-rec') {
    const n = Math.floor(Number.parseFloat(value));
    if (!Number.isFinite(n) || n < 1) return into;
    const out = into ?? {};
    out.days = n;
    return out;
  }
  if (key === 'catchup-correction') {
    const h = Number.parseFloat(value);
    if (!Number.isFinite(h)) return into;
    const out = into ?? {};
    out.corrMin = Math.round(Math.max(-12, Math.min(14, h)) * 4) * 15;
    return out;
  }
  return into;
}

/** The `#EXTM3U` line's catch-up attributes: defaults for every entry. */
function parseHeader(line: string): M3uCatchupRaw | undefined {
  let out: M3uCatchupRaw | undefined;
  for (const m of line.matchAll(ATTR_RE)) {
    const value = m[2]!.trim();
    if (value) out = catchupAttr(out, m[1]!.toLowerCase(), value);
  }
  return out;
}

/** Raw attribute value → its split list, per parse: a 50k playlist with one country allocates one list. */
type ListCache = Map<string, readonly string[] | undefined>;

/** `"SE, DK;NO"` → `['SE', 'DK', 'NO']`; undefined when nothing is left. */
function attrList(value: string, cache: ListCache): readonly string[] | undefined {
  if (cache.has(value)) return cache.get(value);
  const seen = new Set<string>();
  for (const part of value.split(/[,;]/)) {
    const t = part.trim();
    if (t) seen.add(t);
  }
  const out = seen.size ? Object.freeze([...seen]) : undefined;
  cache.set(value, out);
  return out;
}

function parseExtinf(line: string, lists: ListCache): Omit<M3uEntry, 'url'> {
  const body = line.slice('#EXTINF:'.length);
  let inQuote = false;
  let comma = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ',' && !inQuote) {
      comma = i;
      break;
    }
  }
  const head = comma === -1 ? body : body.slice(0, comma);
  const name = comma === -1 ? '' : capName(body.slice(comma + 1).trim());
  const info: Omit<M3uEntry, 'url'> = { name };
  for (const m of head.matchAll(ATTR_RE)) {
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (!value) continue;
    if (key === 'tvg-id') info.tvgId = value;
    else if (key === 'tvg-name') info.tvgName = capName(value);
    else if (key === 'tvg-logo') info.tvgLogo = value;
    else if (key === 'group-title') info.groupTitle = capName(value);
    else if (key === 'tvg-chno') {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) info.tvgChno = n;
    } else if (key === 'tvg-shift') {
      const n = Number.parseFloat(value);
      if (Number.isFinite(n)) info.tvgShift = Math.max(-12, Math.min(12, n));
    } else if (key === 'tvg-country' || key === 'tvg-language') {
      const list = attrList(value, lists);
      if (list) info[key === 'tvg-country' ? 'tvgCountry' : 'tvgLanguage'] = list;
    } else if (key.startsWith('catchup') || key === 'timeshift' || key === 'tvg-rec') {
      const c = catchupAttr(info.catchup, key, value);
      if (c) info.catchup = c;
    }
  }
  if (!info.name) info.name = info.tvgName ?? '';
  return info;
}

/** Sets the header `key` (any case) names, when it is a User-Agent or Referer and `value` is not empty. */
function setHeader(into: StreamHeaders, key: string, value: unknown): void {
  const k = key.trim().toLowerCase();
  const field = k === 'user-agent' || k === 'http-user-agent' ? 'userAgent'
    : k === 'referer' || k === 'referrer' || k === 'http-referrer' || k === 'http-referer' ? 'referrer'
      : undefined;
  if (!field) return;
  const v = cleanHeaderValue(value);
  if (v) into[field] = v;
}

/** `#EXTVLCOPT:http-user-agent=…` or `#EXTVLCOPT:http-referrer=…`. */
function readVlcOpt(body: string, into: StreamHeaders): void {
  const eq = body.indexOf('=');
  if (eq > 0) setHeader(into, body.slice(0, eq), body.slice(eq + 1));
}

/** `#EXTHTTP:{"User-Agent":…,"Referer":…}`; malformed JSON is ignored. */
function readExtHttp(body: string, into: StreamHeaders): void {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) setHeader(into, k, v);
}

/** Kodi's `url|User-Agent=…&Referer=…`: the headers go into `into`, and the URL is returned without the pipe. */
function readUrlPipe(line: string, into: StreamHeaders): string {
  // The first `|` starts the options (Kodi's rule): a stream URL has no literal `|`; one in a query is `%7C`.
  const bar = line.indexOf('|');
  if (bar === -1) return line;
  for (const pair of line.slice(bar + 1).split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    let value = pair.slice(eq + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // Not percent-encoded: kept as written.
    }
    setHeader(into, pair.slice(0, eq), value);
  }
  return line.slice(0, bar).trim();
}

export async function* parseM3u(
  lines: AsyncIterable<string>,
  stats: ParseStats = { entries: 0, skipped: 0 },
): AsyncGenerator<M3uEntry> {
  let pending: Pending | null = null;
  let pendingGroup: string | undefined;
  /** Header tags seen since the last URL (before or after its #EXTINF). */
  let tagHeaders: StreamHeaders = {};
  /** Catch-up defaults from the `#EXTM3U` header line. */
  let headerCatchup: M3uCatchupRaw | undefined;
  const lists: ListCache = new Map();
  for await (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) {
      headerCatchup = parseHeader(line.slice('#EXTM3U'.length));
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      if (pending) {
        stats.skipped++;
        // The skipped entry's header tags must not reach the next one.
        tagHeaders = {};
      }
      pending = { info: parseExtinf(line, lists) };
      pendingGroup = undefined;
      continue;
    }
    if (line.startsWith('#EXTGRP:')) {
      pendingGroup = capName(line.slice('#EXTGRP:'.length).trim()) || undefined;
      continue;
    }
    if (line.startsWith('#EXTVLCOPT:')) {
      readVlcOpt(line.slice('#EXTVLCOPT:'.length), tagHeaders);
      continue;
    }
    if (line.startsWith('#EXTHTTP:')) {
      readExtHttp(line.slice('#EXTHTTP:'.length), tagHeaders);
      continue;
    }
    if (line.startsWith('#')) continue;
    // The pipe is read last, so its headers win over the tags'. No allocation for the common entry without either.
    const headers = tagHeaders;
    const url = readUrlPipe(line, headers);
    const info = pending?.info ?? { name: '' };
    const entry: M3uEntry = { ...info, url };
    if (url !== line) entry.idKey = line;
    if (headers.userAgent || headers.referrer) {
      entry.headers = headers;
      tagHeaders = {};
    }
    if (!entry.name) entry.name = capName(redactUrl(url));
    if (!entry.groupTitle && pendingGroup) entry.groupTitle = pendingGroup;
    // The entry's own attributes win over the header's, field by field.
    if (headerCatchup) entry.catchup = entry.catchup ? { ...headerCatchup, ...entry.catchup } : { ...headerCatchup };
    pending = null;
    pendingGroup = undefined;
    stats.entries++;
    yield entry;
  }
  if (pending) stats.skipped++;
}
