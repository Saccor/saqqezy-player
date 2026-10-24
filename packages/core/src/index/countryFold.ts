import type { RegionMode } from '../settings.ts';
import { countryLabel } from '../text/regions.ts';

/**
 * Your countries with flags (spec 2026-10-22-your-countries-flags): the pure parts shared by Live TV groups
 * (`ChannelIndex`), movie/series categories (`vodCategoryView`), the phone companion and the TV pickers. One pass,
 * O(folders); no labels from `Intl` (Chromium 76).
 */

/** Each code's first index in the user's pick order. */
export function codeIndexOf(codes: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  codes.forEach((c, i) => { if (!out.has(c)) out.set(c, i); });
  return out;
}

/** A folder's rank among the picked codes: the lowest index of any of its keys; Infinity when none is picked. */
export function pickRank(keys: readonly string[], index: ReadonlyMap<string, number>): number {
  let best = Infinity;
  for (const k of keys) {
    const i = index.get(k);
    if (i !== undefined && i < best) best = i;
  }
  return best;
}

/** Other countries' folders fold: the setting is on, the rule is not `only`, and two or more keys were detected. */
export function foldActive(on: boolean, mode: RegionMode, distinctKeys: number): boolean {
  return on && mode !== 'only' && distinctKeys >= 2;
}

const byLabel = (a: string, b: string): number => {
  const la = countryLabel(a);
  const lb = countryLabel(b);
  return la < lb ? -1 : la > lb ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Splits folders (in provider order) into the folded ones, each under its first key, and the rest (no key). Countries
 * come most folders first, ties by label; inside a country, provider order. So a consumer can group them in one pass.
 */
export function splitFold<T>(items: readonly T[], keysOf: (t: T) => readonly string[]): { country: { item: T; key: string }[]; rest: T[] } {
  const byKey = new Map<string, T[]>();
  const rest: T[] = [];
  for (const item of items) {
    const key = keysOf(item)[0];
    if (key === undefined) { rest.push(item); continue; }
    let list = byKey.get(key);
    if (!list) byKey.set(key, (list = []));
    list.push(item);
  }
  const keys = [...byKey.keys()].sort((a, b) => byKey.get(b)!.length - byKey.get(a)!.length || byLabel(a, b));
  const country: { item: T; key: string }[] = [];
  for (const key of keys) for (const item of byKey.get(key)!) country.push({ item, key });
  return { country, rest };
}

/** One row of the "Other countries" list. `items`: channels (Live) or titles (VOD) in its folders. */
export interface FoldCountry { key: string; label: string; isLanguage: boolean; folders: number; items: number }

/**
 * The country list for a picker, from the entries `groups()` or `categories()` returned (only those with `fold`
 * count), most folders first, ties by label. Runs in the UI thread: one pass plus a sort of the keys.
 */
export function foldSummary(entries: readonly { fold?: string; count: number }[]): FoldCountry[] {
  const by = new Map<string, FoldCountry>();
  for (const e of entries) {
    if (e.fold === undefined) continue;
    let c = by.get(e.fold);
    if (!c) by.set(e.fold, (c = { key: e.fold, label: countryLabel(e.fold), isLanguage: e.fold.startsWith('lang:'), folders: 0, items: 0 }));
    c.folders++;
    c.items += e.count;
  }
  return [...by.values()].sort((a, b) => b.folders - a.folders || byLabel(a.key, b.key));
}
