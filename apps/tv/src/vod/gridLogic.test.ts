import { describe, expect, test } from 'vitest';
import { GRID_COLS, GRID_PAGE, GRID_VIEW_ROWS, GRID_Y, renderedRows, gridCellAt, gridLayout, gridMove, gridPage, keepFailedPages, loadSort, nextSort, pagesFor, saveSort, sortsFor, type SortStore } from './gridLogic.ts';

describe('gridLogic', () => {
  test('moves in an 8-column grid', () => {
    expect(GRID_COLS).toBe(8);
    expect(gridMove(0, 'left', 30)).toBe('rail');
    expect(gridMove(8, 'left', 30)).toBe('rail');
    expect(gridMove(3, 'up', 30)).toBe('header');
    expect(gridMove(3, 'right', 30)).toBe(4);
    expect(gridMove(7, 'right', 30)).toBe(7);
    expect(gridMove(29, 'right', 30)).toBe(29);
    expect(gridMove(11, 'up', 30)).toBe(3);
    expect(gridMove(3, 'down', 30)).toBe(11);
    // Down into a shorter last row lands on its last item.
    expect(gridMove(19, 'down', 30)).toBe(27);
    expect(gridMove(23, 'down', 30)).toBe(29);
    expect(gridMove(25, 'down', 30)).toBe(25);
  });
  test('other column counts (Compact)', () => {
    expect(gridMove(9, 'right', 30, 10)).toBe(9);
    expect(gridMove(10, 'left', 30, 10)).toBe('rail');
    expect(gridMove(5, 'down', 30, 10)).toBe(15);
  });
  test('paging by three rows, clamped', () => {
    expect(gridPage(0, 1, 100)).toBe(24);
    expect(gridPage(95, 1, 100)).toBe(99);
    expect(gridPage(3, -1, 100)).toBe(0);
    expect(gridPage(0, 1, 100, 10, 3)).toBe(30);
  });
  test('pages covering an index range', () => {
    expect(GRID_PAGE).toBe(48);
    expect(pagesFor(0, 47)).toEqual([0]);
    expect(pagesFor(40, 100)).toEqual([0, 1, 2]);
    expect(pagesFor(5, 4)).toEqual([]);
  });
  test('sorts and memory', () => {
    expect(sortsFor(true)).toEqual(['added', 'title', 'rating']);
    expect(sortsFor(false)).toEqual(['title', 'rating']);
    expect(nextSort('rating', ['added', 'title', 'rating'])).toBe('added');
    expect(nextSort('added', ['title', 'rating'])).toBe('title');
    const data = new Map<string, string>();
    const store: SortStore = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
    expect(loadSort('movie', ['added', 'title'], store)).toBe('added');
    saveSort('movie', 'title', store);
    expect(loadSort('movie', ['added', 'title'], store)).toBe('title');
    saveSort('movie', 'added', store);
    expect(loadSort('movie', ['title', 'rating'], store)).toBe('title');
    const broken: SortStore = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadSort('movie', ['title'], broken)).toBe('title');
    expect(() => saveSort('movie', 'title', broken)).not.toThrow();
    expect(loadSort('movie', ['title'], undefined)).toBe('title');
  });

  describe('gridCellAt', () => {
    const g = { pad: 16, cellW: 100, gap: 20, rowPitch: 200, hitH: 170 };
    test('maps a local point to a tile, honouring the scroll row', () => {
      expect(gridCellAt(16, 16, 0, g, 50)).toBe(0);
      expect(gridCellAt(16 + 120 * 2 + 50, 16 + 100, 0, g, 50)).toBe(2);
      expect(gridCellAt(16, 16 + 200, 0, g, 50)).toBe(GRID_COLS);
      expect(gridCellAt(16, 16, 3, g, 50)).toBe(3 * GRID_COLS);
      expect(gridCellAt(16, 16 + 200, 0, g, 50, 10)).toBe(10);
    });
    test('padding, gaps and tiles past the end hit nothing', () => {
      expect(gridCellAt(5, 20, 0, g, 50)).toBeUndefined();
      expect(gridCellAt(16, 5, 0, g, 50)).toBeUndefined();
      expect(gridCellAt(16 + 105, 20, 0, g, 50)).toBeUndefined();
      expect(gridCellAt(20, 16 + 175, 0, g, 50)).toBeUndefined();
      expect(gridCellAt(16 + 120 * 6, 16 + 200, 0, g, 10)).toBeUndefined();
      expect(gridCellAt(16 + 120 * GRID_COLS, 20, 0, g, 50)).toBeUndefined();
      expect(gridCellAt(Number.NaN, 20, 0, g, 50)).toBeUndefined();
    });
  });

  test('keepFailedPages: a page that failed to reload keeps its old rows (trimmed to the new total); others stay out', () => {
    const fresh = new Map<number, string[]>([[0, ['a']]]);
    const old = new Map<number, string[]>([[0, ['x']], [1, ['b', 'c', 'd']], [2, ['e']]]);
    const out = keepFailedPages(fresh, [1, 3], old, 3 + 2, 3);
    expect([...out.entries()]).toEqual([[0, ['a']], [1, ['b', 'c']]]);
    expect(out).not.toBe(fresh);
  });

  test('grid layout per poster size', () => {
    expect(gridLayout('standard')).toEqual({ cols: 8, cellW: 187, cellH: 280, rowPitch: 308 });
    expect(gridLayout('compact')).toEqual({ cols: 10, cellW: 144, cellH: 216, rowPitch: 244 });
  });

  test('rendered rows: the full rows, plus the next one only when at least 60 px of it shows', () => {
    // Standard: rows at 150, 458, 766; the fourth starts at 1074 and would show 6 px, so it is not drawn.
    expect(GRID_Y + 3 * gridLayout('standard').rowPitch).toBe(1074);
    expect(renderedRows('standard')).toBe(3);
    // Compact: the fourth starts at 882 and shows 198 px; the fifth (1126) is off screen.
    expect(renderedRows('compact')).toBe(4);
    // Never fewer rows than the ones scrolled by.
    expect(renderedRows('standard')).toBeGreaterThanOrEqual(GRID_VIEW_ROWS);
  });
});
