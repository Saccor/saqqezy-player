import { searchKey } from '../text/searchKey.ts';
import { VOD_ALL, type Episode, type VodCategory, type VodItem, type VodKind, type VodList, type VodSort } from './types.ts';

/** In-worker index over one stored catalogue. Sort orders are built on first use and cached per category. */
export class VodCatalog {
  private readonly ids: Map<string, VodItem>;
  private keys: string[] | undefined;
  private readonly orders = new Map<string, number[]>();

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
    return this.list.items.some((i) => i.added !== undefined);
  }

  categories(): VodCategory[] {
    return this.list.categories;
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
    const hits: { i: number; pos: number }[] = [];
    for (let i = 0; i < this.list.items.length; i++) {
      const pos = this.key(i).indexOf(q);
      if (pos >= 0) hits.push({ i, pos });
    }
    hits.sort((a, b) => a.pos - b.pos || this.byTitle(a.i, b.i));
    return hits.slice(0, cap).map((h) => this.list.items[h.i]!);
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

  private order(categoryId: string, sort: VodSort): number[] {
    const cacheKey = `${categoryId}|${sort}`;
    const cached = this.orders.get(cacheKey);
    if (cached) return cached;
    const items = this.list.items;
    const order: number[] = [];
    for (let i = 0; i < items.length; i++) if (categoryId === VOD_ALL || items[i]!.categoryId === categoryId) order.push(i);
    if (sort === 'title') order.sort((a, b) => this.byTitle(a, b));
    else if (sort === 'added') order.sort((a, b) => (items[b]!.added ?? -1) - (items[a]!.added ?? -1) || a - b);
    else order.sort((a, b) => (items[b]!.rating ?? -1) - (items[a]!.rating ?? -1) || this.byTitle(a, b));
    this.orders.set(cacheKey, order);
    return order;
  }
}
