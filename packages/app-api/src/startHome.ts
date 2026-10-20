/** The Start page rows (spec §2–3). Pure. */
import type { ChannelRow, SportsEventTile, StartCell, StartHome, StartRow, StartRowId, VodTile } from './types.ts';

export const START_TITLES: Record<StartRowId, string> = {
  continue: 'Continue watching', live: 'Live now', sports: 'Sports in your guide',
  newMovies: 'Recently added movies', newSeries: 'Recently added series',
  topMovies: 'Top rated movies', topSeries: 'Top rated series',
};
export const START_CAPS = { continue: 20, live: 30, sports: 30, new: 20, top: 20 } as const;
/** A Top rated row shows only when the library has at least this many rated titles of that kind. */
export const START_TOP_MIN = 6;

export interface StartParts {
  lastChannel?: ChannelRow;
  liveNow: ChannelRow[];
  continueVod?: VodTile[];
  sports: SportsEventTile[];
  newMovies?: { items: VodTile[]; total: number };
  newSeries?: { items: VodTile[]; total: number };
  /** The best-rated titles (the provider's `rating`; unrated ones never) and how many are rated. */
  topMovies?: { items: VodTile[]; total: number };
  topSeries?: { items: VodTile[]; total: number };
}

const row = (id: StartRowId, cells: StartCell[]): StartRow => ({ id, title: START_TITLES[id], cells });

export function assembleStartHome(p: StartParts, at: number, cached?: StartHome): StartHome {
  const fromCache = (id: StartRowId) => cached?.rows.find((r) => r.id === id);
  const rows: (StartRow | undefined)[] = [];

  rows.push(p.continueVod === undefined ? fromCache('continue')
    : row('continue', p.continueVod.slice(0, START_CAPS.continue).map((tile) => ({ type: 'vod', tile }))));

  const live: StartCell[] = [];
  const seen = new Set<string>();
  if (p.lastChannel) { live.push({ type: 'channel', channel: p.lastChannel, last: true }); seen.add(p.lastChannel.id); }
  for (const c of p.liveNow) {
    if (live.length >= START_CAPS.live) break;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    live.push({ type: 'channel', channel: c });
  }
  rows.push(row('live', live));

  const sports: StartCell[] = p.sports.slice(0, START_CAPS.sports).map((event) => ({ type: 'event', event }));
  if (p.sports.length > START_CAPS.sports) sports.push({ type: 'viewAll', target: 'sports', total: p.sports.length });
  rows.push(row('sports', sports));

  const vodRow = (id: 'newMovies' | 'newSeries', part: StartParts['newMovies'], target: 'movie' | 'series') => {
    if (part === undefined) return fromCache(id);
    const cells: StartCell[] = part.items.slice(0, START_CAPS.new).map((tile) => ({ type: 'vod', tile }));
    if (part.total > START_CAPS.new && cells.length) cells.push({ type: 'viewAll', target, total: part.total });
    return row(id, cells);
  };
  const topRow = (id: 'topMovies' | 'topSeries', part: StartParts['topMovies'], target: 'movie' | 'series') => {
    if (part === undefined) return fromCache(id);
    if (part.total < START_TOP_MIN || part.items.length < START_TOP_MIN) return undefined;
    const cells: StartCell[] = part.items.slice(0, START_CAPS.top).map((tile) => ({ type: 'vod', tile }));
    if (part.total > START_CAPS.top) cells.push({ type: 'viewAll', target, total: part.total, order: 'rating' });
    return row(id, cells);
  };
  rows.push(
    vodRow('newMovies', p.newMovies, 'movie'), topRow('topMovies', p.topMovies, 'movie'),
    vodRow('newSeries', p.newSeries, 'series'), topRow('topSeries', p.topSeries, 'series'),
  );

  return { at, rows: rows.filter((r): r is StartRow => r !== undefined && r.cells.length > 0) };
}
