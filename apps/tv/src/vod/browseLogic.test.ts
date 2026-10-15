import { describe, expect, test } from 'vitest';
import type { VodHome, VodTile } from '@iptv/app-api';
import { cellAt, cellCount, clampFocus, moveBrowse, rowSort, rowsToLoad, toRowModels, type RowModel } from './browseLogic.ts';

const tile = (n: number): VodTile => ({ id: `s:m${n}`, kind: 'movie', title: `Synthetic Film ${n}`, categoryId: '1', watched: false, favourite: false });
const row = (id: string, total: number, items: number, loaded = true): RowModel =>
  ({ id, title: id, total, items: Array.from({ length: items }, (_, i) => tile(i)), loaded });

describe('browseLogic', () => {
  test('home rows: rows without items but with titles are not loaded', () => {
    const home: VodHome = { status: 'ready', truncated: false, rows: [
      { id: 'vod:recent', title: 'Recently added', total: 3, items: [tile(1), tile(2), tile(3)] },
      { id: '9', title: 'Late', total: 40, items: [] },
      { id: '8', title: 'None', total: 0, items: [] },
    ] };
    expect(toRowModels(home).map((r) => r.loaded)).toEqual([true, false]);
  });

  test('cells: tiles, a View all tile when more exist, one loading cell before loading', () => {
    expect(cellCount(row('a', 3, 3))).toBe(3);
    expect(cellCount(row('a', 40, 30))).toBe(31);
    expect(cellAt(row('a', 40, 30), 30)).toEqual({ kind: 'viewAll', total: 40 });
    expect(cellAt(row('a', 40, 30), 0)).toMatchObject({ kind: 'tile' });
    expect(cellCount(row('a', 40, 0, false))).toBe(1);
    expect(cellAt(row('a', 40, 0, false), 0)).toEqual({ kind: 'loading' });
  });

  test('cellAt: View all only at items.length with more titles; other out-of-range columns are loading', () => {
    expect(cellAt(row('a', 3, 3), 3)).toEqual({ kind: 'loading' });
    expect(cellAt(row('a', 40, 30), 31)).toEqual({ kind: 'loading' });
  });

  test('left clamps a too-large column back into range', () => {
    expect(moveBrowse([row('a', 3, 3)], { row: 0, col: 9 }, 'left', new Map())).toEqual({ focus: { row: 0, col: 2 } });
  });

  test('down into an unloaded row lands on its loading cell and remembers the column', () => {
    const rows = [row('a', 10, 10), row('b', 40, 0, false)];
    const cols = new Map<string, number>();
    expect(moveBrowse(rows, { row: 0, col: 4 }, 'down', cols)).toEqual({ focus: { row: 1, col: 0 } });
    expect(cols.get('a')).toBe(4);
    expect(moveBrowse(rows, { row: 1, col: 0 }, 'up', cols)).toEqual({ focus: { row: 0, col: 4 } });
  });

  test('rowsToLoad skips empty rows and an already loaded next row', () => {
    const empty: RowModel = { id: 'e', title: 'e', total: 0, items: [], loaded: false };
    expect(rowsToLoad([row('a', 40, 0, false), empty], 0)).toEqual([0]);
    expect(rowsToLoad([row('a', 40, 0, false), row('b', 3, 3)], 0)).toEqual([0]);
  });

  test('moves: left/right clamp, up at the top is an edge, rows remember their column', () => {
    const rows = [row('a', 10, 10), row('b', 3, 3)];
    const cols = new Map<string, number>();
    expect(moveBrowse(rows, { row: 0, col: 0 }, 'left', cols)).toEqual({ focus: { row: 0, col: 0 } });
    expect(moveBrowse(rows, { row: 0, col: 9 }, 'right', cols)).toEqual({ focus: { row: 0, col: 9 } });
    expect(moveBrowse(rows, { row: 0, col: 5 }, 'up', cols)).toEqual({ edge: 'top' });
    // Down from col 5 to a 3-cell row: clamps to 2; the left row remembers 5.
    expect(moveBrowse(rows, { row: 0, col: 5 }, 'down', cols)).toEqual({ focus: { row: 1, col: 2 } });
    expect(moveBrowse(rows, { row: 1, col: 1 }, 'up', cols)).toEqual({ focus: { row: 0, col: 5 } });
    expect(moveBrowse(rows, { row: 1, col: 1 }, 'down', cols)).toEqual({ focus: { row: 1, col: 1 } });
  });

  test('clampFocus after rows shrink', () => {
    expect(clampFocus([row('a', 2, 2)], { row: 3, col: 9 })).toEqual({ row: 0, col: 1 });
    expect(clampFocus([], { row: 3, col: 9 })).toEqual({ row: 0, col: 0 });
  });

  test('rows to load: the focused row and the next, only unloaded rows with titles', () => {
    const rows = [row('a', 3, 3), row('b', 40, 0, false), row('c', 40, 0, false), row('d', 40, 0, false)];
    expect(rowsToLoad(rows, 0)).toEqual([1]);
    expect(rowsToLoad(rows, 1)).toEqual([1, 2]);
    expect(rowsToLoad(rows, 3)).toEqual([3]);
  });

  test('row sort: by date when Recently added exists, else A–Z', () => {
    expect(rowSort([row('vod:recent', 1, 1), row('1', 1, 1)])).toBe('added');
    expect(rowSort([row('1', 1, 1)])).toBe('title');
  });
});
