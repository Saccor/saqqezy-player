import { describe, expect, test } from 'vitest';
import { columnHeight, rowShift, rowSlots, rowTops } from './rowSlots.ts';

describe('rowSlots', () => {
  // Poster rows 326 high (label + tile), wide rows 203, rows 36 apart, the first at y 290 (Start's 1080p layout).
  const P = 326;
  const W = 203;
  const slots = (heights: number[], focus: number, mode: 'peek' | 'whole', bottom = 1080) =>
    rowSlots(heights, focus, { top: 290, gap: 36, bottom, peek: 64 }, mode).map((s) => [s.index, s.y]);

  test('two poster rows in full, then a peek of the third (its title and a strip of tiles)', () => {
    expect(slots([P, P, P, P], 0, 'peek')).toEqual([[0, 290], [1, 652], [2, 1014]]);
  });

  test('the focused row stays on top; wide rows let more rows in', () => {
    expect(slots([P, W, W, P, P], 1, 'peek')).toEqual([[1, 290], [2, 529], [3, 768]]);
    expect(slots([W, W, W, W], 0, 'peek')).toEqual([[0, 290], [1, 529], [2, 768], [3, 1007]]);
  });

  test('a row that would show less than the peek is left out; the last row has nothing below', () => {
    expect(slots([P, P, P], 0, 'peek', 1077)).toEqual([[0, 290], [1, 652]]);
    expect(slots([P, P], 1, 'peek')).toEqual([[1, 290]]);
  });

  test('whole: only rows that fit entirely above the bottom (pointer mode keeps the button row free)', () => {
    expect(slots([P, P, P], 0, 'whole', 978)).toEqual([[0, 290], [1, 652]]);
    expect(slots([P, P, P], 0, 'whole', 977)).toEqual([[0, 290]]);
  });

  test('the focused row is always there, whatever its height; no rows, no slots', () => {
    expect(slots([2000], 0, 'whole', 978)).toEqual([[0, 290]]);
    expect(slots([], 0, 'peek')).toEqual([]);
  });

  test("Start's dense frame (rows from 80, gap 28): two wide and two poster rows show in full at 1080p", () => {
    const start = { top: 80, gap: 28, bottom: 1080, peek: 62 };
    const C = 42 + 112; // label + compact tile
    const Q = 42 + 216; // label + Start poster
    expect(rowSlots([C, C, Q, Q, Q], 0, start, 'peek').map((s) => [s.index, s.y])).toEqual([[0, 80], [1, 262], [2, 444], [3, 730], [4, 1016]]);
    // The fourth row ends inside the safe area (1080 - 54).
    expect(730 + Q).toBeLessThanOrEqual(1026);
    // Posters first: still four full rows.
    expect(rowSlots([Q, Q, C, C], 0, start, 'peek').map((s) => s.y)).toEqual([80, 366, 652, 834]);
    expect(834 + C).toBeLessThanOrEqual(1026);
    // Pointer mode keeps the bottom button row (y 978) free: whole rows only.
    expect(rowSlots([C, C, Q, Q, Q], 0, { ...start, bottom: 978 }, 'whole').map((s) => s.index)).toEqual([0, 1, 2]);
  });
});

describe('rowTops', () => {
  test('each row sits `gap` under the one before it, the first at 0', () => {
    expect(rowTops([326, 203, 326], 36)).toEqual([0, 362, 601]);
    expect(rowTops([], 36)).toEqual([]);
  });
});

describe('columnHeight', () => {
  test('the column is as tall as its rows: the last row ends at its bottom edge', () => {
    expect(columnHeight([326, 203, 326], 36)).toBe(601 + 326);
    expect(columnHeight([], 36)).toBe(0);
  });

  // The renderer skips the children of a node whose box is outside its clip (out of bounds), and a node with no height
  // takes its parent's: a column as tall as the clip slid up by more than that lost every row (Start went blank).
  test("whatever row is focused, the slid column still overlaps the clip and holds every row (Start's frame)", () => {
    const C = 42 + 100;
    const Q = 42 + 280;
    const heights = [C, C, Q, Q, Q, Q, Q, Q];
    const gap = 28;
    const top = 184;
    const clipTop = 176;
    const clipH = 1080 - clipTop;
    const tops = rowTops(heights, gap);
    const h = columnHeight(heights, gap);
    heights.forEach((rh, i) => {
      expect(tops[i]! + rh).toBeLessThanOrEqual(h);
      const y = top - clipTop - tops[i]!;
      expect(y + h).toBeGreaterThan(0);
      expect(y).toBeLessThan(clipH);
    });
  });
});

describe('rowShift', () => {
  const P = 326;
  const f = { top: 290, gap: 36, bottom: 1080, peek: 64 };

  test('the first layout, a move of more than two rows or no move at all snaps, with no extra row', () => {
    expect(rowShift([P, P, P, P], undefined, 0, f, 'peek')).toEqual({ snap: true, extra: undefined });
    expect(rowShift([P, P, P, P, P], 0, 3, f, 'peek')).toEqual({ snap: true, extra: undefined });
    expect(rowShift([P, P, P], 1, 1, f, 'peek')).toEqual({ snap: true, extra: undefined });
  });

  test('down: the row that was focused stays mounted while it slides out at the top', () => {
    expect(rowShift([P, P, P, P], 0, 1, f, 'peek')).toEqual({ snap: false, extra: 0 });
    // Two rows down: only the nearer one stays (one extra row at most).
    expect(rowShift([P, P, P, P, P], 0, 2, f, 'peek')).toEqual({ snap: false, extra: 1 });
  });

  test('up: the row pushed off the bottom stays mounted while it slides out', () => {
    // From row 1: rows 1, 2, 3 show; from row 0: rows 0, 1, 2, so row 3 slides out.
    expect(rowShift([P, P, P, P], 1, 0, f, 'peek')).toEqual({ snap: false, extra: 3 });
    // Nothing leaves when the last rows already fit.
    expect(rowShift([P, P], 1, 0, f, 'peek')).toEqual({ snap: false, extra: undefined });
  });

  test('a previous row that no longer exists (the rows changed under it) snaps', () => {
    expect(rowShift([P, P], 5, 1, f, 'peek')).toEqual({ snap: true, extra: undefined });
  });
});
