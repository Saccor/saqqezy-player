/**
 * Bounded, expiring cache for `getEpgRows` pages, mirroring `SliceCache`. Pure apart from the injected fetcher
 * and clock, so it is unit-tested.
 *
 * - An entry is one page of `rowsPerPage` channels x one `chunkMs`-aligned time chunk (fetched as
 *   `getEpgRows(group, page * rowsPerPage, rowsPerPage, chunkStart, chunkStart + chunkMs)`).
 * - At most `maxEntries` entries in LRU order: every `ensure` marks the entries of its window as most recent.
 * - One group at a time: `setGroup` to another group (and `invalidate()`) drops everything and makes answers
 *   still in flight be ignored.
 * - An entry older than `maxAgeMs` is refetched by the next `ensure`; its rows stay readable until then.
 * - Every stale mark (`staleAll`, `stalePage`, `staleChannels`) starts a new stale epoch: a request still in flight
 *   from an older epoch is not shared by later `ensure` calls (it may predate the change), and its answer is stored
 *   stale, so the next `ensure` fetches again. An older answer never replaces a newer one.
 */
import { lruSet } from '@iptv/core';
import { chunkStarts, pageRange, type TimeRange } from './guideLogic.ts';

export interface EpgRowData<C, P> { channel: C; programmes: P[] }
export type EpgFetch<C, P> = (groupId: string, offset: number, count: number, from: number, to: number) =>
  Promise<{ total: number; rows: EpgRowData<C, P>[] }>;
/** What changed: everything (another group, an invalidate), or some pages' rows (and whether the row count moved). */
export type EpgChange = { all: true } | { all: false; pages: number[]; totalChanged: boolean };

export interface EpgCacheOptions {
  /** Channels per page (default 20). */
  rowsPerPage?: number;
  /** Time chunk per request (default 3 h). */
  chunkMs?: number;
  /** Entries kept (default 24). */
  maxEntries?: number;
  /** Age after which an entry is refetched (default 15 min). */
  maxAgeMs?: number;
  /** Clock for expiry (default `Date.now`). */
  now?: () => number;
  /** Called whenever the cached data changes, with what changed. */
  onChange?: (change: EpgChange) => void;
}

interface Entry<C, P> { page: number; chunk: number; rows: EpgRowData<C, P>[]; fetchedAt: number; epoch: number }
interface Inflight { run: Promise<void>; epoch: number }

export class EpgCache<C, P extends { start: number; stop: number }> {
  private groupId: string | undefined;
  private totalRows: number | undefined;
  /** Least recently used first. */
  private entries = new Map<string, Entry<C, P>>();
  private inflight = new Map<string, Inflight>();
  private generation = 0;
  /** Bumped by every stale mark (see the class comment). */
  private epoch = 0;
  private readonly rowsPerPage: number;
  private readonly chunkMs: number;
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly onChange: (change: EpgChange) => void;

  constructor(private readonly fetch: EpgFetch<C, P>, options: EpgCacheOptions = {}) {
    this.rowsPerPage = Math.max(1, options.rowsPerPage ?? 20);
    this.chunkMs = options.chunkMs ?? 3 * 3_600_000;
    this.maxEntries = Math.max(1, options.maxEntries ?? 24);
    this.maxAgeMs = options.maxAgeMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange ?? (() => { /* no listener */ });
  }

  group(): string | undefined {
    return this.groupId;
  }

  /**
   * Switches to `groupId`; a different group drops all cached pages. `knownTotal` (e.g. the group's channel count)
   * saves the request that would otherwise fetch page 0 just to learn the total; the first answer corrects it.
   */
  setGroup(groupId: string, knownTotal?: number): void {
    if (groupId === this.groupId) return;
    this.groupId = groupId;
    this.clear();
    this.totalRows = knownTotal;
    // Notify only once the known total is in place: a listener that reads `total()` right away must see it, since the
    // first answer that confirms it reports no change in the total.
    this.onChange({ all: true });
  }

  invalidate(): void {
    this.clear();
    this.onChange({ all: true });
  }

  private clear(): void {
    this.generation++;
    this.totalRows = undefined;
    this.entries = new Map();
    this.inflight = new Map();
  }

  total(): number | undefined {
    return this.totalRows;
  }

  /**
   * Marks the loaded chunks of row `index`'s page stale: they stay on screen, and the next `ensure` refetches them
   * (a catch-up row whose archive listings arrived).
   */
  stalePage(index: number): void {
    const page = Math.floor(index / this.rowsPerPage);
    this.epoch++;
    for (const e of this.entries.values()) if (e.page === page) e.fetchedAt = Number.NEGATIVE_INFINITY;
  }

  /**
   * Marks stale every cached page holding one of `ids` (rows on screen or not; e.g. the playing channel's now/next
   * arrived). Returns how many pages were marked. Rows stay readable until the next `ensure` refetches them.
   */
  staleChannels(ids: Iterable<string>, idOf: (channel: C) => string): number {
    const wanted = new Set(ids);
    if (wanted.size === 0) return 0;
    // A page in flight may hold one of them too (its channels are unknown until it lands): it is stored stale.
    this.epoch++;
    const pages = new Set<number>();
    for (const e of this.entries.values()) {
      if (e.rows.some((r) => wanted.has(idOf(r.channel)))) pages.add(e.page);
    }
    for (const e of this.entries.values()) if (pages.has(e.page)) e.fetchedAt = Number.NEGATIVE_INFINITY;
    return pages.size;
  }

  /** Marks every entry stale without dropping it (a refresh): the grid keeps its rows until the refetch lands. */
  staleAll(): void {
    this.epoch++;
    for (const e of this.entries.values()) e.fetchedAt = Number.NEGATIVE_INFINITY;
  }

  entryCount(): number {
    return this.entries.size;
  }

  /** The channel of row `index` (from the most recent entry of its page). */
  channel(index: number): C | undefined {
    const page = Math.floor(index / this.rowsPerPage);
    let found: C | undefined;
    for (const e of this.entries.values()) {
      if (e.page === page) found = e.rows[index - page * this.rowsPerPage]?.channel ?? found;
    }
    return found;
  }

  /** Programmes of row `index` from every loaded chunk, in start order, each once. */
  programmes(index: number): P[] {
    const page = Math.floor(index / this.rowsPerPage);
    const byKey = new Map<string, P>();
    for (const e of this.entries.values()) {
      if (e.page !== page) continue;
      for (const p of e.rows[index - page * this.rowsPerPage]?.programmes ?? []) byKey.set(`${p.start}:${p.stop}`, p);
    }
    return [...byKey.values()].sort((a, b) => a.start - b.start);
  }

  /** Time chunks loaded for row `index`'s page, in start order. */
  covered(index: number): TimeRange[] {
    const page = Math.floor(index / this.rowsPerPage);
    return [...this.entries.values()]
      .filter((e) => e.page === page)
      .map((e) => ({ start: e.chunk, end: e.chunk + this.chunkMs }))
      .sort((a, b) => a.start - b.start);
  }

  /** Loads every entry touching rows [rowFrom, rowTo) x time [timeFrom, timeTo). */
  async ensure(rowFrom: number, rowTo: number, timeFrom: number, timeTo: number): Promise<void> {
    const g = this.groupId;
    if (g === undefined) return;
    const chunks = chunkStarts({ start: timeFrom, end: timeTo }, this.chunkMs);
    const first = chunks[0];
    if (first === undefined) return;
    const gen = this.generation;
    if (this.totalRows === undefined) {
      await this.load(g, 0, first);
      if (gen !== this.generation) return;
    }
    const pages = pageRange(rowFrom, Math.min(rowTo, this.totalRows ?? 0), this.rowsPerPage);
    const waits: Promise<void>[] = [];
    for (const p of pages) {
      for (const c of chunks) {
        this.touch(p, c);
        waits.push(this.load(g, p, c));
      }
    }
    await Promise.all(waits);
  }

  private key(page: number, chunk: number): string {
    return `${page}:${chunk}`;
  }

  private touch(page: number, chunk: number): void {
    const k = this.key(page, chunk);
    const e = this.entries.get(k);
    if (!e) return;
    this.entries.delete(k);
    this.entries.set(k, e);
  }

  private load(groupId: string, page: number, chunk: number): Promise<void> {
    const k = this.key(page, chunk);
    const cached = this.entries.get(k);
    if (cached && this.now() - cached.fetchedAt < this.maxAgeMs) return Promise.resolve();
    const running = this.inflight.get(k);
    if (running && running.epoch === this.epoch) return running.run;
    const gen = this.generation;
    const epoch = this.epoch;
    const inflight = this.inflight;
    const done = () => { if (inflight.get(k)?.run === run) inflight.delete(k); };
    const run: Promise<void> = this.fetch(groupId, page * this.rowsPerPage, this.rowsPerPage, chunk, chunk + this.chunkMs).then(
      (res) => {
        done();
        if (gen !== this.generation) return;
        const old = this.entries.get(k);
        if (old && old.epoch > epoch) return; // a newer answer already landed
        const totalChanged = this.totalRows !== res.total;
        this.totalRows = res.total;
        // A request older than the last stale mark may predate the change: readable, but fetched again.
        const fetchedAt = epoch === this.epoch ? this.now() : Number.NEGATIVE_INFINITY;
        const pages = [page];
        lruSet(this.entries, k, { page, chunk, rows: res.rows, fetchedAt, epoch }, this.maxEntries, (_k, dropped) => {
          if (!pages.includes(dropped.page)) pages.push(dropped.page);
        });
        this.onChange({ all: false, pages, totalChanged });
      },
      (err: unknown) => {
        done();
        throw err;
      },
    );
    inflight.set(k, { run, epoch });
    return run;
  }
}
