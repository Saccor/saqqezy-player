import { describe, expect, it } from 'vitest';
import { cardAt } from '../vod/seriesDetailLogic.ts';
import { rowColAt, rowCols, rowDefaults, rowScroll, rowSnaps } from './rowLogic.ts';

describe('row defaults keep each old row\'s numbers', () => {
  it('posters 8 visible (TV buffer 2, desktop 3), wide 5 / 2, episodes 4 / 3', () => {
    expect(rowDefaults('poster', true)).toEqual({ visible: 8, buffer: 2 });
    expect(rowDefaults('poster', false)).toEqual({ visible: 8, buffer: 3 });
    expect(rowDefaults('wide', true)).toEqual({ visible: 5, buffer: 2 });
    expect(rowDefaults('wideCompact', false)).toEqual({ visible: 5, buffer: 2 });
    expect(rowDefaults('episode', true)).toEqual({ visible: 4, buffer: 3 });
  });
});

describe('row scroll and render window', () => {
  it('follows focus, moving as little as possible; without focus it only clamps', () => {
    expect(rowScroll(3, 0, 5, 20)).toBe(0);
    expect(rowScroll(6, 0, 5, 20)).toBe(2);
    expect(rowScroll(undefined, 9, 5, 10)).toBe(5);
    expect(rowScroll(undefined, 2, 5, 10)).toBe(2);
  });
  it('renders the window plus the buffer, inside the drawn cells', () => {
    expect(rowCols(0, 5, 20, 2)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(rowCols(10, 5, 12, 2)).toEqual([8, 9, 10, 11]);
  });
  it('snaps on the first position, a pitch change, or a jump of more than a window', () => {
    expect(rowSnaps(undefined, 0, 100, 5)).toBe(true);
    expect(rowSnaps({ scroll: 0, pitch: 100 }, 1, 120, 5)).toBe(true);
    expect(rowSnaps({ scroll: 0, pitch: 100 }, 6, 100, 5)).toBe(true);
    expect(rowSnaps({ scroll: 0, pitch: 100 }, 5, 100, 5)).toBe(false);
  });
  it('hit test is the episode row\'s cardAt for every row', () => {
    for (const px of [-1, 0, 399, 400, 423, 424, 900, 5000]) {
      expect(rowColAt(px, 2, 424, 400, 10)).toBe(cardAt(px, 2, 424, 400, 10));
    }
  });
});
