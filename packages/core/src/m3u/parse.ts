export interface M3uEntry {
  name: string;
  url: string;
  tvgId?: string;
  tvgName?: string;
  tvgLogo?: string;
  groupTitle?: string;
  tvgChno?: number;
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
    }
  }
  if (!info.name) info.name = info.tvgName ?? '';
  return info;
}

export async function* parseM3u(
  lines: AsyncIterable<string>,
  stats: ParseStats = { entries: 0, skipped: 0 },
): AsyncGenerator<M3uEntry> {
  let pending: Pending | null = null;
  let pendingGroup: string | undefined;
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
    if (line.startsWith('#')) continue;
    const info = pending?.info ?? { name: line };
    const entry: M3uEntry = { ...info, url: line };
    if (!entry.name) entry.name = line;
    if (!entry.groupTitle && pendingGroup) entry.groupTitle = pendingGroup;
    pending = null;
    pendingGroup = undefined;
    stats.entries++;
    yield entry;
  }
  if (pending) stats.skipped++;
}
