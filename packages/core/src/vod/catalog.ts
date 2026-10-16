import { searchKey } from '../text/searchKey.ts';
import { buildVodSearchIndex, type VodSearchIndex } from './searchIndex.ts';
import { VOD_ALL, type Episode, type VodCategory, type VodItem, type VodKind, type VodList, type VodSort } from './types.ts';

/** In-worker index over one stored catalogue. Sort orders are built on first use and cached per category. */
export class VodCatalog {
  private readonly ids: Map<string, VodItem>;
  private keys: string[] | undefined;
  private added: boolean | undefined;
  private readonly orders = new Map<string, number[]>();
  /** Item indexes per category, built in one pass on first use. */
  private buckets: Map<string, number[]> | undefined;

  constructor(readonly kind: VodKind, private readonly list: VodList) {
    this.ids = new Map(list.items.map((i) => [i.id, i]));
  }

  get size(): number {
    return this.list.items.length;
  }

  get truncated(): boolean {
    return this.list.truncated === true;
  }

  /** False for most M3U catalogues: "Recently added" has nothing to sort by. */
  get hasAddedDates(): boolean {
    return (this.added ??= this.list.items.some((i) => i.added !== undefined));
  }

  categories(): VodCategory[] {
    return [...this.list.categories];
  }

  byId(id: string): VodItem | undefined {
    return this.ids.get(id);
  }

  episodes(seriesId: string): Episode[] | undefined {
    return this.list.episodes?.[seriesId];
  }

  slice(categoryId: string, sort: VodSort, offset: number, count: number): { total: number; rows: VodItem[] } {
    const order = this.order(categoryId, sort);
    const from = Math.max(0, offset);
    return { total: order.length, rows: order.slice(from, from + Math.max(0, count)).map((i) => this.list.items[i]!) };
  }

  recentlyAdded(n: number): VodItem[] {
    return this.slice(VOD_ALL, 'added', 0, n).rows;
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
    for (let i = 0; i < this.list.items.length; i++) {
      const pos = this.key(i).indexOf(q);
      if (pos < 0) continue;
      const hit = { i, pos };
      if (top.length === k && better(hit, top[k - 1]!) >= 0) continue;
      let at = top.length;
      while (at > 0 && better(hit, top[at - 1]!) < 0) at--;
      top.splice(at, 0, hit);
      if (top.length > k) top.pop();
    }
    return top.map((h) => this.list.items[h.i]!);
  }

  /**
   * The compact Search index of this catalogue (shares no storage with it). Reuses the search keys when this
   * catalogue already built them; otherwise they are built per chunk and dropped, not cached here.
   */
  searchIndex(): VodSearchIndex {
    const keys = this.keys;
    return buildVodSearchIndex(this.kind, this.list.items, keys ? (i) => keys[i]! : undefined);
  }

  private key(i: number): string {
    this.keys ??= this.list.items.map((it) => searchKey(it.title));
    return this.keys[i]!;
  }

  private byTitle(a: number, b: number): number {
    const ka = this.key(a);
    const kb = this.key(b);
    return ka < kb ? -1 : ka > kb ? 1 : a - b;
  }

  private bucket(categoryId: string): number[] {
    if (categoryId === VOD_ALL) return this.list.items.map((_, i) => i);
    if (!this.buckets) {
      const b = new Map<string, number[]>();
      this.list.items.forEach((it, i) => {
        const list = b.get(it.categoryId);
        if (list) list.push(i);
        else b.set(it.categoryId, [i]);
      });
      this.buckets = b;
    }
    // A copy: the caller sorts it.
    return [...(this.buckets.get(categoryId) ?? [])];
  }

  private order(categoryId: string, sort: VodSort): number[] {
    const cacheKey = `${categoryId}|${sort}`;
    const cached = this.orders.get(cacheKey);
    if (cached) return cached;
    const items = this.list.items;
    const order = this.bucket(categoryId);
    if (sort === 'title') order.sort((a, b) => this.byTitle(a, b));
    else if (sort === 'added') order.sort((a, b) => (items[b]!.added ?? -1) - (items[a]!.added ?? -1) || a - b);
    else order.sort((a, b) => (items[b]!.rating ?? -1) - (items[a]!.rating ?? -1) || this.byTitle(a, b));
    if (order.length) this.orders.set(cacheKey, order);
    return order;
  }
}
