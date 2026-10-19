import { describe, expect, test } from 'vitest';
import { assembleStartHome } from '../src/startHome.ts';
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

  test('nothing at all: no rows', () => {
    expect(assembleStartHome({ liveNow: [], sports: [] }, 1).rows).toEqual([]);
  });
});
