import { describe, expect, it, vi } from 'vitest';
import { EpgCache } from './epgCache.ts';
import {
  CATCHUP_BACK_MAX, HOUR, WINDOW_BACK, buildBlocks, dayJumpTargets, dayJumpView, floorHalfHour, guideBackMs, guideWindow, initialViewStart,
} from './guideLogic.ts';

const D = 24 * HOUR;
const NOW = new Date(2026, 9, 20, 20, 10).getTime();

describe('Guide window with catch-up (spec 2026-10-20-catch-up §5.1)', () => {
  it('keeps 6 h without catch-up; the largest archive otherwise, capped at 7 days', () => {
    expect(guideBackMs(0)).toBe(WINDOW_BACK);
    expect(guideBackMs(3)).toBe(3 * D);
    expect(guideBackMs(14)).toBe(CATCHUP_BACK_MAX);
    const win = guideWindow(NOW, guideBackMs(7));
    expect(win.start).toBe(floorHalfHour(NOW) - 7 * D);
    expect(win.end).toBe(guideWindow(NOW).end);
  });

  it('Go to day: Today, Yesterday, then older days at 18:00, back to the window start', () => {
    const win = guideWindow(NOW, guideBackMs(3));
    const days = dayJumpTargets(NOW, win);
    expect(days.map((d) => d.label)).toEqual(['Today', 'Yesterday', 'Sun 18 Oct', 'Sat 17 Oct']);
    expect(days[0]!.at).toBe(NOW);
    expect(days[1]!.at).toBe(new Date(2026, 9, 19, 18).getTime());
    // The oldest day starts before its 18:00: never before the window.
    expect(days[3]!.at).toBe(Math.max(new Date(2026, 9, 17, 18).getTime(), win.start));
    expect(dayJumpTargets(NOW, guideWindow(NOW)).map((d) => d.label)).toEqual(['Today']);
  });

  it('a day jump opens the view at that evening; Today keeps now', () => {
    const win = guideWindow(NOW, guideBackMs(3));
    const at = new Date(2026, 9, 19, 18).getTime();
    expect(dayJumpView(at, NOW, win)).toEqual({ viewStart: at, anchor: at });
    expect(dayJumpView(NOW, NOW, win)).toEqual({ viewStart: initialViewStart(NOW, win), anchor: NOW });
  });

  it('blocks keep the source\'s archive answer', () => {
    const blocks = buildBlocks([{ title: 'A', start: 0, stop: HOUR, archive: true }, { title: 'B', start: HOUR, stop: 2 * HOUR }], [{ start: 0, end: 2 * HOUR }]);
    expect(blocks.map((b) => b.archive)).toEqual([true, undefined]);
  });
});

describe('EpgCache.stalePage', () => {
  it('keeps the row on screen and refetches its page on the next ensure', async () => {
    const CHUNK = 3 * HOUR;
    const B = 1000 * CHUNK;
    let version = 0;
    const fetch = vi.fn(async (_g: string, offset: number, count: number, from: number) => ({
      total: 40,
      rows: Array.from({ length: count }, (_, i) => ({ channel: { id: `c${offset + i}` }, programmes: [{ title: `v${version}`, start: from, stop: from + HOUR }] })),
    }));
    const cache = new EpgCache<{ id: string }, { title: string; start: number; stop: number }>(fetch, { rowsPerPage: 20, chunkMs: CHUNK });
    cache.setGroup('all', 40);
    await cache.ensure(0, 30, B, B + CHUNK);
    expect(fetch).toHaveBeenCalledTimes(2);
    version = 1;
    cache.stalePage(25);
    expect(cache.programmes(25)[0]!.title).toBe('v0');
    await cache.ensure(0, 30, B, B + CHUNK);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2]!.slice(1, 3)).toEqual([20, 20]);
    expect(cache.programmes(25)[0]!.title).toBe('v1');
    expect(cache.programmes(5)[0]!.title).toBe('v0');
  });
});
