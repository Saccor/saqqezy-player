import { categoryBase, parseVodTitle } from './titleParse.ts';
import type { VodCategory, VodList } from './types.ts';

/** One title: every catalogue item that is a version of it. */
export interface VodGroup {
  /** `t:<tmdb>`, `y:<base>|<year>`, `n:<base>`, or `i:<itemId>` for a title shown separately. Stable across refreshes. */
  key: string;
  /** Item indexes, in list order. */
  members: number[];
  /** The member whose poster and id the card uses: best quality, then has a poster, then list order. */
  lead: number;
  /** The lead's title without prefixes and tags. */
  display: string;
  year?: number;
  /** Best quality rank among members. */
  quality: number;
  /** Distinct member languages, in list order. */
  langs: string[];
  /** Merged category ids (`c:<base>`), in member order. */
  categoryIds: string[];
  /** A version shown separately: the key of the title it was split from ("Combine again" removes that split). */
  splitFrom?: string;
}

export interface VodGroups {
  /** Item index → group index. */
  groupOf: Int32Array;
  groups: VodGroup[];
  /** Merged categories (count = groups in it), in the list's category order. */
  categories: VodCategory[];
  /** Per item: its language, if detected. */
  memberLang: (string | undefined)[];
  /** Per item: its quality rank. */
  memberQuality: Uint8Array;
}

export const mergedCategoryId = (base: string): string => `c:${base}`;

/**
 * Groups a catalogue's items by exact keys only (a TMDB id, else title and year): versions that differ in
 * language, quality or tags merge; a different year or number never does. Keys in `splits` are not grouped.
 * One pass over the items plus one over the year-less ones; no pairwise comparison.
 */
export function groupVod(list: VodList, splits: ReadonlySet<string> = new Set()): VodGroups {
  const { items } = list;
  const kind = items[0]?.kind ?? list.categories[0]?.kind ?? 'movie';
  const catName = new Map(list.categories.map((c) => [c.id, c.name]));
  const catMerged = new Map<string, { id: string; name: string }>();
  const mergedOf = (categoryId: string) => {
    let m = catMerged.get(categoryId);
    if (!m) {
      const name = catName.get(categoryId) ?? categoryId;
      const cb = categoryBase(name);
      m = { id: mergedCategoryId(cb.base || categoryId), name: cb.display };
      catMerged.set(categoryId, m);
    }
    return m;
  };

  const memberLang: (string | undefined)[] = new Array(items.length);
  const memberQuality = new Uint8Array(items.length);
  const displays: string[] = new Array(items.length);
  const keys: string[] = new Array(items.length);
  const years: (number | undefined)[] = new Array(items.length);
  const yearless: number[] = [];
  /** Base → the distinct years of its dated items. */
  const datedYears = new Map<string, Set<number>>();

  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const p = parseVodTitle(it.title, catName.get(it.categoryId));
    memberLang[i] = p.lang;
    memberQuality[i] = p.quality;
    displays[i] = p.display;
    const year = it.year ?? p.year;
    years[i] = year;
    if (it.tmdbId) keys[i] = `t:${it.tmdbId}`;
    else if (year !== undefined) {
      keys[i] = `y:${p.base}|${year}`;
      let ys = datedYears.get(p.base);
      if (!ys) datedYears.set(p.base, (ys = new Set()));
      ys.add(year);
    } else {
      keys[i] = p.base;
      yearless.push(i);
    }
  }
  for (const i of yearless) {
    const base = keys[i]!;
    const ys = datedYears.get(base);
    keys[i] = ys && ys.size === 1 ? `y:${base}|${ys.values().next().value}` : `n:${base}`;
  }

  const groupOf = new Int32Array(items.length);
  const groups: VodGroup[] = [];
  const byKey = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    const natural = keys[i]!;
    const split = splits.has(natural);
    const key = split ? `i:${items[i]!.id}` : natural;
    let gi = byKey.get(key);
    if (gi === undefined) {
      gi = groups.length;
      byKey.set(key, gi);
      const g: VodGroup = { key, members: [], lead: i, display: '', quality: 4, langs: [], categoryIds: [] };
      if (split) g.splitFrom = natural;
      groups.push(g);
    }
    groupOf[i] = gi;
    const g = groups[gi]!;
    g.members.push(i);
    if (better(i, g.lead)) g.lead = i;
    g.quality = Math.min(g.quality, memberQuality[i]!);
    const lang = memberLang[i];
    if (lang && !g.langs.includes(lang)) g.langs.push(lang);
    const cat = mergedOf(items[i]!.categoryId).id;
    if (!g.categoryIds.includes(cat)) g.categoryIds.push(cat);
  }

  function better(a: number, b: number): boolean {
    if (memberQuality[a]! !== memberQuality[b]!) return memberQuality[a]! < memberQuality[b]!;
    const pa = items[a]!.poster ? 1 : 0;
    const pb = items[b]!.poster ? 1 : 0;
    return pa !== pb ? pa > pb : a < b;
  }

  const counts = new Map<string, number>();
  for (const g of groups) {
    g.display = displays[g.lead]!;
    const year = years[g.lead] ?? g.members.map((m) => years[m]).find((y) => y !== undefined);
    if (year !== undefined) g.year = year;
    for (const c of g.categoryIds) counts.set(c, (counts.get(c) ?? 0) + 1);
  }

  const categories: VodCategory[] = [];
  const seen = new Set<string>();
  const add = (categoryId: string) => {
    const m = mergedOf(categoryId);
    if (seen.has(m.id) || !counts.has(m.id)) return;
    seen.add(m.id);
    categories.push({ id: m.id, kind, name: m.name, count: counts.get(m.id)! });
  };
  for (const c of list.categories) add(c.id);
  for (const it of items) add(it.categoryId);

  return { groupOf, groups, categories, memberLang, memberQuality };
}
