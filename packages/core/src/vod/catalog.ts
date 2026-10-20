import { searchKey } from '../text/searchKey.ts';
import type { VodGroup, VodGroups } from './grouping.ts';
import { buildVodSearchIndex, type VodSearchIndex } from './searchIndex.ts';
import type { VodCategoryView } from './layout.ts';
import { QUALITY_UNKNOWN } from './titleParse.ts';
import { VOD_ALL, type Episode, type VodCategory, type VodItem, type VodKind, type VodList, type VodSort } from './types.ts';

/** One version of a title. */
export interface VodMember { item: VodItem; lang?: string; quality: number }

/**
 * In-worker index over one stored catalogue. Sort orders are built on first use and cached per category.
 * With groups (`withGroups`), every list operation (size, categories, slices, search) works on one row per title:
 * the lead version's item with the title's display name, newest `added` and best `rating`. `byId` still finds every
 * version; `groupOf` / `rowOf` / `members` resolve any version to its title.
 */
export class VodCatalog {
  private readonly ids: Map<string, VodItem>;
  /** Item id → index in `list.items`. Built on first grouped lookup. */
  private indexOf: Map<string, number> | undefined;
  private readonly rows: VodItem[];
  private keys: string[] | undefined;
  private added: boolean | undefined;
  private rated: number | undefined;
  private readonly orders = new Map<string, number[]>();
  /** Row indexes per category, built in one pass on first use. */
  private buckets: Map<string, number[]> | undefined;
  /** With a view: 1 for rows listed in at least one visible category. */
  private readonly visibleRows: Uint8Array | undefined;
  private readonly visibleCount: number;

  constructor(
    readonly kind: VodKind, private readonly list: VodList, private readonly groups?: VodGroups, ids?: Map<string, VodItem>,
    private readonly view?: VodCategoryView,
  ) {
    this.ids = ids ?? new Map(list.items.map((i) => [i.id, i]));
    this.rows = groups ? groups.groups.map((g) => groupRow(list.items, g)) : list.items;
    this.visibleCount = this.rows.length;
    if (view && view.hidden.size) {
      const vis = new Uint8Array(this.rows.length);
      let n = 0;
      for (let i = 0; i < this.rows.length; i++) {
        const cats = groups ? groups.groups[i]!.categoryIds : [this.rows[i]!.categoryId];
        if (cats.some((c) => !view.hidden.has(c))) { vis[i] = 1; n++; }
      }
      this.visibleRows = vis;
      this.visibleCount = n;
    }
  }

  /** The same stored list seen with `groups` (or plain, when undefined). Shares the id map; caches start empty. */
  withGroups(groups: VodGroups | undefined): VodCatalog {
    return new VodCatalog(this.kind, this.list, groups, this.ids, this.view);
  }

  /**
   * The same catalogue seen through a category view (`vodCategoryView`): `categories()` lists the visible ones in view
   * order; All, category slices, size and search leave out titles listed only in hidden categories. `byId`, `rowOf`
   * and `members` still find everything (Continue watching, favourites and versions never disappear).
   */
  withView(view: VodCategoryView | undefined): VodCatalog {
    return new VodCatalog(this.kind, this.list, this.groups, this.ids, view);
  }

  private visible(i: number): boolean {
    return this.visibleRows === undefined || this.visibleRows[i] === 1;
  }

  get grouped(): boolean {
    return this.groups !== undefined;
  }

  /** The titles this catalogue was grouped into, when grouped. */
  get titleGroups(): VodGroups | undefined {
    return this.groups;
  }

  /** The stored list this catalogue reads (grouping is rebuilt from it). */
  get source(): VodList {
    return this.list;
  }

  get size(): number {
    return this.visibleCount;
  }

  get truncated(): boolean {
    return this.list.truncated === true;
  }

  /** Some categories could not be fetched. */
  get partial(): boolean {
    return this.list.partial === true;
  }

  /** False for most M3U catalogues: "Recently added" has nothing to sort by. */
  get hasAddedDates(): boolean {
    return (this.added ??= this.rows.some((i) => i.added !== undefined));
  }

  categories(): VodCategory[] {
    const all = this.groups ? this.groups.categories : this.list.categories;
    if (!this.view) return [...all];
    const byId = new Map(all.map((c) => [c.id, c]));
    return this.view.order.flatMap((id) => byId.get(id) ?? []);
  }

  byId(id: string): VodItem | undefined {
    return this.ids.get(id);
  }

  /** The title `id` (any version) belongs to; undefined when not grouped or unknown. */
  groupOf(id: string): VodGroup | undefined {
    if (!this.groups) return undefined;
    const i = this.itemIndex(id);
    return i === undefined ? undefined : this.groups.groups[this.groups.groupOf[i]!];
  }

  /** The row (card) that shows `id`: its title's row when grouped, else the item itself. */
  rowOf(id: string): VodItem | undefined {
    if (!this.groups) return this.ids.get(id);
    const i = this.itemIndex(id);
    return i === undefined ? undefined : this.rows[this.groups.groupOf[i]!];
  }

  /** Every version of the title `id` belongs to, list order (just the item itself when not grouped). */
  members(id: string): VodMember[] {
    const g = this.groupOf(id);
    if (!g || !this.groups) {
      const item = this.ids.get(id);
      return item ? [{ item, quality: QUALITY_UNKNOWN }] : [];
    }
    const { memberLang, memberQuality } = this.groups;
    return g.members.map((i) => {
      const m: VodMember = { item: this.list.items[i]!, quality: memberQuality[i]! };
      const lang = memberLang[i];
      if (lang) m.lang = lang;
      return m;
    });
  }

  episodes(seriesId: string): Episode[] | undefined {
    return this.list.episodes?.[seriesId];
  }

  slice(categoryId: string, sort: VodSort, offset: number, count: number): { total: number; rows: VodItem[] } {
    const order = this.order(categoryId, sort);
    const from = Math.max(0, offset);
    return { total: order.length, rows: order.slice(from, from + Math.max(0, count)).map((i) => this.rows[i]!) };
  }

  recentlyAdded(n: number): VodItem[] {
    return this.slice(VOD_ALL, 'added', 0, n).rows;
  }

  /** The best-rated titles (at most `n`; unrated ones never) and how many titles have a rating at all. */
  topRated(n: number): { rows: VodItem[]; rated: number } {
    this.rated ??= this.rows.reduce((k, it, i) => (it.rating === undefined || !this.visible(i) ? k : k + 1), 0);
    const take = Math.min(Math.max(0, Math.floor(n)), this.rated);
    // The rating order puts unrated titles last, so the first `rated` entries are exactly the rated ones.
    return { rows: take ? this.slice(VOD_ALL, 'rating', 0, take).rows : [], rated: this.rated };
  }

  /** Substring match on `searchKey`, ranked by match position, then title, then list order. */
  search(query: string, cap: number): VodItem[] {
    const q = searchKey(query);
    if (!q) return [];
    const k = Math.floor(cap);
    if (!(k > 0)) return [];
    // Bounded top-k: `top` stays sorted best-first and never grows past k, so a keystroke never sorts every hit.
    const better = (a: { i: number; pos: number }, b: { i: number; pos: number }) => a.pos - b.pos || this.byTitle(a.i, b.i);
    const top: { i: number; pos: number }[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      if (!this.visible(i)) continue;
      const pos = this.key(i).indexOf(q);
      if (pos < 0) continue;
      const hit = { i, pos };
      if (top.length === k && better(hit, top[k - 1]!) >= 0) continue;
      let at = top.length;
      while (at > 0 && better(hit, top[at - 1]!) < 0) at--;
      top.splice(at, 0, hit);
      if (top.length > k) top.pop();
    }
    return top.map((h) => this.rows[h.i]!);
  }

  /**
   * The compact Search index of this catalogue (shares no storage with it). Reuses the search keys when this
   * catalogue already built them; otherwise they are built per chunk and dropped, not cached here.
   */
  searchIndex(): VodSearchIndex {
    const keys = this.keys;
    return buildVodSearchIndex(this.kind, this.rows, keys ? (i) => keys[i]! : undefined);
  }

  private itemIndex(id: string): number | undefined {
    this.indexOf ??= new Map(this.list.items.map((it, i) => [it.id, i]));
    return this.indexOf.get(id);
  }

  private key(i: number): string {
    this.keys ??= this.rows.map((it) => searchKey(it.title));
    return this.keys[i]!;
  }

  private byTitle(a: number, b: number): number {
    const ka = this.key(a);
    const kb = this.key(b);
    return ka < kb ? -1 : ka > kb ? 1 : a - b;
  }

  private bucket(categoryId: string): number[] {
    if (categoryId === VOD_ALL) {
      const out: number[] = [];
      for (let i = 0; i < this.rows.length; i++) if (this.visible(i)) out.push(i);
      return out;
    }
    if (this.view?.hidden.has(categoryId)) return [];
    if (!this.buckets) {
      const b = new Map<string, number[]>();
      const put = (cat: string, i: number) => {
        const list = b.get(cat);
        if (list) list.push(i);
        else b.set(cat, [i]);
      };
      if (this.groups) this.groups.groups.forEach((g, i) => { for (const cat of g.categoryIds) put(cat, i); });
      else this.rows.forEach((it, i) => put(it.categoryId, i));
      this.buckets = b;
    }
    // A copy: the caller sorts it.
    return [...(this.buckets.get(categoryId) ?? [])];
  }

  private order(categoryId: string, sort: VodSort): number[] {
    const cacheKey = `${categoryId}|${sort}`;
    const cached = this.orders.get(cacheKey);
    if (cached) return cached;
    const items = this.rows;
    const order = this.bucket(categoryId);
    if (sort === 'title') order.sort((a, b) => this.byTitle(a, b));
    else if (sort === 'provider') { /* bucket order is list order */ }
    else if (sort === 'added') order.sort((a, b) => (items[b]!.added ?? -1) - (items[a]!.added ?? -1) || a - b);
    else order.sort((a, b) => (items[b]!.rating ?? -1) - (items[a]!.rating ?? -1) || this.byTitle(a, b));
    if (order.length) this.orders.set(cacheKey, order);
    return order;
  }
}

/** A title's card: the lead's item, its display name, the newest `added` and the best `rating` of its versions. */
function groupRow(items: readonly VodItem[], g: VodGroup): VodItem {
  const lead = items[g.lead]!;
  const row: VodItem = { ...lead, title: g.display, categoryId: g.categoryIds[0] ?? lead.categoryId };
  if (g.year !== undefined) row.year = g.year;
  let added: number | undefined;
  let rating: number | undefined;
  for (const m of g.members) {
    const it = items[m]!;
    if (it.added !== undefined && (added === undefined || it.added > added)) added = it.added;
    if (it.rating !== undefined && (rating === undefined || it.rating > rating)) rating = it.rating;
  }
  if (added !== undefined) row.added = added;
  if (rating !== undefined) row.rating = rating;
  if (!row.poster) {
    const withPoster = g.members.find((m) => items[m]!.poster);
    if (withPoster !== undefined) row.poster = items[withPoster]!.poster!;
  }
  return row;
}
