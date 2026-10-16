import { describe, expect, test } from 'vitest';
import { GRID_COLS, GRID_PAGE, gridCellAt, gridMove, gridPage, keepFailedPages, loadSort, nextSort, pagesFor, saveSort, sortsFor, type SortStore } from './gridLogic.ts';

describe('gridLogic', () => {
  test('moves in a 7-column grid', () => {
    expect(GRID_COLS).toBe(7);
    expect(gridMove(0, 'left', 20)).toBe('rail');
    expect(gridMove(7, 'left', 20)).toBe('rail');
    expect(gridMove(3, 'up', 20)).toBe('header');
    expect(gridMove(3, 'right', 20)).toBe(4);
    expect(gridMove(6, 'right', 20)).toBe(6);
    expect(gridMove(19, 'right', 20)).toBe(19);
    expect(gridMove(10, 'up', 20)).toBe(3);
    expect(gridMove(3, 'down', 20)).toBe(10);
    // Down into a shorter last row lands on its last item.
    expect(gridMove(13, 'down', 20)).toBe(19);
    expect(gridMove(15, 'down', 20)).toBe(15);
  });
  test('paging by two rows, clamped', () => {
    expect(gridPage(0, 1, 100)).toBe(14);
    expect(gridPage(95, 1, 100)).toBe(99);
    expect(gridPage(3, -1, 100)).toBe(0);
  });
  test('pages covering an index range', () => {
    expect(GRID_PAGE).toBe(42);
    expect(pagesFor(0, 41)).toEqual([0]);
    expect(pagesFor(40, 90)).toEqual([0, 1, 2]);
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
    });
    test('padding, gaps and tiles past the end hit nothing', () => {
      expect(gridCellAt(5, 20, 0, g, 50)).toBeUndefined();
      expect(gridCellAt(16, 5, 0, g, 50)).toBeUndefined();
      expect(gridCellAt(16 + 105, 20, 0, g, 50)).toBeUndefined();
      expect(gridCellAt(20, 16 + 175, 0, g, 50)).toBeUndefined();
      expect(gridCellAt(16 + 120 * 6, 16 + 200, 0, g, 10)).toBeUndefined();
      expect(gridCellAt(16 + 120 * 7, 20, 0, g, 50)).toBeUndefined();
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
});
