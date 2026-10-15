import { describe, expect, test } from 'vitest';
import type { VodHome, VodTile } from '@iptv/app-api';
import { cellAt, cellCount, clampFocus, mergeRows, moveBrowse, rowSort, rowsToLoad, toRowModels, type RowModel } from './browseLogic.ts';

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
  test('mergeRows: a lazy row stays loaded with its items, taking the new title and total', () => {
    const prev = [row('a', 5, 5), row('b', 40, 12)];
    const next = [{ ...row('a', 6, 6), title: 'A2' }, { ...row('b', 41, 0, false), title: 'B2' }];
    const out = mergeRows(prev, next);
    expect(out[0]).toBe(next[0]);
    expect(out[1]!.loaded).toBe(true);
    expect(out[1]!.items).toHaveLength(12);
    expect(out[1]!.title).toBe('B2');
    expect(out[1]!.total).toBe(41);
  });

  test('mergeRows: a row whose id disappeared is dropped; a new lazy row stays unloaded', () => {
    const out = mergeRows([row('a', 5, 5), row('gone', 40, 12)], [row('a', 5, 5), row('fresh', 40, 0, false)]);
    expect(out.map((r) => r.id)).toEqual(['a', 'fresh']);
    expect(out[1]!.loaded).toBe(false);
  });

  test('mergeRows: a loaded next row wins over prev', () => {
    const next = [row('a', 3, 3)];
    expect(mergeRows([row('a', 9, 9)], next)[0]!.items).toHaveLength(3);
  });
});
