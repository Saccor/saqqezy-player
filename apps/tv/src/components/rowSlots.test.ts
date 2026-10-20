import { describe, expect, test } from 'vitest';
import { rowSlots } from './rowSlots.ts';

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

  test("Start's compact frame (rows from 184, gap 28): matches, on now, two poster rows show at 1080p", () => {
    const start = { top: 184, gap: 28, bottom: 1080, peek: 62 };
    const C = 42 + 100; // label + compact tile
    const Q = 42 + 280; // label + poster
    expect(rowSlots([C, C, Q, Q, Q], 0, start, 'peek').map((s) => [s.index, s.y])).toEqual([[0, 184], [1, 354], [2, 524], [3, 874]]);
    // Pointer mode keeps the bottom button row (y 978) free: whole rows only.
    expect(rowSlots([C, C, Q, Q, Q], 0, { ...start, bottom: 978 }, 'whole').map((s) => s.index)).toEqual([0, 1, 2]);
  });
});
