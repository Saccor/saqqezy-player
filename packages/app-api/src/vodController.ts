import {
  VOD_ALL, VodCatalog, VodFetchCancelled, continueMovies, continueSeries, episodeLabel, isInProgress,
  type VodItem, type VodKind, type VodService, type VodSort, type VodUserRecord, type VodUserState,
} from '@iptv/core';
import { toRpcError, type RpcError } from './rpc.ts';
import type { AppEvent, VodCategoryView, VodHome, VodRow, VodTile } from './types.ts';

export const VOD_ROW_CONTINUE = 'vod:continue';
export const VOD_ROW_FAVOURITES = 'vod:favourites';
export const VOD_ROW_RECENT = 'vod:recent';
/** Posters per home row. */
export const VOD_ROW_ITEMS = 30;
/** Home rows that carry their items; the rest are fetched as they scroll in. */
export const VOD_HOME_ROWS_WITH_ITEMS = 6;
/** The "Recently added" grid shows at most this many titles. */
export const VOD_RECENT_MAX = 200;

const LABELS: Record<string, string> = {
  [VOD_ROW_CONTINUE]: 'Continue watching',
  [VOD_ROW_FAVOURITES]: 'Favourites',
  [VOD_ROW_RECENT]: 'Recently added',
};
const allLabel = (kind: VodKind) => (kind === 'movie' ? 'All movies' : 'All series');

export interface VodControllerDeps {
  vod: VodService;
  emit: (e: AppEvent) => void;
  /** Records a failure (scrubbed, in diagnostics) and returns the Error to rethrow: AppApi's `record`. */
  record: (where: string, err: unknown) => Error;
}

interface Job { ac: AbortController; done: Promise<void> }

/**
 * All Movies and Series state in the worker, for the active source only. At most one catalogue is resident
 * (one kind); asking for the other kind drops it first. A source change (`reset`) drops everything and aborts fetches.
 */
export class VodController {
  protected readonly vod: VodService;
  protected readonly emit: (e: AppEvent) => void;
  protected readonly record: (where: string, err: unknown) => Error;

  protected sourceId: string | undefined;
  /** Bumped by `reset`: async work started under an older epoch never writes state. */
  protected epoch = 0;
  private resident: { kind: VodKind; catalog: VodCatalog } | undefined;
  private loading: { kind: VodKind; p: Promise<VodCatalog | undefined> } | undefined;
  protected user: Map<string, VodUserState> | undefined;
  private readonly jobs = new Map<VodKind, Job>();
  /** Every fetch ever started and not yet finished, including ones `reset` aborted (so `idle` can wait for them). */
  private readonly pending = new Set<Promise<void>>();
  private readonly failures = new Map<VodKind, RpcError>();

  constructor(deps: VodControllerDeps) {
    this.vod = deps.vod;
    this.emit = deps.emit;
    this.record = deps.record;
  }

  reset(sourceId: string | undefined): void {
    for (const job of this.jobs.values()) job.ac.abort();
    this.jobs.clear();
    this.failures.clear();
    this.resident = undefined;
    this.loading = undefined;
    this.user = undefined;
    this.resetDetails();
    this.sourceId = sourceId;
    this.epoch++;
  }

  async home(kind: VodKind): Promise<VodHome> {
    const id = this.sourceId;
    if (!id) return { status: 'empty', rows: [], truncated: false };
    const epoch = this.epoch;
    const catalog = await this.catalog(kind);
    if (this.epoch !== epoch) return this.home(kind);
    if (!catalog) {
      if (this.jobs.has(kind)) return { status: 'loading', rows: [], truncated: false };
      const failure = this.failures.get(kind);
      if (failure) return { status: 'error', rows: [], truncated: false, error: failure };
      const needs = await this.vod.needsRefresh(id, kind);
      if (this.epoch !== epoch) return this.home(kind);
      if (needs) {
        void this.startFetch(kind, id, epoch);
        return { status: 'loading', rows: [], truncated: false };
      }
      return { status: 'empty', rows: [], truncated: false };
    }
    // Stale-while-revalidate: show what is stored, refresh behind it (once; a failure stops it until refreshVod).
    if (!this.jobs.has(kind) && !this.failures.has(kind)) {
      const needs = await this.vod.needsRefresh(id, kind);
      if (this.epoch !== epoch) return this.home(kind);
      if (needs) void this.startFetch(kind, id, epoch);
    }
    if (catalog.size === 0) {
      if (this.jobs.has(kind)) return { status: 'loading', rows: [], truncated: false };
      const failure = this.failures.get(kind);
      if (failure) return { status: 'error', rows: [], truncated: false, error: failure };
      return { status: 'empty', rows: [], truncated: catalog.truncated };
    }
    return { status: 'ready', rows: await this.rows(kind, catalog), truncated: catalog.truncated };
  }

  async categories(kind: VodKind): Promise<VodCategoryView[]> {
    const catalog = this.sourceId ? await this.catalog(kind) : undefined;
    if (!catalog) return [];
    const records = await this.records();
    const out: VodCategoryView[] = [
      { id: VOD_ROW_CONTINUE, name: LABELS[VOD_ROW_CONTINUE]!, count: this.continueItems(kind, catalog, records).length },
      { id: VOD_ROW_FAVOURITES, name: LABELS[VOD_ROW_FAVOURITES]!, count: this.favouriteItems(catalog, records).length },
    ];
    if (catalog.hasAddedDates) out.push({ id: VOD_ROW_RECENT, name: LABELS[VOD_ROW_RECENT]!, count: Math.min(catalog.size, VOD_RECENT_MAX) });
    out.push({ id: VOD_ALL, name: allLabel(kind), count: catalog.size });
    for (const c of catalog.categories()) out.push({ id: c.id, name: c.name, count: c.count });
    return out;
  }

  async slice(kind: VodKind, categoryId: string, sort: VodSort, offset: number, count: number): Promise<{ total: number; rows: VodTile[] }> {
    const catalog = this.sourceId ? await this.catalog(kind) : undefined;
    if (!catalog) return { total: 0, rows: [] };
    const from = Math.max(0, offset);
    const n = Math.max(0, count);
    if (categoryId === VOD_ROW_CONTINUE || categoryId === VOD_ROW_FAVOURITES) {
      const records = await this.records();
      const all = categoryId === VOD_ROW_CONTINUE ? this.continueItems(kind, catalog, records) : this.favouriteItems(catalog, records).map((item) => this.tile(item));
      return { total: all.length, rows: all.slice(from, from + n) };
    }
    if (categoryId === VOD_ROW_RECENT) {
      await this.userMap();
      const total = catalog.hasAddedDates ? Math.min(catalog.size, VOD_RECENT_MAX) : 0;
      const take = Math.max(0, Math.min(n, total - from));
      return { total, rows: take ? catalog.slice(VOD_ALL, 'added', from, take).rows.map((item) => this.tile(item)) : [] };
    }
    const page = catalog.slice(categoryId, sort, from, n);
    await this.records();
    return { total: page.total, rows: page.rows.map((item) => this.tile(item)) };
  }

  /** Explicit refresh (the Try again button): clears a recorded failure and waits for the fetch. */
  async refresh(kind: VodKind): Promise<void> {
    const id = this.sourceId;
    if (!id) return;
    this.failures.delete(kind);
    await this.startFetch(kind, id, this.epoch);
  }

  /** Idle-time warm-up: loads the stored catalogue only when nothing is resident. Never fetches. */
  async preload(kind: VodKind): Promise<void> {
    if (!this.sourceId || this.resident || this.loading) return;
    await this.catalog(kind);
    await this.records();
  }

  async idle(): Promise<void> {
    while (this.jobs.size || this.pending.size) {
      await Promise.allSettled([...this.jobs.values()].map((j) => j.done).concat([...this.pending]));
    }
  }

  // ---- internals shared with later tasks ----

  /** The resident catalogue for `kind`, loading it (and dropping the other kind first). Undefined when nothing is stored. */
  protected async catalog(kind: VodKind): Promise<VodCatalog | undefined> {
    const id = this.sourceId;
    if (!id) return undefined;
    if (this.resident?.kind === kind) return this.resident.catalog;
    if (this.loading?.kind === kind) return this.loading.p;
    // Drop the other kind before loading, so two catalogues are never resident together.
    this.resident = undefined;
    const epoch = this.epoch;
    const p = this.vod.storedCatalog(id, kind).then((catalog) => {
      if (catalog && this.epoch === epoch && this.loading?.p === p) this.resident = { kind, catalog };
      return catalog;
    }).finally(() => {
      if (this.loading?.p === p) this.loading = undefined;
    });
    this.loading = { kind, p };
    return p;
  }

  /** The active source's user-state records (loaded once per source). */
  protected async records(): Promise<VodUserRecord[]> {
    const map = await this.userMap();
    return [...map].map(([itemId, state]) => ({ itemId, state }));
  }

  protected async userMap(): Promise<Map<string, VodUserState>> {
    if (this.user) return this.user;
    const id = this.sourceId;
    if (!id) return new Map();
    const epoch = this.epoch;
    const map = new Map((await this.vod.listUser(id)).map((r) => [r.itemId, r.state]));
    if (this.epoch === epoch) this.user = map;
    return map;
  }

  /** Needs `userMap()` to have run (every public caller awaits `records()` or `userMap()` first). */
  protected tile(item: VodItem, extra: Partial<VodTile> = {}): VodTile {
    const s = this.user?.get(item.id);
    const t: VodTile = { id: item.id, kind: item.kind, title: item.title, categoryId: item.categoryId, watched: s?.watched === true, favourite: s?.favourite === true };
    if (item.poster) t.poster = item.poster;
    if (item.year) t.year = item.year;
    if (item.rating !== undefined) t.rating = item.rating;
    if (s && isInProgress(s) && s.duration > 0) t.progress = Math.min(1, s.position / s.duration);
    return { ...t, ...extra };
  }

  /** Hook for Task 6 (detail cache). */
  protected resetDetails(): void {
    // Overridden in Task 6.
  }

  private startFetch(kind: VodKind, id: string, epoch: number): Promise<void> {
    if (this.epoch !== epoch) return Promise.resolve();
    const existing = this.jobs.get(kind);
    if (existing) return existing.done;
    const ac = new AbortController();
    this.emit({ type: 'vodLoading', sourceId: id, kind });
    const done = (async () => {
      try {
        const r = await this.vod.refresh(id, kind, { signal: ac.signal });
        if (this.epoch !== epoch) return;
        this.failures.delete(kind);
        // Swap the fresh list in without reading it back. It takes over from a stored read of the same kind (which
        // would be older), and never installs next to the other kind: a load or resident of the other kind wins.
        const otherLoading = this.loading !== undefined && this.loading.kind !== kind;
        const otherResident = this.resident !== undefined && this.resident.kind !== kind;
        if (!otherLoading && !otherResident) {
          this.resident = { kind, catalog: new VodCatalog(kind, r.list) };
          this.loading = undefined;
        }
        this.emit({ type: 'vodRefreshed', sourceId: id, kind, count: r.count, truncated: r.truncated });
      } catch (err) {
        if (err instanceof VodFetchCancelled || this.epoch !== epoch) return;
        const out = this.record('refreshVod', err);
        const error = toRpcError(out);
        this.failures.set(kind, error);
        this.emit({ type: 'vodRefreshFailed', sourceId: id, kind, error });
        throw out;
      } finally {
        if (this.jobs.get(kind)?.ac === ac) this.jobs.delete(kind);
      }
    })();
    // Background callers ignore the result; the failure is already recorded and emitted.
    done.catch(() => { /* handled */ });
    this.jobs.set(kind, { ac, done });
    this.pending.add(done);
    const forget = () => { this.pending.delete(done); };
    done.then(forget, forget);
    return done;
  }

  private async rows(kind: VodKind, catalog: VodCatalog): Promise<VodRow[]> {
    const records = await this.records();
    const rows: VodRow[] = [];
    const push = (id: string, title: string, total: number, items: () => VodTile[]) => {
      rows.push({ id, title, total, items: rows.length < VOD_HOME_ROWS_WITH_ITEMS ? items() : [] });
    };
    const cont = this.continueItems(kind, catalog, records);
    if (cont.length) push(VOD_ROW_CONTINUE, LABELS[VOD_ROW_CONTINUE]!, cont.length, () => cont.slice(0, VOD_ROW_ITEMS));
    const favs = this.favouriteItems(catalog, records);
    if (favs.length) push(VOD_ROW_FAVOURITES, LABELS[VOD_ROW_FAVOURITES]!, favs.length, () => favs.slice(0, VOD_ROW_ITEMS).map((item) => this.tile(item)));
    if (catalog.hasAddedDates) {
      push(VOD_ROW_RECENT, LABELS[VOD_ROW_RECENT]!, Math.min(catalog.size, VOD_RECENT_MAX), () => catalog.recentlyAdded(VOD_ROW_ITEMS).map((item) => this.tile(item)));
    }
    const sort: VodSort = catalog.hasAddedDates ? 'added' : 'title';
    for (const c of catalog.categories()) {
      push(c.id, c.name, c.count, () => catalog.slice(c.id, sort, 0, VOD_ROW_ITEMS).rows.map((item) => this.tile(item)));
    }
    return rows;
  }

  /** Continue watching tiles for this kind, newest first; items no longer in the catalogue are skipped. */
  protected continueItems(kind: VodKind, catalog: VodCatalog, records: VodUserRecord[]): VodTile[] {
    if (kind === 'movie') {
      return continueMovies(records).flatMap((id) => {
        const item = catalog.byId(id);
        return item ? [this.tile(item)] : [];
      });
    }
    const byId = new Map(records.map((r) => [r.itemId, r.state]));
    return continueSeries(records).flatMap((e) => {
      const item = catalog.byId(e.seriesId);
      if (!item) return [];
      const extra: Partial<VodTile> = { badge: episodeLabel(e.season, e.episode) };
      const ep = byId.get(e.episodeId);
      if (e.resumeMs > 0 && ep && ep.duration > 0) extra.progress = Math.min(1, e.resumeMs / ep.duration);
      return [this.tile(item, extra)];
    });
  }

  /** Favourite items of this catalogue, A to Z. */
  protected favouriteItems(catalog: VodCatalog, records: VodUserRecord[]): VodItem[] {
    return records
      .filter((r) => r.state.favourite)
      .flatMap((r) => {
        const item = catalog.byId(r.itemId);
        return item ? [item] : [];
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }
}
