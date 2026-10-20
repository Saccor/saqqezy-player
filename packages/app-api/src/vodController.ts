import {
  QUALITY_LABELS, VOD_ALL, VodCatalog, VodFetchCancelled, continueMovies, groupVod, orderVersions, parseVodTitle, preferredLanguages, continueSeries, episodeLabel, isBeforeSeriesPoint, isInProgress, nextEpisode, prevEpisode, resumeMs,
  buildVodSearchIndex, buildTrendingIndex, matchTrendingHits, searchKey, searchTitle, searchVodIndex, vodIndexEntry,
  type TrendingFeed, type TrendingIndex,
  type Episode, type MovieDetail, type SeriesDetail, type SeriesPointer, type VodItem, type VodKind, type VodSearchIndex, type VodService, type VodSort,
  type SubtitleSearch, type VodList, type VodUserRecord, type VodUserState, type VodGroup, type VodMember,
  countryLabel, detectVodRegions, emptyVodLayout, vodCategoryView,
  type GroupRegion, type RegionSettings, type VodApplyResult, type VodLayout, type VodLayoutOp,
} from '@iptv/core';
import { toRpcError, type RpcError } from './rpc.ts';
import type { StartTimedTile, StartTrendTile } from './startHome.ts';
import type {
  AppEvent, EpisodeView, MovieView, SeasonView, SeriesPrimary, SeriesView, VersionView, VodCategoryView, VodHome, VodPlayable, VodRow, VodTile, VodTracks,
  RegionCount, RegionsOverview,
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
/** Titles per Start page row. */
const START_ITEMS = 20;

/**
 * One kind's Start page rows (spec §2, phase 2.5): Continue watching, Recently added (with the "See all" total) and
 * Top rated (the provider's `rating`, best first, unrated titles skipped; `topTotal` is how many titles are rated).
 */
export interface StartVodRows {
  /** Newest first, each with when it was last played (Start merges the kinds by it). */
  continue: StartTimedTile[]; recent: VodTile[]; recentTotal: number; top: VodTile[]; topTotal: number;
  /**
   * Trending titles this catalogue has, in feed order, each with whether it matched strongly (spec
   * 2026-10-20-trending-design §5; report §5.2); undefined without a feed.
   */
  trending?: StartTrendTile[];
  /** The matched feed's build time (ISO 8601), for "this week". */
  trendingAt?: string;
}
/** Movie and series details kept in memory (most recently used). */
export const VOD_DETAIL_CACHE = 50;
/** "More in <category>" on the movie detail. */
export const VOD_MORE_ITEMS = 20;

const LABELS: Record<string, string> = {
  [VOD_ROW_CONTINUE]: 'Continue watching',
  [VOD_ROW_FAVOURITES]: 'Favourites',
  [VOD_ROW_RECENT]: 'Recently added',
};
const KINDS: readonly VodKind[] = ['movie', 'series'];

/** Movies and series matching a Search query. `pending`: an index is being built; `searchReady` follows. */
export interface VodSearchHits { movies: VodTile[]; series: VodTile[]; pending: boolean }

const allLabel = (kind: VodKind) => (kind === 'movie' ? 'All movies' : 'All series');

export interface VodControllerDeps {
  vod: VodService;
  emit: (e: AppEvent) => void;
  /** Records a failure (scrubbed, in diagnostics) and returns the Error to rethrow: AppApi's `record`. */
  record: (where: string, err: unknown) => Error;
  /**
   * The settings that shape catalogues. Without it, titles are never combined (each item is its own card), as
   * before duplicates were combined.
   */
  settings?: () => Promise<{
    combineDuplicates: boolean; preferredLanguages: string[];
    /** Merge categories across languages (off: provider categories). */
    combineCategories?: boolean;
    /** Your countries: the same rule as Live TV groups, over categories. */
    regions?: RegionSettings;
  }>;
  /** The device language ("sv-SE"), for preferred languages left empty. */
  locale?: () => string | undefined;
  /** The current trending feed of a kind (TrendingService.feed); without it Start has no trending rows. */
  trending?: (kind: VodKind) => TrendingFeed | undefined;
  /** The feed once one is known (TrendingService.settled): a snapshot taken before it arrived fills its row then. */
  trendingSettled?: (kind: VodKind) => Promise<TrendingFeed | undefined>;
}

/** How catalogues are combined for the active source (loaded once per source; dropped when the settings change). */
interface GroupConfig {
  sourceEpoch: number;
  combine: boolean;
  langs: string[];
  splits: Record<VodKind, Set<string>>;
  picks: Record<VodKind, Record<string, string>>;
  mergeCategories: boolean;
  regions: RegionSettings;
  /** The user's category layout per kind. */
  layouts: Record<VodKind, VodLayout>;
}

/** A version as ordered for Play: the item and what the ordering needs. */
interface Candidate { id: string; item: VodItem; lang?: string; quality: number; activeAt?: number }

interface Job { ac: AbortController; done: Promise<void> }

type DetailResult = { ok: true; d: MovieDetail | SeriesDetail } | { ok: false; err: Error };
/** A detail fetch in flight: `p` settles with the outcome and never rejects. */
interface DetailLoad { readonly epoch: number; readonly p: Promise<DetailResult> }
/** The diagnostics op name of a failed detail fetch, whichever caller started it (a shared fetch has several). */
const DETAIL_OP = 'getVodDetail';

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
  private readonly startSnaps = new Map<VodKind, StartVodRows>();
  private readonly trendingOf: VodControllerDeps['trending'];
  private readonly trendingSettledOf: VodControllerDeps['trendingSettled'];
  /** The resident catalogue's trending index (its titles' grouping keys), built on the first Start snapshot. */
  private trendIndex: { catalog: VodCatalog; groups: readonly VodGroup[]; index: TrendingIndex } | undefined;
  private resident: { kind: VodKind; catalog: VodCatalog } | undefined;
  private loading: { kind: VodKind; p: Promise<VodCatalog | undefined> } | undefined;
  protected user: Map<string, VodUserState> | undefined;
  /** The user-state load in flight (one per epoch; concurrent callers join it). */
  private userLoad: { epoch: number; p: Promise<Map<string, VodUserState>> } | undefined;
  private readonly jobs = new Map<VodKind, Job>();
  /** First loads that installed a snapshot as the resident catalogue: the titles so far, per kind. */
  private readonly progress = new Map<VodKind, number>();
  /** The kind last asked for (the screen showing): only its first load shows snapshots. */
  private wanted: VodKind | undefined;
  private readonly details = new Map<string, MovieDetail | SeriesDetail>();
  /**
   * Detail fetches in flight, per item id: a concurrent request for the same item (the hero resting, then a quick
   * Play) joins it instead of fetching again. A failure is recorded once, by the fetch itself, as `getVodDetail`.
   */
  private readonly detailLoads = new Map<string, DetailLoad>();
  /** Every fetch ever started and not yet finished, including ones `reset` aborted (so `idle` can wait for them). */
  private readonly pending = new Set<Promise<void>>();
  private readonly failures = new Map<VodKind, RpcError>();
  /** Kinds whose stale-while-revalidate staleness question is out (see `revalidate`). */
  private readonly revalidating = new Set<VodKind>();
  /**
   * Search: a compact title index per kind (null when nothing is stored or the read failed), built in the
   * background from the resident catalogue or one stored read, never a fetch. Dropped by `reset` and `invalidate`;
   * a refresh drops its kind's (and bumps its generation, so a build in flight does not install an older one).
   */
  private readonly indexes = new Map<VodKind, VodSearchIndex | null>();
  private readonly indexGens: Record<VodKind, number> = { movie: 0, series: 0 };
  private indexJob: { epoch: number; p: Promise<void> } | undefined;

  private readonly settingsOf: VodControllerDeps['settings'];
  private readonly locale: () => string | undefined;
  private cfg: GroupConfig | undefined;
  private cfgLoad: { sourceEpoch: number; p: Promise<GroupConfig | undefined> } | undefined;
  /** Bumped when the settings change: a config load started before does not install. */
  private cfgGen = 0;

  constructor(deps: VodControllerDeps) {
    this.vod = deps.vod;
    this.emit = deps.emit;
    this.record = deps.record;
    this.settingsOf = deps.settings;
    this.locale = deps.locale ?? (() => undefined);
    this.trendingOf = deps.trending;
    this.trendingSettledOf = deps.trendingSettled;
  }

  reset(sourceId: string | undefined): void {
    for (const job of this.jobs.values()) job.ac.abort();
    this.jobs.clear();
    this.progress.clear();
    this.failures.clear();
    this.startSnaps.clear();
    this.revalidating.clear();
    this.resident = undefined;
    this.loading = undefined;
    this.user = undefined;
    this.userLoad = undefined;
    this.resetDetails();
    this.dropIndexes();
    this.sourceId = sourceId;
    this.wanted = undefined;
    this.cfg = undefined;
    this.cfgLoad = undefined;
    this.epoch++;
    this.sourceEpoch++;
  }

  /**
   * The combine settings changed. `regroup`: the resident catalogue is dropped and rebuilt on the next request
   * (screens reload on `vodRefreshed`); otherwise only the preferences are reread.
   */
  settingsChanged(regroup: boolean): void {
    this.cfg = undefined;
    this.cfgLoad = undefined;
    this.cfgGen++;
    if (regroup) this.regroup();
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
    this.progress.clear();
    this.failures.clear();
    this.resident = undefined;
    this.loading = undefined;
    this.resetDetails();
    // An open Search re-runs on searchReady: tell it its movie and series results are gone (it rebuilds them).
    const searched = this.indexes.size > 0 || this.indexJob !== undefined;
    this.dropIndexes();
    this.epoch++;
    if (searched) this.emit({ type: 'searchReady', sourceId });
  }

  /**
   * Movies and series whose title contains `query` (`searchKey` substring, ranked as `VodCatalog.search`), at most
   * `cap` per kind. Never waits for an index: a kind without one has no hits yet, `pending` is set, and the
   * background build emits `searchReady` when done.
   */
  async search(query: string, cap: number): Promise<VodSearchHits> {
    const id = this.sourceId;
    if (!id || !searchKey(query)) return { movies: [], series: [], pending: false };
    const epoch = this.epoch;
    const pending = KINDS.some((k) => !this.indexes.has(k));
    if (pending) this.buildIndexes(id);
    const hits = (kind: VodKind): VodItem[] => {
      const ix = this.indexes.get(kind);
      if (!ix) return [];
      return searchVodIndex(ix, query, cap).map((i) => ({ ...vodIndexEntry(ix, i), kind }));
    };
    const movies = hits('movie');
    const series = hits('series');
    if (movies.length || series.length) {
      await this.userMap();
      if (this.epoch !== epoch) return this.search(query, cap);
    }
    return { movies: movies.map((item) => this.tile(item)), series: series.map((item) => this.tile(item)), pending };
  }

  /** Start page rows (spec §2): from the resident catalogue when it is this kind, else the last snapshot. Never loads. */
  async startRows(kind: VodKind): Promise<StartVodRows | undefined> {
    const r = this.resident;
    if (!this.sourceId || !r || r.kind !== kind) return this.startSnaps.get(kind);
    const epoch = this.epoch;
    const snap = await this.snapStart(kind, r.catalog);
    return this.epoch === epoch ? snap : this.startSnaps.get(kind);
  }

  private async snapStart(kind: VodKind, catalog: VodCatalog): Promise<StartVodRows> {
    const epoch = this.epoch;
    const records = await this.records();
    const top = catalog.topRated(START_ITEMS);
    const snap: StartVodRows = {
      continue: this.continueEntries(kind, catalog, records).slice(0, START_ITEMS),
      recent: catalog.hasAddedDates ? catalog.recentlyAdded(START_ITEMS).map((item) => this.tile(item)) : [],
      recentTotal: catalog.hasAddedDates ? Math.min(catalog.size, VOD_RECENT_MAX) : 0,
      top: top.rows.map((item) => this.tile(item)),
      topTotal: top.rated,
    };
    const feed = this.trendingOf?.(kind);
    if (feed) Object.assign(snap, this.trendingPart(kind, catalog, feed));
    else if (this.trendingSettledOf) this.fillTrendingLater(kind, catalog, epoch);
    if (this.epoch === epoch) this.startSnaps.set(kind, snap);
    return snap;
  }

  /**
   * No feed yet (first run, or Movies opened before Start read it): match once it lands, into the kind's latest
   * snapshot. Without that, opening Series next would leave the movie snapshot without trending until the next
   * Movies visit, because Start never recomputes a catalogue that is not resident. The catalogue is held only until
   * the feed settles (one fetch); a source switch (epoch) drops the result.
   */
  private fillTrendingLater(kind: VodKind, catalog: VodCatalog, epoch: number): void {
    const settled = this.trendingSettledOf;
    if (!settled) return;
    const p = settled(kind).then((feed) => {
      const snap = this.startSnaps.get(kind);
      if (!feed || this.epoch !== epoch || !snap || snap.trending) return;
      // A newer resident catalogue of this kind (a partial first load completing) has the fuller list.
      const r = this.resident;
      Object.assign(snap, this.trendingPart(kind, r?.kind === kind ? r.catalog : catalog, feed));
    }, () => undefined);
    this.pending.add(p);
    const forget = () => { this.pending.delete(p); };
    p.then(forget, forget);
  }

  /**
   * The catalogue's titles the feed names, one tile per title (all its versions), feed order. Matches the grouping
   * keys: the catalogue's own groups when titles are combined, else a grouping built once for this (one card per
   * item stays the view; each title shows its lead version).
   */
  private trendingPart(kind: VodKind, catalog: VodCatalog, feed: TrendingFeed): Pick<StartVodRows, 'trending' | 'trendingAt'> {
    let t = this.trendIndex;
    if (t?.catalog !== catalog) {
      const groups = (catalog.titleGroups ?? groupVod(catalog.source)).groups;
      t = { catalog, groups, index: buildTrendingIndex(groups) };
      // Cached only for the resident catalogue: a released one (a late feed) must not stay alive on a 1 GB TV.
      if (this.resident?.catalog === catalog) this.trendIndex = t;
    }
    const items = catalog.source.items;
    const trending = matchTrendingHits(feed, kind, t.index, START_ITEMS).map((h): StartTrendTile => {
      const lead = items[t.groups[h.group]!.lead]!;
      return { tile: this.tile(catalog.rowOf(lead.id) ?? lead), strong: h.strong };
    });
    return feed.at ? { trending, trendingAt: feed.at } : { trending };
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
      // Nothing stored: the screen waits for this fetch, so a failed background refresh does not hold it off.
      const needs = await this.vod.needsRefresh(id, kind, { foreground: true });
      if (this.epoch !== epoch) return this.home(kind);
      if (needs) {
        void this.startFetch(kind, id, epoch, true, true);
        return { status: 'loading', rows: [], truncated: false };
      }
      return { status: 'empty', rows: [], truncated: false };
    }
    if (catalog.size === 0) {
      // An empty stored list: the staleness answer decides what the screen shows, so it is awaited here.
      if (!this.jobs.has(kind) && !this.failures.has(kind)) {
        const needs = await this.vod.needsRefresh(id, kind);
        if (this.epoch !== epoch) return this.home(kind);
        if (needs) void this.startFetch(kind, id, epoch, true, true);
      }
      if (this.jobs.has(kind)) return { status: 'loading', rows: [], truncated: false };
      const failure = this.failures.get(kind);
      if (failure) return { status: 'error', rows: [], truncated: false, error: failure };
      return { status: 'empty', rows: [], truncated: catalog.truncated };
    }
    // Stale-while-revalidate: the resident catalogue answers now; the staleness reads (3-4 IDB round trips) and any
    // refresh run behind the answer (once; a failure stops it until refreshVod).
    if (!this.jobs.has(kind) && !this.failures.has(kind)) this.revalidate(kind, id, epoch);
    await this.snapStart(kind, catalog);
    const home: VodHome = { status: 'ready', rows: await this.rows(kind, catalog), truncated: catalog.truncated };
    const so = this.progress.get(kind);
    if (so !== undefined && this.jobs.has(kind)) home.progress = so;
    if (catalog.partial) home.partial = true;
    return home;
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
    // Try again comes from this kind's screen, usually with nothing to show: a first load, unless a list is resident.
    this.wanted = kind;
    const shown = this.resident?.kind === kind && this.resident.catalog.size > 0;
    await this.startFetch(kind, id, this.epoch, false, !shown);
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
    const row = catalog?.rowOf(id);
    if (!src || !catalog || !row || this.epoch !== epoch) return undefined;
    const user = await this.userMap();
    await this.config();
    if (this.epoch !== epoch) return undefined;
    const ordered = this.ordered('movie', catalog, id, user);
    const item = ordered[0]!.item;
    const detail = await this.detailOf<MovieDetail>(item, () => this.vod.movieDetail(src, item));
    if (this.epoch !== epoch) return undefined;
    const s = user.get(item.id);
    const sort: VodSort = catalog.hasAddedDates ? 'added' : 'provider';
    const more = catalog.slice(row.categoryId, sort, 0, VOD_MORE_ITEMS + 1).rows
      .filter((i) => i.id !== row.id).slice(0, VOD_MORE_ITEMS).map((i) => this.tile(i));
    const view: MovieView = {
      tile: this.tile(row), detail, resumeMs: resumeMs(s), tracks: tracksOf(s), more,
      versions: this.versionViews(catalog, ordered), playId: item.id,
    };
    if (catalog.groupOf(id)?.splitFrom) view.split = true;
    return view;
  }

  /** With `versionId` (a version of this series), shows that version's seasons. */
  async series(id: string, versionId?: string): Promise<SeriesView | undefined> {
    const src = this.sourceId;
    const epoch = this.epoch;
    const catalog = src ? await this.catalog('series') : undefined;
    const row = catalog?.rowOf(id);
    if (!src || !catalog || !row || this.epoch !== epoch) return undefined;
    const user = await this.userMap();
    await this.config();
    if (this.epoch !== epoch) return undefined;
    const ordered = this.ordered('series', catalog, id, user);
    const item = ordered.find((c) => c.id === versionId)?.item ?? ordered[0]!.item;
    const full = await this.detailOf<SeriesDetail>(item, () => this.vod.seriesDetail(src, item));
    if (this.epoch !== epoch) return undefined;
    const seasons = full?.seasons ?? [];
    const view: SeriesView = {
      tile: this.tile(row),
      detail: full ? withoutSeasons(full) : null,
      seasons: seasons.map((s): SeasonView => ({ number: s.number, name: s.name, episodes: s.episodes.map((e) => episodeView(e, user.get(e.id))) })),
      versions: this.versionViews(catalog, ordered),
      versionId: item.id,
    };
    const primary = primaryOf(item.id, seasons, [...user].map(([itemId, state]) => ({ itemId, state })));
    if (primary) view.primary = primary;
    if (catalog.groupOf(id)?.splitFrom) view.split = true;
    return view;
  }

  /**
   * Movies: `playable(movieId)`. Episodes: `playable(episodeId, seriesId)`. A combined title's card id plays the
   * version Play picks; `exact` (a choice in the Versions list) plays the given version.
   */
  async playable(itemId: string, seriesId?: string, exact = false): Promise<VodPlayable | undefined> {
    const src = this.sourceId;
    if (!src) return undefined;
    const epoch = this.epoch;
    const user = await this.userMap();
    if (this.epoch !== epoch) return undefined;
    if (seriesId === undefined) {
      const catalog = await this.catalog('movie');
      if (!exact && catalog?.grouped && catalog.rowOf(itemId)?.id === itemId) {
        await this.config();
        if (this.epoch !== epoch) return undefined;
        itemId = this.ordered('movie', catalog, itemId, user)[0]!.id;
      }
      const s = user.get(itemId);
      const item = catalog?.byId(itemId);
      if (!item || this.epoch !== epoch) return undefined;
      const url = await this.vod.streamUrl(src, item);
      if (this.epoch !== epoch) return undefined;
      // A combined title shows its clean name ("Synthetic Film", not "EN - Synthetic Film 4K").
      const title = catalog?.grouped ? catalog.rowOf(itemId)?.title ?? item.title : item.title;
      const movie: VodPlayable = { kind: 'movie', itemId, url, title, resumeMs: resumeMs(s), tracks: tracksOf(s) };
      // M3U: the playlist entry's own headers (AppApi merges them over the source's settings).
      if (item.headers) movie.headers = { ...item.headers };
      return movie;
    }
    const s = user.get(itemId);
    const shows = await this.catalog('series');
    const show = shows?.byId(seriesId);
    if (!show || this.epoch !== epoch) return undefined;
    const showTitle = shows?.grouped ? shows.rowOf(seriesId)?.title ?? show.title : show.title;
    // A failure is recorded once (as getVodDetail) by the shared fetch, and that same Error is rethrown (AppApi does not record it again).
    const detail = await this.detailOf<SeriesDetail>(show, () => this.vod.seriesDetail(src, show), true);
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
      kind: 'episode', itemId, url, title: showTitle, episodeLabel: `${episodeLabel(ep.season, ep.episode)} · ${ep.title}`,
      resumeMs: resumeMs(s), tracks: seriesTracks, series,
    };
    if (ep.runtimeMin) out.durationMs = ep.runtimeMin * 60_000;
    if (ep.headers) out.headers = { ...ep.headers };
    if (next) out.next = { id: next.id, label: `${episodeLabel(next.season, next.episode)} · ${next.title}` };
    const prev = prevEpisode(detail.seasons, itemId);
    if (prev) out.prev = { id: prev.id, label: `${episodeLabel(prev.season, prev.episode)} · ${prev.title}` };
    return out;
  }

  /**
   * What finds this movie's or episode's subtitles online: the TMDB id when the provider sends one (an episode: its
   * series' id plus season and episode), else the cleaned title (with the year, or season and episode).
   */
  async subtitleSearch(itemId: string, seriesId?: string): Promise<SubtitleSearch | undefined> {
    const src = this.sourceId;
    if (!src) return undefined;
    const epoch = this.epoch;
    if (seriesId === undefined) {
      const item = (await this.catalog('movie'))?.byId(itemId);
      if (!item || this.epoch !== epoch) return undefined;
      const detail = await this.detailOf<MovieDetail>(item, () => this.vod.movieDetail(src, item));
      if (this.epoch !== epoch) return undefined;
      if (detail?.tmdbId) return { tmdbId: detail.tmdbId };
      const t = searchTitle(item.title);
      const year = item.year ?? t.year;
      return year ? { query: t.title, year } : { query: t.title };
    }
    const shows = await this.catalog('series');
    const show = shows?.byId(seriesId);
    if (!show || this.epoch !== epoch) return undefined;
    const showTitle = shows?.grouped ? shows.rowOf(seriesId)?.title ?? show.title : show.title;
    const detail = await this.detailOf<SeriesDetail>(show, () => this.vod.seriesDetail(src, show));
    if (this.epoch !== epoch || !detail) return undefined;
    const ep = detail.seasons.flatMap((x) => x.episodes).find((e) => e.id === itemId);
    if (!ep) return undefined;
    if (detail.tmdbId) return { parentTmdbId: detail.tmdbId, season: ep.season, episode: ep.episode };
    return { query: searchTitle(show.title).title, season: ep.season, episode: ep.episode };
  }

  saveProgress(itemId: string, positionMs: number, durationMs: number, series?: SeriesPointer): Promise<void> {
    return this.write(itemId, (src) => this.vod.saveProgress(src, itemId, positionMs, durationMs, series));
  }

  /** On: marks `itemId`. Off: unmarks every version of its title (a combined card is a favourite if any version is). */
  async setFavourite(itemId: string, on: boolean): Promise<void> {
    const catalog = this.resident?.catalog;
    const ids = !on && catalog?.grouped ? catalog.members(itemId).map((m) => m.item.id) : [itemId];
    if (!ids.length) ids.push(itemId);
    const user = await this.userMap();
    for (const id of ids) {
      if (id !== itemId && !user.get(id)?.favourite) continue;
      await this.write(id, (src) => this.vod.setFavourite(src, id, on));
    }
  }

  /** Remembers the version the user picked for the title `itemId` belongs to (Play picks it from now on). */
  async pickVersion(itemId: string, versionId: string): Promise<void> {
    const src = this.sourceId;
    const r = this.resident;
    const g = r?.catalog.groupOf(itemId);
    if (!src || !r || !g || r.catalog.groupOf(versionId) !== g) return;
    const cfg = await this.config();
    await this.vod.setVodPick(src, r.kind, g.key, versionId);
    if (cfg && this.cfg === cfg) cfg.picks[r.kind][g.key] = versionId;
  }

  /** "Show separately" (`on`) or "Combine again" for the title `itemId` belongs to. Screens reload on `vodRefreshed`. */
  async setSplit(itemId: string, on: boolean): Promise<void> {
    const src = this.sourceId;
    const r = this.resident;
    const g = r?.catalog.groupOf(itemId);
    if (!src || !r || !g) return;
    const key = on ? (g.members.length > 1 ? g.key : undefined) : g.splitFrom;
    if (!key) return;
    const epoch = this.sourceEpoch;
    const keys = await this.vod.setVodSplit(src, r.kind, key, on);
    if (this.sourceEpoch !== epoch) return;
    if (this.cfg) this.cfg.splits[r.kind] = keys;
    this.regroup();
  }

  /**
   * An episode marked watched carries its next episode, so Continue watching moves on to it. The next one comes
   * from the series' detail when it is cached or loading (never a new fetch); else the caller's pointer is kept.
   * An episode before the series' point (`isBeforeSeriesPoint`: the latest record's next episode, else its own)
   * keeps its `updatedAt`, so marking an earlier episode watched never pulls Continue watching backwards, nor brings
   * back a finished or removed series.
   */
  async setWatched(itemId: string, on: boolean, series?: SeriesPointer): Promise<void> {
    let pointer = series;
    let keep = false;
    if (on && series) {
      const epoch = this.sourceEpoch;
      const next = await this.knownNextEpisode(series.id, itemId);
      const map = await this.userMap();
      // A source switch while the detail loaded: this episode belongs to the old source.
      if (this.sourceEpoch !== epoch) return;
      if (next) pointer = { ...series, next: { id: next.id, season: next.season, episode: next.episode } };
      const records: VodUserRecord[] = [];
      for (const [id, state] of map) if (state.series?.id === series.id) records.push({ itemId: id, state });
      keep = isBeforeSeriesPoint(records, series.id, series.season, series.episode);
    }
    if (keep) return this.write(itemId, (src) => this.vod.setWatched(src, itemId, on, pointer, { keepUpdatedAt: true }));
    return this.write(itemId, (src) => this.vod.setWatched(src, itemId, on, pointer));
  }

  /** The episode after `episodeId`, from the series' cached or in-flight detail only (no fetch). */
  private async knownNextEpisode(seriesId: string, episodeId: string): Promise<Episode | undefined> {
    let detail = this.details.get(seriesId);
    if (!detail) {
      const entry = this.detailLoads.get(seriesId);
      if (entry && entry.epoch === this.epoch) {
        const r = await entry.p;
        if (r.ok) detail = r.d;
      }
    }
    return detail && 'seasons' in detail ? nextEpisode(detail.seasons, episodeId) : undefined;
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

  /** One background job builds every missing index, after the search that asked has answered. */
  private buildIndexes(id: string): void {
    const epoch = this.epoch;
    if (this.indexJob?.epoch === epoch) return;
    const p = (async () => {
      for (const kind of KINDS) {
        // A macrotask before each kind: the search that started this answers (with its channels) before any build
        // work, and other requests get a turn between the two builds.
        await yieldTask();
        if (this.epoch !== epoch) return;
        if (this.indexes.has(kind)) continue;
        const gen = this.indexGens[kind];
        const current = () => this.epoch === epoch && this.indexGens[kind] === gen;
        let ix: VodSearchIndex | null = null;
        try {
          if (this.resident?.kind === kind) ix = this.resident.catalog.searchIndex();
          else if (this.loading?.kind === kind) {
            const catalog = await this.loading.p;
            if (catalog && current()) ix = catalog.searchIndex();
          } else {
            // The raw stored list, not a catalogue (no id map, no cached keys): only the list and the index are
            // ever alive together, and the list is dropped as soon as the index is built.
            let list = await this.vod.storedList(id, kind);
            await yieldTask();
            if (list && current()) ix = buildVodSearchIndex(kind, list.items);
            list = undefined;
          }
        } catch (err) {
          if (this.epoch === epoch) this.record('searchVod', err);
        }
        if (current()) this.indexes.set(kind, ix);
      }
      if (this.epoch === epoch) this.emit({ type: 'searchReady', sourceId: id });
    })().finally(() => {
      if (this.indexJob?.p === p) this.indexJob = undefined;
    });
    this.indexJob = { epoch, p };
    this.pending.add(p);
    const forget = () => { this.pending.delete(p); };
    p.then(forget, forget);
  }

  /** Drops the Search indexes and the trending index (all three callers drop or replace the resident catalogue). */
  private dropIndexes(): void {
    this.indexes.clear();
    this.indexJob = undefined;
    this.trendIndex = undefined;
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
    this.wanted = kind;
    if (this.resident?.kind === kind) return this.resident.catalog;
    if (this.loading?.kind === kind) return this.loading.p;
    // Drop the other kind before loading, so two catalogues are never resident together.
    this.resident = undefined;
    const epoch = this.epoch;
    const p = this.config().then(() => this.vod.storedCatalog(id, kind)).then((stored) => {
      const catalog = stored && this.shape(stored);
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
    // A combined title: the card is its row, and its state is any version's (progress: the latest in progress).
    const catalog = this.resident?.kind === item.kind && this.resident.catalog.grouped ? this.resident.catalog : undefined;
    const g = catalog?.groupOf(item.id);
    const row = (g && catalog?.rowOf(item.id)) || item;
    const ids = g && catalog ? catalog.members(item.id).map((m) => m.item.id) : [item.id];
    let watched = false;
    let favourite = false;
    let progress: VodUserState | undefined;
    for (const id of ids) {
      const s = this.user?.get(id);
      if (!s) continue;
      watched ||= s.watched;
      favourite ||= s.favourite;
      if (isInProgress(s) && s.duration > 0 && (!progress || s.updatedAt > progress.updatedAt)) progress = s;
    }
    const t: VodTile = { id: row.id, kind: row.kind, title: row.title, categoryId: row.categoryId, watched, favourite };
    if (row.poster) t.poster = row.poster;
    if (row.year) t.year = row.year;
    if (row.rating !== undefined) t.rating = row.rating;
    if (progress) t.progress = Math.min(1, progress.position / progress.duration);
    if (g && g.members.length > 1) t.versions = g.members.length;
    const quality = g ? QUALITY_LABELS[g.quality] : undefined;
    if (quality) t.quality = quality;
    return { ...t, ...extra };
  }

  /** The versions of the title `id` belongs to, Play's pick first. Needs `config()` to have run for preferences. */
  private ordered(kind: VodKind, catalog: VodCatalog, id: string, user: Map<string, VodUserState>): Candidate[] {
    const members: VodMember[] = catalog.members(id);
    const g: VodGroup | undefined = catalog.groupOf(id);
    // When a version was last watched: a movie in progress, or any episode of a series version.
    const seriesAt = new Map<string, number>();
    if (kind === 'series' && members.length > 1) {
      for (const s of user.values()) {
        const sid = s.series?.id;
        if (sid && s.updatedAt > (seriesAt.get(sid) ?? -1)) seriesAt.set(sid, s.updatedAt);
      }
    }
    const cands = members.map((m): Candidate => {
      const c: Candidate = { id: m.item.id, item: m.item, quality: m.quality };
      if (m.lang) c.lang = m.lang;
      const s = user.get(m.item.id);
      const at = kind === 'movie' ? (s && isInProgress(s) ? s.updatedAt : undefined) : seriesAt.get(m.item.id);
      if (at !== undefined) c.activeAt = at;
      return c;
    });
    if (cands.length < 2) return cands;
    const cfg = this.cfg;
    const pick = g && cfg ? cfg.picks[kind][g.key] : undefined;
    const langs = preferredLanguages(cfg?.langs ?? [], this.locale());
    return orderVersions(cands, pick ? { pick, langs } : { langs });
  }

  private versionViews(catalog: VodCatalog, ordered: Candidate[]): VersionView[] {
    if (ordered.length < 2) return [];
    const catName = new Map(catalog.source.categories.map((c) => [c.id, c.name]));
    return ordered.map((c, i) => {
      const v: VersionView = { id: c.id, tags: parseVodTitle(c.item.title, catName.get(c.item.categoryId)).tags, auto: i === 0 };
      if (c.lang) v.lang = c.lang;
      const q = QUALITY_LABELS[c.quality];
      if (q) v.quality = q;
      return v;
    });
  }

  /** The combine settings and the user's splits and picks, loaded once per source. Undefined without `settings`. */
  private async config(): Promise<GroupConfig | undefined> {
    const read = this.settingsOf;
    const src = this.sourceId;
    if (!read || !src) return undefined;
    const sourceEpoch = this.sourceEpoch;
    const gen = this.cfgGen;
    if (this.cfg?.sourceEpoch === sourceEpoch) return this.cfg;
    if (this.cfgLoad?.sourceEpoch === sourceEpoch) return this.cfgLoad.p;
    const p = (async (): Promise<GroupConfig | undefined> => {
      const s = await read().catch(() => undefined);
      // Unreadable settings: show the catalogue as stored (never block it).
      if (!s) return undefined;
      const [ms, ss, mp, sp] = s.combineDuplicates
        ? await Promise.all([
          this.vod.getVodSplits(src, 'movie'), this.vod.getVodSplits(src, 'series'),
          this.vod.getVodPicks(src, 'movie'), this.vod.getVodPicks(src, 'series'),
        ]).catch(() => [new Set<string>(), new Set<string>(), {}, {}] as const)
        : [new Set<string>(), new Set<string>(), {}, {}];
      const [ml, sl] = await Promise.all([this.vod.getVodLayout(src, 'movie'), this.vod.getVodLayout(src, 'series')])
        .catch(() => [emptyVodLayout(), emptyVodLayout()] as const);
      const cfg: GroupConfig = {
        sourceEpoch, combine: s.combineDuplicates, langs: [...s.preferredLanguages],
        splits: { movie: ms, series: ss }, picks: { movie: mp, series: sp },
        mergeCategories: s.combineCategories === true, regions: s.regions ?? { codes: [], mode: 'off' },
        layouts: { movie: ml, series: sl },
      };
      if (this.sourceEpoch === sourceEpoch && this.cfgGen === gen) this.cfg = cfg;
      return cfg;
    })();
    this.cfgLoad = { sourceEpoch, p };
    const forget = () => { if (this.cfgLoad?.p === p) this.cfgLoad = undefined; };
    p.then(forget, forget);
    return p;
  }

  /**
   * The catalogue as the settings show it: combined into titles or one card per item, provider categories (or merged
   * across languages when asked), seen through the user's category layout and the region rule.
   */
  private shape(catalog: VodCatalog): VodCatalog {
    const cfg = this.cfg;
    if (!cfg || cfg.sourceEpoch !== this.sourceEpoch) return catalog;
    // Merging categories is part of combining (it needs the title groups); with one card per item it does nothing.
    const merge = cfg.combine && cfg.mergeCategories;
    const shaped = cfg.combine ? catalog.withGroups(groupVod(catalog.source, cfg.splits[catalog.kind], { mergeCategories: merge })) : catalog;
    // Merged categories have lost their language prefix: the region rule needs provider categories.
    const regions = merge ? undefined : { detected: this.detectedOf(catalog.source), codes: cfg.regions.codes, mode: cfg.regions.mode };
    const plainLayout = cfg.layouts[catalog.kind];
    const view = vodCategoryView(shaped.categories(), plainLayout, regions);
    return shaped.withView(view);
  }

  /** Detected regions of a stored list's categories, computed once per list object (category names only change with it). */
  private readonly detected = new WeakMap<VodList, Record<string, GroupRegion>>();
  private detectedOf(list: VodList): Record<string, GroupRegion> {
    let d = this.detected.get(list);
    if (!d) this.detected.set(list, (d = detectVodRegions(list)));
    return d;
  }

  /** The view of the resident (or loaded) catalogue of `kind`, after the config is read. */
  private async shapedView(kind: VodKind): Promise<{ catalog: VodCatalog; cfg: GroupConfig | undefined } | undefined> {
    const catalog = this.sourceId ? await this.catalog(kind) : undefined;
    return catalog ? { catalog, cfg: this.cfg } : undefined;
  }

  /** Your countries over this kind's categories: detected countries with category and title counts, largest first. */
  async regions(kind: VodKind): Promise<RegionsOverview> {
    const got = await this.shapedView(kind);
    const s = got?.cfg?.regions ?? { codes: [], mode: 'off' as const };
    const out: RegionsOverview = {
      mode: s.mode, codes: [...s.codes], stale: false, countries: [], notSure: { groups: 0, channels: 0 }, other: { groups: 0, channels: 0 },
    };
    if (!got || (got.cfg?.combine && got.cfg.mergeCategories)) return out;
    const { catalog } = got;
    const detected = this.detectedOf(catalog.source);
    const all = (catalog.titleGroups ? catalog.titleGroups.categories : catalog.source.categories);
    const view = vodCategoryView(all, got.cfg?.layouts[kind] ?? emptyVodLayout(), { detected, codes: s.codes, mode: s.mode });
    out.stale = view.state.stale;
    const by = new Map<string, RegionCount>();
    for (const c of all) {
      const keys = view.keysOf.get(c.id) ?? [];
      if (!keys.length) {
        const bucket = detected[c.id] ? out.notSure : out.other;
        bucket.groups++;
        bucket.channels += c.count;
        continue;
      }
      for (const code of keys) {
        let r = by.get(code);
        if (!r) by.set(code, (r = { code, label: countryLabel(code), groups: 0, channels: 0 }));
        r.groups++;
        r.channels += c.count;
      }
    }
    out.countries = [...by.values()].sort((a, b) => b.channels - a.channels || b.groups - a.groups);
    return out;
  }

  /** Applies category layout ops for the active source and kind; screens reload with the new view. */
  async applyLayoutOps(kind: VodKind, ops: VodLayoutOp[]): Promise<VodApplyResult | undefined> {
    const id = this.sourceId;
    if (!id) return undefined;
    const res = await this.vod.applyVodLayoutOps(id, kind, ops);
    if (res.changed && this.sourceId === id) {
      if (this.cfg) this.cfg.layouts[kind] = res.layout;
      this.regroup();
    }
    return res;
  }

  /** Drops the resident catalogue and Search indexes so they are rebuilt with the current grouping; screens reload. */
  private regroup(): void {
    const id = this.sourceId;
    if (!id) return;
    const kind = this.resident?.kind ?? this.loading?.kind;
    const count = this.resident?.catalog.source.items.length ?? 0;
    this.resident = undefined;
    this.loading = undefined;
    const searched = this.indexes.size > 0 || this.indexJob !== undefined;
    this.dropIndexes();
    this.indexGens.movie++;
    this.indexGens.series++;
    if (kind) this.emit({ type: 'vodRefreshed', sourceId: id, kind, count, truncated: false });
    if (searched) this.emit({ type: 'searchReady', sourceId: id });
  }

  protected resetDetails(): void {
    this.details.clear();
    this.detailLoads.clear();
  }

  /** Cached detail (most recently used first out); a failure is recorded and not cached: returns null, or with `rethrow` throws the recorded Error. */
  private async detailOf<T extends MovieDetail | SeriesDetail>(item: VodItem, load: () => Promise<T>, rethrow = false): Promise<T | null> {
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
      let settle!: (r: DetailResult) => void;
      const mine: DetailLoad = { epoch, p: new Promise<DetailResult>((resolve) => { settle = resolve; }) };
      entry = mine;
      this.detailLoads.set(item.id, mine);
      void (async () => {
        try {
          const d = await load();
          if (this.epoch === epoch) {
            this.details.set(item.id, d);
            if (this.details.size > VOD_DETAIL_CACHE) this.details.delete(this.details.keys().next().value!);
          }
          settle({ ok: true, d });
        } catch (err) {
          // Recorded once, under a neutral name: every caller sharing this fetch gets the same Error.
          settle({ ok: false, err: this.record(DETAIL_OP, err) });
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

  /**
   * `automatic`: started by `home` (a failure records the refresh backoff), not by the Try again button.
   * `first`: nothing of this kind is on screen, so the titles so far are shown while the list downloads (snapshots
   * become the resident catalogue, `vodProgress` tells the screen). A refresh behind a shown list keeps that list.
   */
  /**
   * Asks whether the stored list of `kind` is stale and, if so, starts the background refresh. One question per kind
   * at a time (a second open joins it); nothing starts once the source changed. Tracked for `idle`.
   */
  private revalidate(kind: VodKind, id: string, epoch: number): void {
    if (this.revalidating.has(kind)) return;
    this.revalidating.add(kind);
    const p = this.vod.needsRefresh(id, kind).then((needs) => {
      if (this.epoch !== epoch || !needs || this.jobs.has(kind) || this.failures.has(kind)) return;
      void this.startFetch(kind, id, epoch, true, false);
    }, (err: unknown) => { this.record('getVodHome', err); }).finally(() => {
      this.revalidating.delete(kind);
      this.pending.delete(p);
    });
    this.pending.add(p);
  }

  private startFetch(kind: VodKind, id: string, epoch: number, automatic = false, first = false): Promise<void> {
    if (this.epoch !== epoch) return Promise.resolve();
    const existing = this.jobs.get(kind);
    if (existing) return existing.done;
    const ac = new AbortController();
    this.emit({ type: 'vodLoading', sourceId: id, kind });
    const onSnapshot = (list: VodList) => {
      if (this.epoch !== epoch || ac.signal.aborted) return;
      // Two first loads at once (Movies, then Series): only the one on screen takes the resident slot.
      if (this.wanted !== kind) return;
      // Like the final swap: never next to (or instead of) a catalogue of the other kind.
      if ((this.loading && this.loading.kind !== kind) || (this.resident && this.resident.kind !== kind)) return;
      if (this.resident?.kind === kind && !this.progress.has(kind) && this.resident.catalog.size > 0) return;
      this.resident = { kind, catalog: this.shape(new VodCatalog(kind, list)) };
      this.loading = undefined;
      this.progress.set(kind, list.items.length);
      this.emit({ type: 'vodProgress', sourceId: id, kind, count: list.items.length });
    };
    const done = (async () => {
      try {
        const r = await this.vod.refresh(id, kind, { signal: ac.signal, automatic, ...(first ? { onSnapshot } : {}) });
        if (this.epoch !== epoch) return;
        this.progress.delete(kind);
        this.failures.delete(kind);
        // Swap the fresh list in without reading it back. It takes over from a stored read of the same kind (which
        // would be older), and never installs next to the other kind: a load or resident of the other kind wins.
        const otherLoading = this.loading !== undefined && this.loading.kind !== kind;
        const otherResident = this.resident !== undefined && this.resident.kind !== kind;
        if (!otherLoading && !otherResident) {
          this.resident = { kind, catalog: this.shape(new VodCatalog(kind, r.list)) };
          this.loading = undefined;
        }
        // Search rebuilds this kind's index from the fresh list on its next query (told below, when it had one).
        const searched = this.indexes.delete(kind);
        this.indexGens[kind]++;
        this.emit({ type: 'vodRefreshed', sourceId: id, kind, count: r.count, truncated: r.truncated });
        if (searched) this.emit({ type: 'searchReady', sourceId: id });
      } catch (err) {
        if (this.epoch !== epoch) return;
        // The titles so far were never stored: a failed first load must not leave them looking like the catalogue.
        if (this.progress.delete(kind)) {
          if (this.resident?.kind === kind) this.resident = undefined;
          // A Search index built from those titles goes too (a build in flight must not install it).
          if (this.indexes.delete(kind)) this.emit({ type: 'searchReady', sourceId: id });
          this.indexGens[kind]++;
        }
        if (err instanceof VodFetchCancelled) return;
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
    const sort: VodSort = catalog.hasAddedDates ? 'added' : 'provider';
    for (const c of catalog.categories()) {
      push(c.id, c.name, c.count, () => catalog.slice(c.id, sort, 0, VOD_ROW_ITEMS).rows.map((item) => this.tile(item)));
    }
    return rows;
  }

  /** Continue watching tiles for this kind, newest first; items no longer in the catalogue are skipped. */
  protected continueItems(kind: VodKind, catalog: VodCatalog, records: VodUserRecord[]): VodTile[] {
    return this.continueEntries(kind, catalog, records).map((e) => e.tile);
  }

  /** `continueItems` with when each was last played: a movie's record, a series' latest episode record. */
  private continueEntries(kind: VodKind, catalog: VodCatalog, records: VodUserRecord[]): StartTimedTile[] {
    // One tile per title: its first (newest) version in the list wins.
    const seen = new Set<string>();
    const once = (id: string): VodItem | undefined => {
      const row = catalog.rowOf(id);
      if (!row || seen.has(row.id)) return undefined;
      seen.add(row.id);
      return row;
    };
    if (kind === 'movie') {
      const at = new Map(records.map((r) => [r.itemId, r.state.updatedAt]));
      return continueMovies(records).flatMap((id) => {
        const item = once(id);
        return item ? [{ tile: this.tile(item), at: at.get(id) ?? 0 }] : [];
      });
    }
    const byId = new Map(records.map((r) => [r.itemId, r.state]));
    const seriesAt = new Map<string, number>();
    for (const r of records) {
      const sid = r.state.series?.id;
      if (sid && r.state.updatedAt > (seriesAt.get(sid) ?? -Infinity)) seriesAt.set(sid, r.state.updatedAt);
    }
    return continueSeries(records).flatMap((e) => {
      const item = once(e.seriesId);
      if (!item) return [];
      const extra: Partial<VodTile> = { badge: episodeLabel(e.season, e.episode) };
      const ep = byId.get(e.episodeId);
      if (e.resumeMs > 0 && ep && ep.duration > 0) extra.progress = Math.min(1, e.resumeMs / ep.duration);
      return [{ tile: this.tile(item, extra), at: seriesAt.get(e.seriesId) ?? 0 }];
    });
  }

  /** Favourite items of this catalogue, A to Z. */
  protected favouriteItems(catalog: VodCatalog, records: VodUserRecord[]): VodItem[] {
    const seen = new Set<string>();
    return records
      .filter((r) => r.state.favourite)
      .flatMap((r) => {
        const item = catalog.rowOf(r.itemId);
        if (!item || seen.has(item.id)) return [];
        seen.add(item.id);
        return [item];
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }
}

/** Resolves on a new macrotask. */
function yieldTask(): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, 0); });
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
