import {
  VOD_ALL, VodCatalog, VodFetchCancelled, continueMovies, continueSeries, episodeLabel, isInProgress, nextEpisode, prevEpisode, resumeMs,
  type Episode, type MovieDetail, type SeriesDetail, type SeriesPointer, type VodItem, type VodKind, type VodService, type VodSort, type VodUserRecord, type VodUserState,
} from '@iptv/core';
import { toRpcError, type RpcError } from './rpc.ts';
import type {
  AppEvent, EpisodeView, MovieView, SeasonView, SeriesPrimary, SeriesView, VodCategoryView, VodHome, VodPlayable, VodRow, VodTile, VodTracks,
} from './types.ts';

export const VOD_ROW_CONTINUE = 'vod:continue';
export const VOD_ROW_FAVOURITES = 'vod:favourites';
export const VOD_ROW_RECENT = 'vod:recent';
/** Posters per home row. */
export const VOD_ROW_ITEMS = 30;
/** Home rows that carry their items; the rest are fetched as they scroll in. */
export const VOD_HOME_ROWS_WITH_ITEMS = 6;
/** The "Recently added" grid shows at most this many titles. */
export const VOD_RECENT_MAX = 200;
/** Movie and series details kept in memory (most recently used). */
export const VOD_DETAIL_CACHE = 50;
/** "More in <category>" on the movie detail. */
export const VOD_MORE_ITEMS = 20;

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
  /** Bumped by `reset` only (not `invalidate`): the user's own state survives an invalidate but never crosses a source change. */
  private sourceEpoch = 0;
  private resident: { kind: VodKind; catalog: VodCatalog } | undefined;
  private loading: { kind: VodKind; p: Promise<VodCatalog | undefined> } | undefined;
  protected user: Map<string, VodUserState> | undefined;
  /** The user-state load in flight (one per epoch; concurrent callers join it). */
  private userLoad: { epoch: number; p: Promise<Map<string, VodUserState>> } | undefined;
  private readonly jobs = new Map<VodKind, Job>();
  private readonly details = new Map<string, MovieDetail | SeriesDetail>();
  /**
   * Detail fetches in flight, per item id: a concurrent request for the same item (the hero resting, then a quick
   * Play) joins it instead of fetching again. A failure is recorded once, by the fetch itself.
   */
  private readonly detailLoads = new Map<string, { epoch: number; p: Promise<{ ok: true; d: MovieDetail | SeriesDetail } | { ok: false; err: Error }> }>();
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
    this.userLoad = undefined;
    this.resetDetails();
    this.sourceId = sourceId;
    this.epoch++;
    this.sourceEpoch++;
  }

  /** The kind of the resident catalogue, if one is loaded. */
  residentKind(): VodKind | undefined {
    return this.resident?.kind;
  }

  /**
   * The active source's stored lists changed under us (an M3U playlist refresh): drops the resident catalogue,
   * the loading read, details and failures, and aborts fetches. The user's own state is kept.
   */
  invalidate(sourceId: string): void {
    if (this.sourceId !== sourceId) return;
    for (const job of this.jobs.values()) job.ac.abort();
    this.jobs.clear();
    this.failures.clear();
    this.resident = undefined;
    this.loading = undefined;
    this.resetDetails();
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
    await this.userMap();
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
    await this.userMap();
  }

  async movie(id: string): Promise<MovieView | undefined> {
    const src = this.sourceId;
    const epoch = this.epoch;
    const catalog = src ? await this.catalog('movie') : undefined;
    const item = catalog?.byId(id);
    if (!src || !catalog || !item || this.epoch !== epoch) return undefined;
    const user = await this.userMap();
    if (this.epoch !== epoch) return undefined;
    const detail = await this.detailOf<MovieDetail>(item, 'getMovie', () => this.vod.movieDetail(src, item));
    if (this.epoch !== epoch) return undefined;
    const s = user.get(id);
    const sort: VodSort = catalog.hasAddedDates ? 'added' : 'title';
    const more = catalog.slice(item.categoryId, sort, 0, VOD_MORE_ITEMS + 1).rows
      .filter((i) => i.id !== id).slice(0, VOD_MORE_ITEMS).map((i) => this.tile(i));
    return { tile: this.tile(item), detail, resumeMs: resumeMs(s), tracks: tracksOf(s), more };
  }

  async series(id: string): Promise<SeriesView | undefined> {
    const src = this.sourceId;
    const epoch = this.epoch;
    const catalog = src ? await this.catalog('series') : undefined;
    const item = catalog?.byId(id);
    if (!src || !catalog || !item || this.epoch !== epoch) return undefined;
    const user = await this.userMap();
    if (this.epoch !== epoch) return undefined;
    const full = await this.detailOf<SeriesDetail>(item, 'getSeries', () => this.vod.seriesDetail(src, item));
    if (this.epoch !== epoch) return undefined;
    const seasons = full?.seasons ?? [];
    const view: SeriesView = {
      tile: this.tile(item),
      detail: full ? withoutSeasons(full) : null,
      seasons: seasons.map((s): SeasonView => ({ number: s.number, name: s.name, episodes: s.episodes.map((e) => episodeView(e, user.get(e.id))) })),
    };
    const primary = primaryOf(id, seasons, [...user].map(([itemId, state]) => ({ itemId, state })));
    if (primary) view.primary = primary;
    return view;
  }

  /** Movies: `playable(movieId)`. Episodes: `playable(episodeId, seriesId)`. */
  async playable(itemId: string, seriesId?: string): Promise<VodPlayable | undefined> {
    const src = this.sourceId;
    if (!src) return undefined;
    const epoch = this.epoch;
    const user = await this.userMap();
    if (this.epoch !== epoch) return undefined;
    const s = user.get(itemId);
    if (seriesId === undefined) {
      const item = (await this.catalog('movie'))?.byId(itemId);
      if (!item || this.epoch !== epoch) return undefined;
      const url = await this.vod.streamUrl(src, item);
      if (this.epoch !== epoch) return undefined;
      return { kind: 'movie', itemId, url, title: item.title, resumeMs: resumeMs(s), tracks: tracksOf(s) };
    }
    const show = (await this.catalog('series'))?.byId(seriesId);
    if (!show || this.epoch !== epoch) return undefined;
    // A failure is recorded once, here, and that same Error is rethrown (AppApi does not record it again).
    const detail = await this.detailOf<SeriesDetail>(show, 'getVodPlayable', () => this.vod.seriesDetail(src, show), true);
    if (this.epoch !== epoch || !detail) return undefined;
    const ep = detail.seasons.flatMap((x) => x.episodes).find((e) => e.id === itemId);
    if (!ep) return undefined;
    const url = await this.vod.streamUrl(src, ep);
    if (this.epoch !== epoch) return undefined;
    const next = nextEpisode(detail.seasons, itemId);
    const series: SeriesPointer = { id: seriesId, season: ep.season, episode: ep.episode };
    if (next) series.next = { id: next.id, season: next.season, episode: next.episode };
    const fromSeries = tracksOf(user.get(seriesId));
    const seriesTracks = fromSeries.audio || fromSeries.subtitle ? fromSeries : tracksOf(s);
    const out: VodPlayable = {
      kind: 'episode', itemId, url, title: show.title, episodeLabel: `${episodeLabel(ep.season, ep.episode)} · ${ep.title}`,
      resumeMs: resumeMs(s), tracks: seriesTracks, series,
    };
    if (ep.runtimeMin) out.durationMs = ep.runtimeMin * 60_000;
    if (next) out.next = { id: next.id, label: `${episodeLabel(next.season, next.episode)} · ${next.title}` };
    const prev = prevEpisode(detail.seasons, itemId);
    if (prev) out.prev = { id: prev.id, label: `${episodeLabel(prev.season, prev.episode)} · ${prev.title}` };
    return out;
  }

  saveProgress(itemId: string, positionMs: number, durationMs: number, series?: SeriesPointer): Promise<void> {
    return this.write(itemId, (src) => this.vod.saveProgress(src, itemId, positionMs, durationMs, series));
  }

  setFavourite(itemId: string, on: boolean): Promise<void> {
    return this.write(itemId, (src) => this.vod.setFavourite(src, itemId, on));
  }

  setWatched(itemId: string, on: boolean, series?: SeriesPointer): Promise<void> {
    return this.write(itemId, (src) => this.vod.setWatched(src, itemId, on, series));
  }

  clearProgress(itemId: string): Promise<void> {
    return this.write(itemId, (src) => this.vod.clearProgress(src, itemId));
  }

  /** "Remove from Continue watching" on a series tile: clears the latest-updated episode record, the one `continueSeries` picks. */
  async clearSeriesContinue(seriesId: string): Promise<void> {
    const epoch = this.sourceEpoch;
    const map = await this.userMap();
    if (this.sourceEpoch !== epoch) return;
    let latest: { itemId: string; updatedAt: number } | undefined;
    for (const [itemId, state] of map) {
      if (state.series?.id === seriesId && (!latest || state.updatedAt > latest.updatedAt)) latest = { itemId, updatedAt: state.updatedAt };
    }
    if (latest) await this.clearProgress(latest.itemId);
  }

  setTracks(itemId: string, tracks: VodTracks): Promise<void> {
    return this.write(itemId, (src) => this.vod.setTracks(src, itemId, tracks));
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
      // A finished fetch may have installed a fresher list meanwhile: callers get that, not this older read.
      return this.epoch === epoch && this.resident?.kind === kind ? this.resident.catalog : catalog;
    }).finally(() => {
      if (this.loading?.p === p) this.loading = undefined;
    });
    this.loading = { kind, p };
    return p;
  }

  /** Writes through VodService, then mirrors the new state into the user map if it is still this source's. */
  private async write(itemId: string, op: (sourceId: string) => Promise<VodUserState | undefined>): Promise<void> {
    const src = this.sourceId;
    if (!src) return;
    const epoch = this.sourceEpoch;
    const next = await op(src);
    if (next && this.sourceEpoch === epoch) (await this.userMap()).set(itemId, next);
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
    const epoch = this.sourceEpoch;
    if (this.userLoad?.epoch === epoch) return this.userLoad.p;
    const p: Promise<Map<string, VodUserState>> = this.vod.listUser(id).then((records) => {
      const map = new Map(records.map((r) => [r.itemId, r.state]));
      // Installed only if nothing else did meanwhile; every caller of this epoch gets the installed map.
      if (this.sourceEpoch !== epoch) return map;
      this.user ??= map;
      return this.user;
    }).finally(() => {
      if (this.userLoad?.p === p) this.userLoad = undefined;
    });
    this.userLoad = { epoch, p };
    return p;
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

  protected resetDetails(): void {
    this.details.clear();
    this.detailLoads.clear();
  }

  /** Cached detail (most recently used first out); a failure is recorded and not cached: returns null, or with `rethrow` throws the recorded Error. */
  private async detailOf<T extends MovieDetail | SeriesDetail>(item: VodItem, where: string, load: () => Promise<T>, rethrow = false): Promise<T | null> {
    const hit = this.details.get(item.id);
    if (hit) {
      this.details.delete(item.id);
      this.details.set(item.id, hit);
      return hit as T;
    }
    const epoch = this.epoch;
    let entry = this.detailLoads.get(item.id);
    if (!entry || entry.epoch !== epoch) {
      // In the map before `load` runs, so the cleanup below finds it even when `load` throws at once.
      const mine = { epoch } as NonNullable<typeof entry>;
      entry = mine;
      this.detailLoads.set(item.id, mine);
      mine.p = (async () => {
        try {
          const d = await load();
          if (this.epoch === epoch) {
            this.details.set(item.id, d);
            if (this.details.size > VOD_DETAIL_CACHE) this.details.delete(this.details.keys().next().value!);
          }
          return { ok: true as const, d };
        } catch (err) {
          return { ok: false as const, err: this.record(where, err) };
        } finally {
          if (this.detailLoads.get(item.id) === mine) this.detailLoads.delete(item.id);
        }
      })();
    }
    const r = await entry.p;
    if (r.ok) return r.d as T;
    if (rethrow) throw r.err;
    return null;
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

function tracksOf(s: VodUserState | undefined): VodTracks {
  const t: VodTracks = {};
  if (s?.audio) t.audio = s.audio;
  if (s?.subtitle) t.subtitle = s.subtitle;
  return t;
}

function withoutSeasons(d: SeriesDetail): Omit<SeriesDetail, 'seasons'> {
  const { seasons: _seasons, ...rest } = d;
  return rest;
}

function episodeView(e: Episode, s: VodUserState | undefined): EpisodeView {
  const v: EpisodeView = { id: e.id, season: e.season, episode: e.episode, title: e.title, watched: s?.watched === true };
  if (e.plot) v.plot = e.plot;
  if (e.runtimeMin) v.runtimeMin = e.runtimeMin;
  if (e.still) v.still = e.still;
  if (s && isInProgress(s) && s.duration > 0) v.progress = Math.min(1, s.position / s.duration);
  return v;
}

/** The series' latest episode: resume it, or its known next one; else the first episode of the first season. */
function primaryOf(seriesId: string, seasons: { episodes: Episode[] }[], records: VodUserRecord[]): SeriesPrimary | undefined {
  let latest: VodUserRecord | undefined;
  for (const r of records) {
    if (r.state.series?.id !== seriesId) continue;
    if (!latest || r.state.updatedAt > latest.state.updatedAt) latest = r;
  }
  const p = latest?.state.series;
  if (latest && p && isInProgress(latest.state)) {
    return { episodeId: latest.itemId, season: p.season, episode: p.episode, resumeMs: latest.state.position, mode: 'continue' };
  }
  if (latest && p?.next && latest.state.watched) {
    return { episodeId: p.next.id, season: p.next.season, episode: p.next.episode, resumeMs: 0, mode: 'continue' };
  }
  const first = seasons[0]?.episodes[0];
  return first ? { episodeId: first.id, season: first.season, episode: first.episode, resumeMs: 0, mode: 'start' } : undefined;
}
