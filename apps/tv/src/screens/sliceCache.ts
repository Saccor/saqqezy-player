/**
 * Bounded, expiring page cache for `getChannelSlice` (pages of 40 rows). Pure apart from the injected fetcher
 * and clock, so it is unit-tested.
 *
 * - Per group, at most `maxPages` pages are kept in LRU order: every `ensure` marks the pages of its window as
 *   most recent, so the pages around the latest requested window survive.
 * - Only the current group (the latest `ensure`) and the previous one are kept; older groups are dropped.
 * - A page expires once a row's `now` programme that was still running when it was fetched has ended.
 *   `invalidateStale` marks such pages in a window; the next `ensure` refetches them, and the old rows stay
 *   readable until the fresh page arrives.
 * - `invalidateRows(ids)` marks the pages holding those channels (worker `nowNextUpdated`) the same way.
 * - `invalidate()` (after a refresh or a favourite/hide change) drops everything and makes answers still in
 *   flight be ignored.
 */
export type SliceFetch<T> = (groupId: string, offset: number, count: number) => Promise<{ total: number; rows: T[] }>;

export interface SliceCacheOptions {
  /** Pages kept per group (default 6). */
  maxPages?: number;
  /** Clock for expiry (default `Date.now`). */
  now?: () => number;
}

interface Page<T> { rows: T[]; expiresAt: number; stale: boolean }
interface GroupPages<T> { total: number | undefined; pages: Map<number, Page<T>>; inflight: Map<number, Promise<void>> }

const KEPT_GROUPS = 2;

export class SliceCache<T extends { id: string; now?: { stop: number } }> {
  /** Most recent group first. */
  private groups = new Map<string, GroupPages<T>>();
  private generation = 0;
  private readonly maxPages: number;
  private readonly now: () => number;

  constructor(
    private readonly fetch: SliceFetch<T>,
    private readonly pageSize = 40,
    private readonly onChange: () => void = () => { /* no listener */ },
    options: SliceCacheOptions = {},
  ) {
    this.maxPages = Math.max(1, options.maxPages ?? 6);
    this.now = options.now ?? Date.now;
  }

  total(groupId: string): number | undefined {
    return this.groups.get(groupId)?.total;
  }

  row(groupId: string, index: number): T | undefined {
    const g = this.groups.get(groupId);
    if (!g || index < 0) return undefined;
    return g.pages.get(Math.floor(index / this.pageSize))?.rows[index % this.pageSize];
  }

  /** Pages currently held for a group. */
  pageCount(groupId: string): number {
    return this.groups.get(groupId)?.pages.size ?? 0;
  }

  /** Loads every page touching rows [from, to). Without a known total only the first page is fetched first. */
  async ensure(groupId: string, from: number, to: number): Promise<void> {
    const g = this.group(groupId);
    if (g.total === undefined) {
      await this.load(groupId, g, 0);
      if (this.groups.get(groupId) !== g) return;
    }
    const total = g.total ?? 0;
    const end = Math.min(to, total);
    if (end <= from) return;
    const first = Math.floor(Math.max(0, from) / this.pageSize);
    const last = Math.floor((end - 1) / this.pageSize);
    const waits: Promise<void>[] = [];
    for (let p = first; p <= last; p++) {
      this.touch(g, p);
      waits.push(this.load(groupId, g, p));
    }
    await Promise.all(waits);
  }

  /** Marks the pages touching rows [from, to) whose programmes have rolled over. Returns how many. */
  invalidateStale(groupId: string, from: number, to: number): number {
    const g = this.groups.get(groupId);
    if (!g || to <= from) return 0;
    const t = this.now();
    const first = Math.floor(Math.max(0, from) / this.pageSize);
    const last = Math.floor((to - 1) / this.pageSize);
    let n = 0;
    for (const [p, page] of g.pages) {
      if (p < first || p > last || page.stale || page.expiresAt > t) continue;
      page.stale = true;
      n++;
    }
    return n;
  }

  /**
   * Marks every held page (any group) that contains one of `ids` as stale, e.g. after the worker announced new
   * now/next for those channels. The rows stay readable; the next `ensure` over them refetches. Returns how many.
   */
  invalidateRows(ids: Iterable<string>): number {
    const wanted = new Set(ids);
    if (wanted.size === 0) return 0;
    let n = 0;
    for (const g of this.groups.values()) {
      for (const page of g.pages.values()) {
        if (page.stale || !page.rows.some((r) => wanted.has(r.id))) continue;
        page.stale = true;
        n++;
      }
    }
    return n;
  }

  invalidate(): void {
    this.generation++;
    this.groups = new Map();
    this.onChange();
  }

  /** The group's pages, making it the current group and dropping all but the previous one. */
  private group(groupId: string): GroupPages<T> {
    let g = this.groups.get(groupId);
    if (g) this.groups.delete(groupId);
    else g = { total: undefined, pages: new Map(), inflight: new Map() };
    this.groups = new Map([[groupId, g], ...this.groups]);
    if (this.groups.size > KEPT_GROUPS) this.groups = new Map([...this.groups].slice(0, KEPT_GROUPS));
    return g;
  }

  /** Marks a page as most recently used. */
  private touch(g: GroupPages<T>, page: number): void {
    const p = g.pages.get(page);
    if (!p) return;
    g.pages.delete(page);
    g.pages.set(page, p);
  }

  private evict(g: GroupPages<T>): void {
    for (const page of g.pages.keys()) {
      if (g.pages.size <= this.maxPages) return;
      g.pages.delete(page);
    }
  }

  /** The earliest end of a programme that was still running at `fetchedAt` (Infinity when none). */
  private expiry(rows: readonly T[], fetchedAt: number): number {
    let at = Infinity;
    for (const r of rows) {
      const stop = r.now?.stop;
      if (stop !== undefined && stop > fetchedAt && stop < at) at = stop;
    }
    return at;
  }

  private load(groupId: string, g: GroupPages<T>, page: number): Promise<void> {
    const cached = g.pages.get(page);
    if (cached && !cached.stale) return Promise.resolve();
    const running = g.inflight.get(page);
    if (running) return running;
    const gen = this.generation;
    const run = this.fetch(groupId, page * this.pageSize, this.pageSize).then(
      (res) => {
        g.inflight.delete(page);
        if (gen !== this.generation || this.groups.get(groupId) !== g) return;
        g.total = res.total;
        g.pages.delete(page);
        g.pages.set(page, { rows: res.rows, expiresAt: this.expiry(res.rows, this.now()), stale: false });
        this.evict(g);
        this.onChange();
      },
      (err: unknown) => {
        g.inflight.delete(page);
        throw err;
      },
    );
    g.inflight.set(page, run);
    return run;
  }
}
