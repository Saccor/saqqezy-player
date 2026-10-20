import { categoryBase, parseVodTitle, prefixLang } from './titleParse.ts';
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
  // Parsed once per category, not per item.
  const catLang = new Map(list.categories.map((c) => [c.id, prefixLang(c.name)]));
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
  const bases: string[] = new Array(items.length);
  const years: (number | undefined)[] = new Array(items.length);
  /** Base → the one year its dated items share, or NaN once they disagree. */
  const datedYear = new Map<string, number>();

  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const p = parseVodTitle(it.title);
    memberLang[i] = p.lang ?? catLang.get(it.categoryId);
    memberQuality[i] = p.quality;
    displays[i] = p.display;
    bases[i] = p.base;
    const year = it.year ?? p.year;
    years[i] = year;
    if (!it.tmdbId && year !== undefined) {
      const known = datedYear.get(p.base);
      if (known === undefined) datedYear.set(p.base, year);
      else if (known !== year) datedYear.set(p.base, NaN);
    }
  }

  // Keys are built once per group, not per item: items find their group through these maps.
  const byTmdb = new Map<string, number>();
  /** Base → year → group. A year-less item uses the only year of its base's dated items, if there is one. */
  const byYear = new Map<string, Map<number, number>>();
  const byBase = new Map<string, number>();
  const groupOf = new Int32Array(items.length);
  const groups: VodGroup[] = [];
  const newGroup = (key: string, lead: number): number => {
    groups.push({ key, members: [], lead, display: '', quality: 4, langs: [], categoryIds: [] });
    return groups.length - 1;
  };
  const checkSplits = splits.size > 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const base = bases[i]!;
    let year = years[i];
    if (!it.tmdbId && year === undefined) {
      const only = datedYear.get(base);
      if (only !== undefined && !Number.isNaN(only)) year = only;
    }
    let gi: number | undefined;
    if (checkSplits) {
      const natural = it.tmdbId ? `t:${it.tmdbId}` : year !== undefined ? `y:${base}|${year}` : `n:${base}`;
      if (splits.has(natural)) {
        gi = newGroup(`i:${it.id}`, i);
        groups[gi]!.splitFrom = natural;
      }
    }
    if (gi !== undefined) {
      // a split: its own group
    } else if (it.tmdbId) {
      const key = `t:${it.tmdbId}`;
      gi = byTmdb.get(key);
      if (gi === undefined) byTmdb.set(key, (gi = newGroup(key, i)));
    } else if (year !== undefined) {
      let ys = byYear.get(base);
      if (!ys) byYear.set(base, (ys = new Map()));
      gi = ys.get(year);
      if (gi === undefined) ys.set(year, (gi = newGroup(`y:${base}|${year}`, i)));
    } else {
      gi = byBase.get(base);
      if (gi === undefined) byBase.set(base, (gi = newGroup(`n:${base}`, i)));
    }
    groupOf[i] = gi;
    const g = groups[gi]!;
    g.members.push(i);
    if (better(i, g.lead)) g.lead = i;
    g.quality = Math.min(g.quality, memberQuality[i]!);
    const lang = memberLang[i];
    if (lang && !g.langs.includes(lang)) g.langs.push(lang);
    const cat = mergedOf(it.categoryId).id;
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
