// Trending rows (spec 2026-10-20-trending-design §3): a public feed of trending titles matched against the user's own
// catalogue, on the device. Only titles the user already has come out; the feed's other titles are never shown.
// Matching uses the exact keys VOD grouping builds (`VodGroup.key`): one Map lookup per key, no fuzzy scores.
import { parseVodTitle } from './titleParse.ts';
import type { VodKind } from './types.ts';

export interface TrendingFeedItem {
  /** 1-based, best first. */
  rank: number;
  /** Wikidata id. */
  wd: string;
  tmdb?: number;
  imdb?: string;
  year?: number;
  /** The title in the feed's language, the English title, then aliases. */
  titles: string[];
}

/** Feed format v1, one file per kind and language. */
export interface TrendingFeed {
  v: 1;
  kind: VodKind;
  lang: string;
  /** Build time, ISO 8601. */
  at: string;
  items: TrendingFeedItem[];
}

export const TRENDING_FEED_MAX = 150;
const TITLES_MAX = 8;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** A v1 feed of `kind`, with bad items and fields dropped and at most 150 items by rank; undefined when unusable. */
export function parseTrendingFeed(json: unknown, kind: VodKind): TrendingFeed | undefined {
  if (!isObj(json) || json.v !== 1 || json.kind !== kind || !Array.isArray(json.items)) return undefined;
  const items: TrendingFeedItem[] = [];
  for (const it of json.items) {
    if (!isObj(it) || !posInt(it.rank) || typeof it.wd !== 'string' || !it.wd || !Array.isArray(it.titles)) continue;
    const titles = it.titles.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, TITLES_MAX);
    if (!titles.length) continue;
    const item: TrendingFeedItem = { rank: it.rank, wd: it.wd, titles };
    if (posInt(it.tmdb)) item.tmdb = it.tmdb;
    if (typeof it.imdb === 'string' && /^tt\d+$/.test(it.imdb)) item.imdb = it.imdb;
    if (posInt(it.year) && it.year >= 1870 && it.year <= 2100) item.year = it.year;
    items.push(item);
  }
  items.sort((a, b) => a.rank - b.rank);
  return {
    v: 1, kind, lang: typeof json.lang === 'string' ? json.lang : '', at: typeof json.at === 'string' ? json.at : '',
    items: items.slice(0, TRENDING_FEED_MAX),
  };
}

/** What matching needs of a catalogue title; `VodGroup` has it. */
export interface TrendingCandidate {
  key: string;
  display: string;
  year?: number;
  /** A version shown separately: the key of the title it was split from. */
  splitFrom?: string;
}

/** Catalogue keys → group index. Built once per catalogue. */
export interface TrendingIndex {
  /** `t:`, `y:`, `n:` keys of the titles (own keys first, then the ones derived for tmdb-keyed titles). */
  readonly keys: ReadonlyMap<string, number>;
  /** `n:<base>` → the one dated title with that name (for feed items without a year). */
  readonly undated: ReadonlyMap<string, number>;
}

/**
 * Indexes a catalogue's titles. Every title is found by its own key (a split version by the key it was split from);
 * a title keyed by its tmdb id is also found by title and year; a name with exactly one dated title is found by name
 * for feed items that carry no year. The first title wins a key. Cost: O(titles); tmdb-keyed titles parse their
 * display name once.
 */
export function buildTrendingIndex(groups: readonly TrendingCandidate[]): TrendingIndex {
  const keys = new Map<string, number>();
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const key = g.splitFrom ?? g.key;
    if (!keys.has(key)) keys.set(key, i);
  }
  const dated = new Map<string, number>(); // base → group, or -1 when two dated titles share the base
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const key = g.splitFrom ?? g.key;
    let base: string | undefined;
    if (key.startsWith('t:')) {
      base = parseVodTitle(g.display).base;
      if (!base) continue;
      const derived = g.year !== undefined ? `y:${base}|${g.year}` : `n:${base}`;
      if (!keys.has(derived)) keys.set(derived, i);
      if (g.year === undefined) continue;
    } else if (key.startsWith('y:')) {
      base = key.slice(2, key.lastIndexOf('|'));
    } else continue;
    const cur = dated.get(base);
    dated.set(base, cur === undefined ? i : cur === i ? i : -1);
  }
  const undated = new Map<string, number>();
  for (const [base, i] of dated) if (i >= 0) undated.set(`n:${base}`, i);
  return { keys, undated };
}

/**
 * Per feed item: its title-and-year keys (exact year first, then ±1), how many of them are exact, and its `n:` key
 * when its names reduce to one base.
 */
interface ItemKeys { years: string[]; exact: number; name?: string }
const feedKeys = new WeakMap<TrendingFeed, ItemKeys[]>();

function keysOf(feed: TrendingFeed): ItemKeys[] {
  let all = feedKeys.get(feed);
  if (all) return all;
  all = feed.items.map((it) => {
    const exact: string[] = [];
    const near: string[] = [];
    const bases = new Set<string>();
    for (const title of it.titles) {
      const p = parseVodTitle(title);
      if (!p.base) continue;
      bases.add(p.base);
      const year = it.year ?? p.year;
      if (year === undefined) continue;
      exact.push(`y:${p.base}|${year}`);
      near.push(`y:${p.base}|${year - 1}`, `y:${p.base}|${year + 1}`);
    }
    const k: ItemKeys = { years: [...exact, ...near], exact: exact.length };
    if (bases.size === 1) k.name = `n:${bases.values().next().value}`;
    return k;
  });
  feedKeys.set(feed, all);
  return all;
}

/** One matched catalogue title. */
export interface TrendingHit {
  /** The group index. */
  group: number;
  /**
   * Matched by tmdb id or by title and the exact year (spec catalogue-personalisation-sync §5.2): only these are
   * numbered in a Top 10 row. A year off by one or the name alone is a weak match.
   */
  strong: boolean;
}

/**
 * The catalogue titles (group indexes) the feed names, in feed rank order, each at most once, at most `cap`.
 * Per item: its tmdb id, then title and year (exact, then ±1), then the name alone when the item is unambiguous
 * (a feed item with a year only reaches undated titles that way). Another kind's feed matches nothing.
 */
export function matchTrending(feed: TrendingFeed, kind: VodKind, index: TrendingIndex, cap = 20): number[] {
  return matchTrendingHits(feed, kind, index, cap).map((h) => h.group);
}

/** `matchTrending` with how strong each match is. */
export function matchTrendingHits(feed: TrendingFeed, kind: VodKind, index: TrendingIndex, cap = 20): TrendingHit[] {
  if (feed.kind !== kind || cap <= 0 || index.keys.size === 0) return [];
  const all = keysOf(feed);
  const out: TrendingHit[] = [];
  const used = new Set<number>();
  for (let n = 0; n < feed.items.length && out.length < cap; n++) {
    const it = feed.items[n]!;
    const k = all[n]!;
    let hit: number | undefined;
    let strong = false;
    if (it.tmdb !== undefined) hit = index.keys.get(`t:${it.tmdb}`);
    if (hit !== undefined) strong = true;
    for (let y = 0; hit === undefined && y < k.years.length; y++) {
      hit = index.keys.get(k.years[y]!);
      if (hit !== undefined) strong = y < k.exact;
    }
    if (hit === undefined && k.name) {
      hit = index.keys.get(k.name);
      if (hit === undefined && it.year === undefined) hit = index.undated.get(k.name);
    }
    if (hit === undefined || used.has(hit)) continue;
    used.add(hit);
    out.push({ group: hit, strong });
  }
  return out;
}
