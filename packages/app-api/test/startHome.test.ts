import { describe, expect, test } from 'vitest';
import { assembleStartHome, START_TOP_MIN, START_TRENDING_MIN } from '../src/startHome.ts';
import type { ChannelRow, SportsEventTile, StartHome, VodTile } from '../src/types.ts';

const chan = (n: number): ChannelRow => ({ id: `c${n}`, number: n, name: `Channel ${n}`, group: 'G', favourite: false });
const vod = (n: number): VodTile => ({ id: `v${n}`, kind: 'movie', title: `Synthetic Film ${n}`, categoryId: '1', watched: false, favourite: false } as VodTile);
const ev = (n: number): SportsEventTile => ({ key: `p:${n}`, title: `Team${n} v Other${n}`, start: 0, stop: 1, channelCount: 2, followed: false });

describe('assembleStartHome', () => {
  test('row order, caps, the last channel first and deduped, View all cells', () => {
    const h = assembleStartHome({
      lastChannel: chan(2), liveNow: [chan(1), chan(2), ...Array.from({ length: 40 }, (_, i) => chan(10 + i))],
      continueVod: [vod(1)], sports: Array.from({ length: 35 }, (_, i) => ev(i)),
      newMovies: { items: Array.from({ length: 20 }, (_, i) => vod(100 + i)), total: 57 }, newSeries: { items: [], total: 0 },
    }, 5);
    expect(h.rows.map((r) => r.id)).toEqual(['continue', 'live', 'sports', 'newMovies']);
    const live = h.rows[1]!.cells;
    expect(live[0]).toEqual({ type: 'channel', channel: chan(2), last: true });
    expect(live.filter((c) => c.type === 'channel' && c.channel.id === 'c2')).toHaveLength(1);
    expect(live).toHaveLength(30);
    expect(h.rows[2]!.cells).toHaveLength(31);
    expect(h.rows[2]!.cells[30]).toEqual({ type: 'viewAll', target: 'sports', total: 35 });
    expect(h.rows[3]!.cells[20]).toEqual({ type: 'viewAll', target: 'movie', total: 57 });
    expect(h.at).toBe(5);
  });

  test('unknown VOD parts keep the cached rows; known empty parts drop them', () => {
    const cached: StartHome = { at: 1, rows: [
      { id: 'continue', title: 'Continue watching', cells: [{ type: 'vod', tile: vod(9) }] },
      { id: 'newSeries', title: 'Recently added series', cells: [{ type: 'vod', tile: vod(8) }] },
    ] };
    const h = assembleStartHome({ liveNow: [], sports: [], newSeries: { items: [], total: 0 } }, 2, cached);
    expect(h.rows.map((r) => r.id)).toEqual(['continue']);
  });

  test('top rated rows: after Recently added of the same kind, hidden below the minimum, View all past the cap', () => {
    const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => vod(from + i));
    const h = assembleStartHome({
      liveNow: [], sports: [],
      newMovies: { items: many(100, 3), total: 3 }, newSeries: { items: many(200, 2), total: 2 },
      topMovies: { items: many(300, 20), total: 48 }, topSeries: { items: many(400, 6), total: 6 },
    }, 3);
    expect(h.rows.map((r) => [r.id, r.title])).toEqual([
      ['newMovies', 'Recently added movies'], ['topMovies', 'Top rated movies'],
      ['newSeries', 'Recently added series'], ['topSeries', 'Top rated series'],
    ]);
    const top = h.rows[1]!.cells;
    expect(top).toHaveLength(21);
    expect(top[20]).toEqual({ type: 'viewAll', target: 'movie', total: 48, order: 'rating' });
    expect(h.rows[3]!.cells).toHaveLength(6);

    // Fewer rated titles than START_TOP_MIN: no row (a short "top" list reads as noise).
    const few = assembleStartHome({ liveNow: [], sports: [], topMovies: { items: many(1, START_TOP_MIN - 1), total: START_TOP_MIN - 1 } }, 4);
    expect(few.rows).toEqual([]);
  });

  test('unknown top rated parts keep the cached rows', () => {
    const cached: StartHome = { at: 1, rows: [{ id: 'topSeries', title: 'Top rated series', cells: [{ type: 'vod', tile: vod(7) }] }] };
    expect(assembleStartHome({ liveNow: [], sports: [] }, 2, cached).rows.map((r) => r.id)).toEqual(['topSeries']);
    expect(assembleStartHome({ liveNow: [], sports: [], topSeries: { items: [], total: 0 } }, 2, cached).rows).toEqual([]);
  });

  test('nothing at all: no rows', () => {
    expect(assembleStartHome({ liveNow: [], sports: [] }, 1).rows).toEqual([]);
  });

  test('trending rows: after Sports, before Recently added; at least 4 tiles, at most 20, no View all', () => {
    const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => vod(from + i));
    const h = assembleStartHome({
      liveNow: [chan(1)], sports: [ev(1)],
      newMovies: { items: many(100, 3), total: 3 },
      trendingMovies: many(500, 25), trendingSeries: many(600, START_TRENDING_MIN),
    }, 3);
    expect(h.rows.map((r) => [r.id, r.title])).toEqual([
      ['live', 'Live now'], ['sports', 'Sports in your guide'],
      ['trendingMovies', 'Trending movies'], ['trendingSeries', 'Trending series'], ['newMovies', 'Recently added movies'],
    ]);
    expect(h.rows[2]!.cells).toHaveLength(20);
    expect(h.rows[2]!.cells.every((c) => c.type === 'vod')).toBe(true);
    expect(h.rows[3]!.cells).toHaveLength(START_TRENDING_MIN);

    const few = assembleStartHome({ liveNow: [], sports: [], trendingMovies: many(1, START_TRENDING_MIN - 1), trendingSeries: [] }, 4);
    expect(few.rows).toEqual([]);
  });

  test('unknown trending parts keep the cached rows; known short ones drop them', () => {
    const cached: StartHome = { at: 1, rows: [
      { id: 'trendingMovies', title: 'Trending movies', cells: [{ type: 'vod', tile: vod(7) }] },
      { id: 'trendingSeries', title: 'Trending series', cells: [{ type: 'vod', tile: vod(8) }] },
    ] };
    expect(assembleStartHome({ liveNow: [], sports: [] }, 2, cached).rows.map((r) => r.id)).toEqual(['trendingMovies', 'trendingSeries']);
    expect(assembleStartHome({ liveNow: [], sports: [], trendingMovies: [], trendingSeries: [vod(1)] }, 2, cached).rows).toEqual([]);
  });
});
