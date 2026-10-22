/** The Start page rows (spec §2–3; catalogue-personalisation-sync report §5.1–5.2). Pure. */
import type { ChannelRow, SportsEventTile, StartCell, StartHome, StartRow, StartRowId, VodTile } from './types.ts';

export const START_TITLES: Record<StartRowId, string> = {
  continue: 'Continue watching', live: 'On now', sports: 'Matches',
  trendingMovies: 'Trending movies', trendingSeries: 'Trending series',
  newLibrary: 'New in your library',
  topMovies: 'Top rated movies', topSeries: 'Top rated series',
};
/** The matches row while a category filter is on (neutral copy; the chips themselves are the guide's own text). */
export const START_SPORTS_FILTERED_TITLE = `${START_TITLES.sports} (filtered)`;
export const START_CAPS = { continue: 12, live: 30, sports: 12, trending: 20, new: 20, top: 20 } as const;
/** A Top rated row shows only when the library has at least this many rated titles of that kind. */
export const START_TOP_MIN = 6;
/** An unnumbered trending row shows only when at least this many trending titles are in the library. */
export const START_TRENDING_MIN = 4;
/** A Top row is numbered only with at least this many strong matches; at most `START_TOP_RANKED` are numbered. */
export const START_TOP_RANK_MIN = 5;
export const START_TOP_RANKED = 10;
/** A feed built longer ago than this is no longer "this week". */
export const START_TRENDING_FRESH_MS = 3 * 86_400_000;
/** Continue watching leaves out titles not played for this long. */
export const START_CONTINUE_STALE_MS = 60 * 86_400_000;

/** A Continue watching tile and when it was last played (`VodUserState.updatedAt`). */
export interface StartTimedTile { tile: VodTile; at: number }
/** A trending title the library has; `strong`: matched by tmdb id or title and exact year. */
export interface StartTrendTile { tile: VodTile; strong: boolean }
/** One kind's trending matches in feed order, and the feed's build time (ISO 8601). */
export interface StartTrendPart { items: StartTrendTile[]; at?: string }
interface CountedPart { items: VodTile[]; total: number }

export interface StartParts {
  lastChannel?: ChannelRow;
  /** Favourite channels, then recently watched ones: On now fills from them in that order. */
  favourites: ChannelRow[];
  recents: ChannelRow[];
  /** Undefined while unknown (that kind's catalogue never resident), so the cached row stays when both are. */
  continueMovies?: StartTimedTile[];
  continueSeries?: StartTimedTile[];
  /** Matches in your guide: the row's focus set, best first (design note live-matches-ranking §3.5 G8). */
  sports: SportsEventTile[];
  /** Every match See all lists (the View all count); `sports.length` when unknown. */
  sportsTotal?: number;
  /** A category filter applies: View all always shows (the only way back to the chips) and the title says so. */
  sportsFiltered?: boolean;
  newMovies?: CountedPart;
  newSeries?: CountedPart;
  /** The best-rated titles (the provider's `rating`; unrated ones never) and how many are rated. */
  topMovies?: CountedPart;
  topSeries?: CountedPart;
  /**
   * Trending titles the library has (spec 2026-10-20-trending-design §5), feed order; undefined while unknown (no
   * feed copy yet, or that kind's catalogue never resident), so the cached row stays.
   */
  trendingMovies?: StartTrendPart;
  trendingSeries?: StartTrendPart;
}

const row = (id: StartRowId, cells: StartCell[], title = START_TITLES[id]): StartRow => ({ id, title, cells });
const vodCell = (tile: VodTile): StartCell => ({ type: 'vod', tile });

export function assembleStartHome(p: StartParts, at: number, cached?: StartHome): StartHome {
  const fromCache = (id: StartRowId) => cached?.rows.find((r) => r.id === id);
  const rows: (StartRow | undefined)[] = [];

  const sports: StartCell[] = p.sports.slice(0, START_CAPS.sports).map((event) => ({ type: 'event', event }));
  const sportsTotal = Math.max(p.sportsTotal ?? 0, p.sports.length);
  if (sportsTotal > sports.length || p.sportsFiltered) sports.push({ type: 'viewAll', target: 'sports', total: sportsTotal });
  const sportsRow = row('sports', sports, p.sportsFiltered ? START_SPORTS_FILTERED_TITLE : undefined);
  // Matches on top while there are any (owner feedback 2026-10-20); a filtered row with only View all keeps its place.
  const matchesFirst = p.sports.length > 0;
  if (matchesFirst) rows.push(sportsRow);

  rows.push(continueRow(p, at, fromCache('continue')));
  rows.push(row('live', onNowCells(p)));

  const trendMovies = p.trendingMovies === undefined ? fromCache('trendingMovies') : trendRow('trendingMovies', p.trendingMovies, at);
  const trendSeries = p.trendingSeries === undefined ? fromCache('trendingSeries') : trendRow('trendingSeries', p.trendingSeries, at);
  rows.push(trendMovies, trendSeries);

  if (!matchesFirst) rows.push(sportsRow);

  rows.push(newRow(p, fromCache('newLibrary')));

  const topRow = (id: 'topMovies' | 'topSeries', part: CountedPart | undefined, target: 'movie' | 'series', top: StartRow | undefined) => {
    // Off once this kind has a numbered Top row (report §5.1 row 8).
    if (top?.cells.some((c) => c.type === 'vod' && c.rank !== undefined)) return undefined;
    if (part === undefined) return fromCache(id);
    if (part.total < START_TOP_MIN || part.items.length < START_TOP_MIN) return undefined;
    const cells: StartCell[] = part.items.slice(0, START_CAPS.top).map(vodCell);
    if (part.total > START_CAPS.top) cells.push({ type: 'viewAll', target, total: part.total, order: 'rating' });
    return row(id, cells);
  };
  rows.push(topRow('topMovies', p.topMovies, 'movie', trendMovies), topRow('topSeries', p.topSeries, 'series', trendSeries));

  return { at, rows: rows.filter((r): r is StartRow => r !== undefined && r.cells.length > 0) };
}

/** Movies and series merged newest first, stale ones left out, capped; both kinds unknown keeps the cached row. */
function continueRow(p: StartParts, at: number, cached: StartRow | undefined): StartRow | undefined {
  if (p.continueMovies === undefined && p.continueSeries === undefined) return cached;
  const cutoff = at - START_CONTINUE_STALE_MS;
  const all = [...(p.continueMovies ?? []), ...(p.continueSeries ?? [])].filter((e) => e.at >= cutoff);
  // Stable: equal times keep movies before series, each kind in its own order.
  all.sort((a, b) => b.at - a.at);
  return row('continue', all.slice(0, START_CAPS.continue).map((e) => vodCell(e.tile)));
}

/** The last channel, then favourites, then recents; one tile per channel. */
function onNowCells(p: StartParts): StartCell[] {
  const cells: StartCell[] = [];
  const seen = new Set<string>();
  if (p.lastChannel) { cells.push({ type: 'channel', channel: p.lastChannel, last: true }); seen.add(p.lastChannel.id); }
  for (const list of [p.favourites, p.recents]) {
    for (const c of list) {
      if (cells.length >= START_CAPS.live) return cells;
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      cells.push({ type: 'channel', channel: c });
    }
  }
  return cells;
}

/**
 * Top 10 (report §5.2): strong matches numbered 1..N in feed order (rank among the library's titles, no gaps),
 * at most 10; with 5–9 the weak matches follow unnumbered up to 10 cells. Fewer than 5 strong: an unnumbered row
 * of every match, or none below `START_TRENDING_MIN`. "This week" only while the feed is at most 3 days old.
 */
function trendRow(id: 'trendingMovies' | 'trendingSeries', part: StartTrendPart, at: number): StartRow | undefined {
  const noun = id === 'trendingMovies' ? 'movies' : 'series';
  const strong = part.items.filter((t) => t.strong);
  if (strong.length < START_TOP_RANK_MIN) {
    if (part.items.length < START_TRENDING_MIN) return undefined;
    return row(id, part.items.slice(0, START_CAPS.trending).map((t) => vodCell(t.tile)));
  }
  const cells: StartCell[] = strong.slice(0, START_TOP_RANKED).map((t, i) => ({ type: 'vod', tile: t.tile, rank: i + 1 }));
  for (const t of part.items) {
    if (cells.length >= START_TOP_RANKED) break;
    if (!t.strong) cells.push(vodCell(t.tile));
  }
  const built = part.at ? Date.parse(part.at) : NaN;
  const week = Number.isFinite(built) && at - built <= START_TRENDING_FRESH_MS ? ' this week' : '';
  const ranked = Math.min(strong.length, START_TOP_RANKED);
  return row(id, cells, `${ranked >= START_TOP_RANKED ? 'Top 10' : 'Top'} ${noun}${week}`);
}

/**
 * New in your library: movies and series alternating, each in its added order, the longer list's rest after,
 * capped; a View all per kind with more than it shows. A kind still unknown keeps its cells from the cached row.
 */
function newRow(p: StartParts, cached: StartRow | undefined): StartRow | undefined {
  if (p.newMovies === undefined && p.newSeries === undefined) return cached;
  const fromCached = (kind: 'movie' | 'series'): { tiles: VodTile[]; viewAll?: StartCell } => {
    const tiles: VodTile[] = [];
    let viewAll: StartCell | undefined;
    for (const c of cached?.cells ?? []) {
      if (c.type === 'vod' && c.tile.kind === kind) tiles.push(c.tile);
      else if (c.type === 'viewAll' && c.target === kind) viewAll = c;
    }
    return viewAll ? { tiles, viewAll } : { tiles };
  };
  const side = (part: CountedPart | undefined, kind: 'movie' | 'series') =>
    part === undefined ? fromCached(kind) : { tiles: part.items, total: part.total };
  const m: { tiles: VodTile[]; total?: number; viewAll?: StartCell } = side(p.newMovies, 'movie');
  const s: { tiles: VodTile[]; total?: number; viewAll?: StartCell } = side(p.newSeries, 'series');
  const cells: StartCell[] = [];
  let mi = 0;
  let si = 0;
  while (cells.length < START_CAPS.new && (mi < m.tiles.length || si < s.tiles.length)) {
    if (mi < m.tiles.length) cells.push(vodCell(m.tiles[mi++]!));
    if (cells.length < START_CAPS.new && si < s.tiles.length) cells.push(vodCell(s.tiles[si++]!));
  }
  if (!cells.length) return row('newLibrary', []);
  const viewAll = (x: typeof m, shown: number, target: 'movie' | 'series') => {
    if (x.total === undefined) { if (x.viewAll) cells.push(x.viewAll); return; }
    if (x.total > shown) cells.push({ type: 'viewAll', target, total: x.total });
  };
  viewAll(m, mi, 'movie');
  viewAll(s, si, 'series');
  return row('newLibrary', cells);
}
