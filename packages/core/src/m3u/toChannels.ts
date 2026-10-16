import { UNCATEGORIZED } from '../constants.ts';
import { fnv1a } from '../hash.ts';
import type { Channel } from '../types.ts';
import { entryIdKey, type M3uEntry } from './parse.ts';

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
    // By the line as written (the URL with any pipe), as before pipes were read: ids and duplicates stay the same.
    const key = entryIdKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(e);
    if (e.tvgChno && e.tvgChno > maxChno) maxChno = e.tvgChno;
  }
  const usedIds = new Set<string>();
  let next = maxChno + 1;
  return unique.map((e) => {
    const ch: Channel = {
      id: uniqueId(`${sourceId}:${fnv1a(entryIdKey(e))}`, usedIds),
      sourceId,
      name: e.name,
      url: e.url,
      group: e.groupTitle ?? UNCATEGORIZED,
      number: e.tvgChno ?? next++,
    };
    if (e.tvgLogo) ch.logo = e.tvgLogo;
    if (e.tvgId) ch.epgId = e.tvgId;
    if (e.tvgShift) ch.epgShift = e.tvgShift;
    if (e.headers) ch.headers = { ...e.headers };
    return ch;
  });
}
