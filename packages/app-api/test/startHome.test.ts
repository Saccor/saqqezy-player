import { describe, expect, test } from 'vitest';
import {
  assembleStartHome, START_CAPS, START_CONTINUE_STALE_MS, START_TOP_MIN, START_TRENDING_FRESH_MS, START_TRENDING_MIN,
  type StartTrendTile,
} from '../src/startHome.ts';
import type { ChannelRow, SportsEventTile, StartCell, StartHome, VodTile } from '../src/types.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const chan = (n: number, extra: Partial<ChannelRow> = {}): ChannelRow =>
  ({ id: `c${n}`, number: n, name: `Channel ${n}`, group: 'G', favourite: false, ...extra });
const vod = (n: number, kind: 'movie' | 'series' = 'movie'): VodTile =>
  ({ id: `${kind[0]}${n}`, kind, title: `Synthetic ${kind} ${n}`, categoryId: '1', watched: false, favourite: false } as VodTile);
const ev = (n: number): SportsEventTile => ({ key: `p:${n}`, title: `Team${n} v Other${n}`, start: 0, stop: 1, channelCount: 2, followed: false });
const many = (from: number, n: number, kind: 'movie' | 'series' = 'movie') => Array.from({ length: n }, (_, i) => vod(from + i, kind));
const base = { favourites: [] as ChannelRow[], recents: [] as ChannelRow[], sports: [] as SportsEventTile[] };
const ids = (cells: StartCell[]) => cells.map((c) => (c.type === 'vod' ? c.tile.id : c.type === 'channel' ? c.channel.id : c.type));
const ranks = (cells: StartCell[]) => cells.map((c) => (c.type === 'vod' ? c.rank : undefined));
const trend = (strong: boolean[], kind: 'movie' | 'series' = 'movie', from = 500): StartTrendTile[] =>
  strong.map((s, i) => ({ tile: vod(from + i, kind), strong: s }));
const fresh = new Date(NOW - DAY).toISOString();

describe('assembleStartHome: row order', () => {
  test('matches first (when it has any), then continue, on now, Top movies, Top series, new in your library, top rated; empty rows never drawn', () => {
    const h = assembleStartHome({
      ...base, favourites: [chan(1)], sports: [ev(1)],
      continueMovies: [{ tile: vod(1), at: NOW }],
      trendingMovies: { items: trend(Array(4).fill(false)), at: fresh },
      trendingSeries: { items: trend(Array(4).fill(false), 'series'), at: fresh },
      newMovies: { items: many(100, 3), total: 3 },
      topMovies: { items: many(300, 6), total: 6 }, topSeries: { items: many(400, 6, 'series'), total: 6 },
    }, NOW);
    expect(h.rows.map((r) => [r.id, r.title])).toEqual([
      ['sports', 'Matches'], ['continue', 'Continue watching'], ['live', 'On now'],
      ['trendingMovies', 'Trending movies'], ['trendingSeries', 'Trending series'],
      ['newLibrary', 'New in your library'], ['topMovies', 'Top rated movies'], ['topSeries', 'Top rated series'],
    ]);
    expect(h.at).toBe(NOW);
  });

  test('a filtered matches row with no match (only View all) keeps its place after the trending rows', () => {
    const h = assembleStartHome({
      ...base, favourites: [chan(1)], sports: [], sportsTotal: 0, sportsFiltered: true,
      continueMovies: [{ tile: vod(1), at: NOW }], newMovies: { items: many(100, 3), total: 3 },
    }, NOW);
    expect(h.rows.map((r) => r.id)).toEqual(['continue', 'live', 'sports', 'newLibrary']);
  });

  test('nothing at all: no rows', () => {
    expect(assembleStartHome(base, 1).rows).toEqual([]);
  });

  test('matches: capped at 12, View all past the cap', () => {
    const h = assembleStartHome({ ...base, sports: Array.from({ length: 35 }, (_, i) => ev(i)) }, NOW);
    expect(h.rows[0]!.cells).toHaveLength(13);
    expect(h.rows[0]!.cells[12]).toEqual({ type: 'viewAll', target: 'sports', total: 35 });
  });

  test('matches: the row is the focus set; View all counts every match in See all', () => {
    const h = assembleStartHome({ ...base, sports: [ev(1), ev(2), ev(3), ev(4)], sportsTotal: 9 }, NOW);
    expect(h.rows[0]!.title).toBe('Matches');
    expect(h.rows[0]!.cells).toHaveLength(5);
    expect(h.rows[0]!.cells[4]).toEqual({ type: 'viewAll', target: 'sports', total: 9 });
    expect(assembleStartHome({ ...base, sports: [ev(1)], sportsTotal: 1 }, NOW).rows[0]!.cells).toHaveLength(1);
  });

  test('no big match but smaller ones in See all: the Matches row is only its View all cell, after the other rows', () => {
    const h = assembleStartHome({ ...base, favourites: [chan(1)], sports: [], sportsTotal: 7 }, NOW);
    const r = h.rows.find((x) => x.id === 'sports')!;
    expect(r.cells).toEqual([{ type: 'viewAll', target: 'sports', total: 7 }]);
    expect(h.rows[0]!.id).not.toBe('sports');
  });

  test('a category filter on: View all always shows (the way back to the chips), the row stays at 0 matches, the title says so', () => {
    const few = assembleStartHome({ ...base, sports: [ev(1), ev(2)], sportsTotal: 2, sportsFiltered: true }, NOW);
    expect(few.rows[0]!.title).toBe('Matches (filtered)');
    expect(few.rows[0]!.cells).toHaveLength(3);
    expect(few.rows[0]!.cells[2]).toEqual({ type: 'viewAll', target: 'sports', total: 2 });
    const none = assembleStartHome({ ...base, sports: [], sportsTotal: 0, sportsFiltered: true }, NOW);
    expect(none.rows.map((r) => r.id)).toEqual(['sports']);
    expect(none.rows[0]!.cells).toEqual([{ type: 'viewAll', target: 'sports', total: 0 }]);
    expect(assembleStartHome({ ...base, sports: [], sportsTotal: 0 }, NOW).rows).toEqual([]);
  });
});

describe('assembleStartHome: Continue watching', () => {
  test('movies and series merged newest first, capped at 12', () => {
    const h = assembleStartHome({
      ...base,
      continueMovies: [{ tile: vod(1), at: NOW - 1 }, { tile: vod(2), at: NOW - 30 }],
      continueSeries: [{ tile: vod(3, 'series'), at: NOW - 10 }, { tile: vod(4, 'series'), at: NOW - 40 }],
    }, NOW);
    expect(ids(h.rows[0]!.cells)).toEqual(['m1', 's3', 'm2', 's4']);

    const lots = assembleStartHome({
      ...base,
      continueMovies: many(1, 10).map((tile, i) => ({ tile, at: NOW - i * 2 })),
      continueSeries: many(1, 10, 'series').map((tile, i) => ({ tile, at: NOW - i * 2 - 1 })),
    }, NOW);
    expect(START_CAPS.continue).toBe(12);
    expect(lots.rows[0]!.cells).toHaveLength(12);
  });

  test('entries older than 60 days are left out; the series badge and progress stay on the tile', () => {
    const tile = { ...vod(3, 'series'), badge: 'S2 · E5', progress: 0.25 };
    const h = assembleStartHome({
      ...base,
      continueMovies: [{ tile: vod(1), at: NOW - START_CONTINUE_STALE_MS - 1 }],
      continueSeries: [{ tile, at: NOW - START_CONTINUE_STALE_MS }],
    }, NOW);
    expect(START_CONTINUE_STALE_MS).toBe(60 * DAY);
    expect(h.rows[0]!.cells).toEqual([{ type: 'vod', tile }]);
  });

  test('unknown continue parts keep the cached row; a known empty one drops it', () => {
    const cached: StartHome = { at: 1, rows: [{ id: 'continue', title: 'Continue watching', cells: [{ type: 'vod', tile: vod(9) }] }] };
    expect(assembleStartHome(base, 2, cached).rows.map((r) => r.id)).toEqual(['continue']);
    expect(assembleStartHome({ ...base, continueMovies: [] }, 2, cached).rows).toEqual([]);
  });
});

describe('assembleStartHome: On now on your channels', () => {
  test('the last channel, then favourites, then recents to fill; one tile per channel; capped', () => {
    const h = assembleStartHome({
      ...base, lastChannel: chan(2),
      favourites: [chan(1, { favourite: true }), chan(2, { favourite: true })],
      recents: [chan(3), chan(1), chan(4)],
    }, NOW);
    const cells = h.rows[0]!.cells;
    expect(ids(cells)).toEqual(['c2', 'c1', 'c3', 'c4']);
    expect(cells[0]).toEqual({ type: 'channel', channel: chan(2), last: true });

    const full = assembleStartHome({ ...base, recents: Array.from({ length: 40 }, (_, i) => chan(10 + i)) }, NOW);
    expect(full.rows[0]!.cells).toHaveLength(START_CAPS.live);
  });

  test('the programme on now keeps its start and stop (the progress bar)', () => {
    const now = { title: 'Synthetic Show', start: NOW - 600_000, stop: NOW + 1_200_000 };
    const h = assembleStartHome({ ...base, favourites: [chan(1, { now })] }, NOW);
    const c = h.rows[0]!.cells[0]!;
    expect(c.type === 'channel' && c.channel.now).toEqual(now);
  });
});

describe('assembleStartHome: Top 10', () => {
  test('10+ strong matches: "Top 10 … this week", ranks 1..10 among owned strong titles, no gaps', () => {
    const items = trend([true, false, true, true, true, true, true, true, true, true, true, true]);
    const h = assembleStartHome({ ...base, trendingMovies: { items, at: fresh } }, NOW);
    const r = h.rows[0]!;
    expect(r.title).toBe('Top 10 movies this week');
    expect(r.cells).toHaveLength(10);
    expect(ranks(r.cells)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(ids(r.cells)).not.toContain('m501'); // the weak match is not numbered and the row is full
  });

  test('5–9 strong: "Top … this week" numbered 1..N, then the weak matches unnumbered', () => {
    const items = trend([false, true, true, false, true, true, true]);
    const h = assembleStartHome({ ...base, trendingSeries: { items: items.map((t) => ({ ...t, tile: { ...t.tile, kind: 'series' } })), at: fresh } }, NOW);
    const r = h.rows[0]!;
    expect(r.id).toBe('trendingSeries');
    expect(r.title).toBe('Top series this week');
    expect(ids(r.cells)).toEqual(['m501', 'm502', 'm504', 'm505', 'm506', 'm500', 'm503']);
    expect(ranks(r.cells)).toEqual([1, 2, 3, 4, 5, undefined, undefined]);
  });

  test('fewer than 5 strong: an unnumbered row in feed order when at least START_TRENDING_MIN, else hidden', () => {
    const h = assembleStartHome({ ...base, trendingMovies: { items: trend([false, true, false, true, true, false]), at: fresh } }, NOW);
    expect(h.rows[0]!.title).toBe('Trending movies');
    expect(ids(h.rows[0]!.cells)).toEqual(['m500', 'm501', 'm502', 'm503', 'm504', 'm505']);
    expect(ranks(h.rows[0]!.cells).every((x) => x === undefined)).toBe(true);
    expect(h.rows[0]!.cells[0]).toEqual({ type: 'vod', tile: vod(500) });

    const few = assembleStartHome({ ...base, trendingMovies: { items: trend(Array(START_TRENDING_MIN - 1).fill(true)), at: fresh } }, NOW);
    expect(few.rows).toEqual([]);
  });

  test('a feed older than 3 days (or without a date) drops "this week"', () => {
    const items = trend(Array(10).fill(true));
    const old = new Date(NOW - START_TRENDING_FRESH_MS - 1).toISOString();
    expect(START_TRENDING_FRESH_MS).toBe(3 * DAY);
    expect(assembleStartHome({ ...base, trendingMovies: { items, at: old } }, NOW).rows[0]!.title).toBe('Top 10 movies');
    expect(assembleStartHome({ ...base, trendingMovies: { items: items.slice(0, 6) } }, NOW).rows[0]!.title).toBe('Top movies');
    expect(assembleStartHome({ ...base, trendingMovies: { items, at: new Date(NOW - START_TRENDING_FRESH_MS).toISOString() } }, NOW)
      .rows[0]!.title).toBe('Top 10 movies this week');
  });

  test('unknown trending parts keep the cached rows; known short ones drop them', () => {
    const cached: StartHome = { at: 1, rows: [
      { id: 'trendingMovies', title: 'Top 10 movies this week', cells: [{ type: 'vod', tile: vod(7), rank: 1 }] },
      { id: 'trendingSeries', title: 'Trending series', cells: [{ type: 'vod', tile: vod(8) }] },
    ] };
    expect(assembleStartHome(base, 2, cached).rows.map((r) => r.id)).toEqual(['trendingMovies', 'trendingSeries']);
    expect(assembleStartHome({ ...base, trendingMovies: { items: [] }, trendingSeries: { items: trend([true]) } }, 2, cached).rows).toEqual([]);
  });
});

describe('assembleStartHome: New in your library', () => {
  test('movies and series alternate, each in its added order; the rest of the longer list follows; View all per kind', () => {
    const h = assembleStartHome({
      ...base,
      newMovies: { items: many(1, 3), total: 3 },
      newSeries: { items: many(1, 15, 'series'), total: 40 },
    }, NOW);
    const r = h.rows[0]!;
    expect(r.id).toBe('newLibrary');
    expect(ids(r.cells).slice(0, 8)).toEqual(['m1', 's1', 'm2', 's2', 'm3', 's3', 's4', 's5']);
    expect(r.cells.filter((c) => c.type === 'vod')).toHaveLength(18);
    expect(r.cells.at(-1)).toEqual({ type: 'viewAll', target: 'series', total: 40 });
    expect(r.cells.filter((c) => c.type === 'viewAll')).toHaveLength(1);
  });

  test('capped at START_CAPS.new tiles, half each when both are long; View all for each kind cut short', () => {
    const h = assembleStartHome({ ...base, newMovies: { items: many(1, 20), total: 57 }, newSeries: { items: many(1, 20, 'series'), total: 20 } }, NOW);
    const cells = h.rows[0]!.cells;
    expect(cells.filter((c) => c.type === 'vod')).toHaveLength(START_CAPS.new);
    expect(cells.slice(START_CAPS.new)).toEqual([
      { type: 'viewAll', target: 'movie', total: 57 }, { type: 'viewAll', target: 'series', total: 20 },
    ]);
  });

  test('an unknown kind keeps its cells from the cached row; both unknown keep the row; both empty drop it', () => {
    const cached: StartHome = { at: 1, rows: [{ id: 'newLibrary', title: 'New in your library', cells: [
      { type: 'vod', tile: vod(9) }, { type: 'vod', tile: vod(8, 'series') }, { type: 'vod', tile: vod(7, 'series') },
      { type: 'viewAll', target: 'series', total: 30 },
    ] }] };
    expect(assembleStartHome(base, 2, cached).rows).toEqual(cached.rows);
    const h = assembleStartHome({ ...base, newMovies: { items: many(1, 2), total: 2 } }, 2, cached);
    expect(ids(h.rows[0]!.cells)).toEqual(['m1', 's8', 'm2', 's7', 'viewAll']);
    expect(assembleStartHome({ ...base, newMovies: { items: [], total: 0 }, newSeries: { items: [], total: 0 } }, 2, cached).rows).toEqual([]);
  });
});

describe('assembleStartHome: Top rated', () => {
  test('hidden below the minimum, View all past the cap', () => {
    const h = assembleStartHome({ ...base, topMovies: { items: many(300, 20), total: 48 }, topSeries: { items: many(400, 6, 'series'), total: 6 } }, NOW);
    expect(h.rows.map((r) => r.id)).toEqual(['topMovies', 'topSeries']);
    expect(h.rows[0]!.cells).toHaveLength(21);
    expect(h.rows[0]!.cells[20]).toEqual({ type: 'viewAll', target: 'movie', total: 48, order: 'rating' });
    const few = assembleStartHome({ ...base, topMovies: { items: many(1, START_TOP_MIN - 1), total: START_TOP_MIN - 1 } }, 4);
    expect(few.rows).toEqual([]);
  });

  test('off for a kind once that kind has a numbered Top row (an unnumbered one keeps it)', () => {
    const h = assembleStartHome({
      ...base,
      trendingMovies: { items: trend(Array(6).fill(true)), at: fresh },
      trendingSeries: { items: trend(Array(6).fill(false), 'series'), at: fresh },
      topMovies: { items: many(300, 6), total: 6 }, topSeries: { items: many(400, 6, 'series'), total: 6 },
    }, NOW);
    expect(h.rows.map((r) => r.id)).toEqual(['trendingMovies', 'trendingSeries', 'topSeries']);
  });

  test('unknown top rated parts keep the cached rows', () => {
    const cached: StartHome = { at: 1, rows: [{ id: 'topSeries', title: 'Top rated series', cells: [{ type: 'vod', tile: vod(7) }] }] };
    expect(assembleStartHome(base, 2, cached).rows.map((r) => r.id)).toEqual(['topSeries']);
    expect(assembleStartHome({ ...base, topSeries: { items: [], total: 0 } }, 2, cached).rows).toEqual([]);
  });
});
