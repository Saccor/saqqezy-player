/**
 * Per-group page cache for `getChannelSlice` (pages of 40 rows). Pure apart from the injected fetcher, so it
 * is unit-tested. `invalidate()` (after a refresh or a favourite/hide change) drops everything and makes
 * answers still in flight be ignored.
 */
export type SliceFetch<T> = (groupId: string, offset: number, count: number) => Promise<{ total: number; rows: T[] }>;

interface GroupPages<T> { total: number | undefined; pages: Map<number, T[]>; inflight: Map<number, Promise<void>> }

export class SliceCache<T extends { id: string }> {
  private groups = new Map<string, GroupPages<T>>();
  private generation = 0;

  constructor(
    private readonly fetch: SliceFetch<T>,
    private readonly pageSize = 40,
    private readonly onChange: () => void = () => { /* no listener */ },
  ) {}

  total(groupId: string): number | undefined {
    return this.groups.get(groupId)?.total;
  }

  row(groupId: string, index: number): T | undefined {
    const g = this.groups.get(groupId);
    if (!g || index < 0) return undefined;
    return g.pages.get(Math.floor(index / this.pageSize))?.[index % this.pageSize];
  }

  /** Index of a cached row with this id, or -1. */
  indexOfId(groupId: string, id: string): number {
    const g = this.groups.get(groupId);
    if (!g) return -1;
    for (const [page, rows] of g.pages) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) return page * this.pageSize + i;
    }
    return -1;
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
    for (let p = first; p <= last; p++) waits.push(this.load(groupId, g, p));
    await Promise.all(waits);
  }

  invalidate(): void {
    this.generation++;
    this.groups = new Map();
    this.onChange();
  }

  private group(groupId: string): GroupPages<T> {
    let g = this.groups.get(groupId);
    if (!g) {
      g = { total: undefined, pages: new Map(), inflight: new Map() };
      this.groups.set(groupId, g);
    }
    return g;
  }

  private load(groupId: string, g: GroupPages<T>, page: number): Promise<void> {
    if (g.pages.has(page)) return Promise.resolve();
    const running = g.inflight.get(page);
    if (running) return running;
    const gen = this.generation;
    const run = this.fetch(groupId, page * this.pageSize, this.pageSize).then(
      (res) => {
        g.inflight.delete(page);
        if (gen !== this.generation) return;
        g.total = res.total;
        g.pages.set(page, res.rows);
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
