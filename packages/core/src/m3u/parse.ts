import { redactUrl } from '../errors.ts';
import { cleanHeaderValue } from '../net/headers.ts';
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
  /** Request headers from `#EXTVLCOPT:http-user-agent|http-referrer`, `#EXTHTTP:{…}` and the URL pipe. */
  headers?: StreamHeaders;
}

export interface ParseStats {
  entries: number;
  skipped: number;
}

interface Pending {
  info: Omit<M3uEntry, 'url'>;
}

const ATTR_RE = /([A-Za-z0-9_-]+)="([^"]*)"/g;

function parseExtinf(line: string): Omit<M3uEntry, 'url'> {
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
  const name = comma === -1 ? '' : body.slice(comma + 1).trim();
  const info: Omit<M3uEntry, 'url'> = { name };
  for (const m of head.matchAll(ATTR_RE)) {
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (!value) continue;
    if (key === 'tvg-id') info.tvgId = value;
    else if (key === 'tvg-name') info.tvgName = value;
    else if (key === 'tvg-logo') info.tvgLogo = value;
    else if (key === 'group-title') info.groupTitle = value;
    else if (key === 'tvg-chno') {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) info.tvgChno = n;
    } else if (key === 'tvg-shift') {
      const n = Number.parseFloat(value);
      if (Number.isFinite(n)) info.tvgShift = Math.max(-12, Math.min(12, n));
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
  for await (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      if (pending) stats.skipped++;
      pending = { info: parseExtinf(line) };
      pendingGroup = undefined;
      continue;
    }
    if (line.startsWith('#EXTGRP:')) {
      pendingGroup = line.slice('#EXTGRP:'.length).trim() || undefined;
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
    if (headers.userAgent || headers.referrer) {
      entry.headers = headers;
      tagHeaders = {};
    }
    if (!entry.name) entry.name = redactUrl(url);
    if (!entry.groupTitle && pendingGroup) entry.groupTitle = pendingGroup;
    pending = null;
    pendingGroup = undefined;
    stats.entries++;
    yield entry;
  }
  if (pending) stats.skipped++;
}
