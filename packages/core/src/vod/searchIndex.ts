import { searchKey } from '../text/searchKey.ts';
import type { VodItem, VodKind } from './types.ts';

/**
 * Strings packed end to end: entry i is `text.slice(end[i - 1] ?? 0, end[i])`. One flat string per column
 * instead of one string per title, so 50k titles cost their characters and 4 bytes each, not a heap object each.
 */
interface Packed { text: string; end: Uint32Array }

/**
 * A compact per-kind title index for Search: what a text-only result row needs (id, title, year, category) and the
 * search keys, built from one catalogue and holding no reference to it. Plain data. No posters: Search rows do not
 * draw them and the detail screen gets its own from its load (with posters, 50k + 10k titles measured 8.7 MB; without, about 6 MB).
 */
export interface VodSearchIndex {
  kind: VodKind;
  size: number;
  /** "\n" + key0 + "\n" + key1 + ... + "\n" (keys never contain "\n", so a match never spans two titles). */
  haystack: string;
  /** Start of key i in `haystack`; `keyAt[size]` is one past the last key's separator. */
  keyAt: Uint32Array;
  titles: Packed;
  /** The prefix every id shares (`<sourceId>:` in practice); `ids` holds the rest. */
  idPrefix: string;
  ids: Packed;
  /** 0 = unknown. */
  years: Uint16Array;
  categories: string[];
  category: Uint16Array | Uint32Array;
}

export interface VodIndexEntry { id: string; title: string; categoryId: string; year?: number }

function pack(n: number, at: (i: number) => string): Packed {
  const end = new Uint32Array(n);
  const parts = new Array<string>(n);
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const s = at(i);
    parts[i] = s;
    pos += s.length;
    end[i] = pos;
  }
  return { text: parts.join(''), end };
}

function unpack(p: Packed, i: number): string {
  return p.text.slice(i > 0 ? p.end[i - 1]! : 0, p.end[i]!);
}

function commonPrefix(items: readonly VodItem[]): string {
  if (!items.length) return '';
  // Up to the first ":" of the first id (the source id), when every id has it; else none.
  const first = items[0]!.id;
  const cut = first.indexOf(':');
  if (cut < 0) return '';
  const prefix = first.slice(0, cut + 1);
  return items.every((it) => it.id.startsWith(prefix)) ? prefix : '';
}

/** `keyOf(i)` lets a catalogue pass the search keys it already built (default: `searchKey(title)`). */
export function buildVodSearchIndex(kind: VodKind, items: readonly VodItem[], keyOf: (i: number) => string = (i) => searchKey(items[i]!.title)): VodSearchIndex {
  const n = items.length;
  const keyAt = new Uint32Array(n + 1);
  const keys = new Array<string>(n);
  let pos = 1;
  for (let i = 0; i < n; i++) {
    const k = keyOf(i);
    keys[i] = k;
    keyAt[i] = pos;
    pos += k.length + 1;
  }
  keyAt[n] = pos;
  const haystack = `\n${keys.join('\n')}\n`;

  const idPrefix = commonPrefix(items);
  const ids = pack(n, (i) => items[i]!.id.slice(idPrefix.length));
  const titles = pack(n, (i) => items[i]!.title);

  const years = new Uint16Array(n);
  const catIds = new Map<string, number>();
  const catOf = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const y = items[i]!.year;
    if (y !== undefined && Number.isInteger(y) && y > 0 && y < 65536) years[i] = y;
    const c = items[i]!.categoryId;
    let ci = catIds.get(c);
    if (ci === undefined) {
      ci = catIds.size;
      catIds.set(c, ci);
    }
    catOf[i] = ci;
  }
  const category = catIds.size <= 65536 ? Uint16Array.from(catOf) : Uint32Array.from(catOf);

  return {
    kind, size: n, haystack, keyAt, titles, idPrefix, ids, years, categories: [...catIds.keys()], category,
  };
}

export function vodIndexEntry(ix: VodSearchIndex, i: number): VodIndexEntry {
  const e: VodIndexEntry = { id: ix.idPrefix + unpack(ix.ids, i), title: unpack(ix.titles, i), categoryId: ix.categories[ix.category[i]!]! };
  if (ix.years[i]) e.year = ix.years[i]!;
  return e;
}

/** Compares the keys of items a and b in the haystack, as `<` on the key strings would. */
function compareKeys(ix: VodSearchIndex, a: number, b: number): number {
  const h = ix.haystack;
  let i = ix.keyAt[a]!;
  let j = ix.keyAt[b]!;
  const ea = ix.keyAt[a + 1]! - 1;
  const eb = ix.keyAt[b + 1]! - 1;
  for (; i < ea && j < eb; i++, j++) {
    const d = h.charCodeAt(i) - h.charCodeAt(j);
    if (d) return d;
  }
  return (ea - i) - (eb - j);
}

/**
 * Item indexes whose key contains `query` (by `searchKey`), best first: match position (a prefix match is 0), then
 * key, then list order — the ranking of `VodCatalog.search`. Bounded top-k: at most `cap` are ever kept sorted.
 */
export function searchVodIndex(ix: VodSearchIndex, query: string, cap: number): number[] {
  const q = searchKey(query);
  const k = Math.floor(cap);
  if (!q || !(k > 0) || ix.size === 0) return [];
  const h = ix.haystack;
  const better = (a: { i: number; pos: number }, b: { i: number; pos: number }) => a.pos - b.pos || compareKeys(ix, a.i, b.i) || a.i - b.i;
  const top: { i: number; pos: number }[] = [];
  let at = h.indexOf(q, 1);
  let t = 0;
  while (at !== -1) {
    // Match positions only grow: walk forward to the key that contains this one.
    while (ix.keyAt[t + 1]! <= at) t++;
    const hit = { i: t, pos: at - ix.keyAt[t]! };
    if (top.length < k || better(hit, top[k - 1]!) < 0) {
      let p = top.length;
      while (p > 0 && better(hit, top[p - 1]!) < 0) p--;
      top.splice(p, 0, hit);
      if (top.length > k) top.pop();
    }
    // The first match in a key is its best: skip to the next key.
    at = h.indexOf(q, ix.keyAt[t + 1]!);
  }
  return top.map((x) => x.i);
}

/** Bytes the index holds (strings at one byte per Latin-1 character, two otherwise), for the perf report. */
export function vodSearchIndexBytes(ix: VodSearchIndex): number {
  // eslint-disable-next-line no-control-regex
  const str = (s: string) => s.length * (/[^\u0000-ÿ]/.test(s) ? 2 : 1);
  const packed = (p: Packed) => str(p.text) + p.end.byteLength;
  const table = (xs: string[]) => xs.reduce((sum, s) => sum + str(s), 0);
  return str(ix.haystack) + ix.keyAt.byteLength + packed(ix.titles) + str(ix.idPrefix) + packed(ix.ids)
    + ix.years.byteLength + table(ix.categories) + ix.category.byteLength;
}
