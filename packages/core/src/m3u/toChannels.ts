import { UNCATEGORIZED } from '../constants.ts';
import { fnv1a } from '../hash.ts';
import type { Channel } from '../types.ts';
import type { M3uEntry } from './parse.ts';

/**
 * Returns `base` if it is unused, otherwise `base-2`, `base-3`, ... (first free one).
 * The returned id is added to `used`.
 */
export function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

export function m3uEntriesToChannels(sourceId: string, entries: M3uEntry[]): Channel[] {
  const seen = new Set<string>();
  const unique: M3uEntry[] = [];
  let maxChno = 0;
  for (const e of entries) {
    if (seen.has(e.url)) continue;
    seen.add(e.url);
    unique.push(e);
    if (e.tvgChno && e.tvgChno > maxChno) maxChno = e.tvgChno;
  }
  const usedIds = new Set<string>();
  let next = maxChno + 1;
  return unique.map((e) => {
    const ch: Channel = {
      id: uniqueId(`${sourceId}:${fnv1a(e.url)}`, usedIds),
      sourceId,
      name: e.name,
      url: e.url,
      group: e.groupTitle ?? UNCATEGORIZED,
      number: e.tvgChno ?? next++,
    };
    if (e.tvgLogo) ch.logo = e.tvgLogo;
    if (e.tvgId) ch.epgId = e.tvgId;
    if (e.tvgShift) ch.epgShift = e.tvgShift;
    return ch;
  });
}
