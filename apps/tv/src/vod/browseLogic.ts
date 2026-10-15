import { VOD_ROW_RECENT, type VodHome, type VodTile } from '@iptv/app-api';
import type { VodSort } from '@iptv/core';

/** The Movies browse rows and focus. Pure: no Solid, no Lightning. */

export interface RowModel { id: string; title: string; total: number; items: VodTile[]; loaded: boolean }
export type Cell = { kind: 'tile'; tile: VodTile } | { kind: 'viewAll'; total: number } | { kind: 'loading' };
export interface BrowseFocus { row: number; col: number }
/** Posters fully visible in a row (a ninth peeks in). */
export const ROW_VISIBLE_COLS = 8;

/** Rows past the first few arrive without items (`getVodHome`); they load as focus comes near. */
export function toRowModels(home: VodHome): RowModel[] {
  return home.rows.filter((r) => r.total > 0).map((r) => ({ id: r.id, title: r.title, total: r.total, items: r.items, loaded: r.items.length > 0 || r.total === 0 }));
}

/** After a reload: a lazy row that was already loaded keeps its items (with the new title and total); rows that vanished are dropped. */
export function mergeRows(prev: RowModel[], next: RowModel[]): RowModel[] {
  const byId = new Map(prev.map((r) => [r.id, r]));
  return next.map((r) => {
    if (r.loaded) return r;
    const old = byId.get(r.id);
    return old?.loaded ? { ...r, items: old.items, loaded: true } : r;
  });
}

/** Tiles, then a View all tile when the row has more titles than items; one loading cell until loaded. */
export function cellCount(r: RowModel): number {
  if (!r.loaded) return 1;
  return r.items.length + (r.total > r.items.length ? 1 : 0);
}

export function cellAt(r: RowModel, col: number): Cell {
  if (!r.loaded) return { kind: 'loading' };
  const t = r.items[col];
  if (t) return { kind: 'tile', tile: t };
  return col === r.items.length && r.total > r.items.length ? { kind: 'viewAll', total: r.total } : { kind: 'loading' };
}

const clampCol = (r: RowModel | undefined, col: number) => (r ? Math.max(0, Math.min(col, cellCount(r) - 1)) : 0);

/** `cols` remembers the last column per row id, so Up then Down returns to the same poster. */
export function moveBrowse(
  rows: RowModel[], f: BrowseFocus, key: 'up' | 'down' | 'left' | 'right', cols: Map<string, number>,
): { focus: BrowseFocus } | { edge: 'top' } {
  const r = rows[f.row];
  if (!r) return { focus: { row: 0, col: 0 } };
  if (key === 'left') return { focus: { row: f.row, col: clampCol(r, f.col - 1) } };
  if (key === 'right') return { focus: { row: f.row, col: clampCol(r, f.col + 1) } };
  if (key === 'up' && f.row === 0) return { edge: 'top' };
  if (key === 'down' && f.row === rows.length - 1) return { focus: f };
  cols.set(r.id, f.col);
  const next = f.row + (key === 'up' ? -1 : 1);
  const target = rows[next]!;
  return { focus: { row: next, col: clampCol(target, cols.get(target.id) ?? f.col) } };
}

export function clampFocus(rows: RowModel[], f: BrowseFocus): BrowseFocus {
  if (rows.length === 0) return { row: 0, col: 0 };
  const row = Math.max(0, Math.min(f.row, rows.length - 1));
  return { row, col: clampCol(rows[row], f.col) };
}

/** The focused row and the one below, when not loaded yet and not empty. */
export function rowsToLoad(rows: RowModel[], focusRow: number): number[] {
  return [focusRow, focusRow + 1].filter((i) => rows[i] !== undefined && !rows[i]!.loaded && rows[i]!.total > 0);
}

/** Category rows are sorted like the worker's home rows: by date when the source has dates. */
export function rowSort(rows: RowModel[]): VodSort {
  return rows.some((r) => r.id === VOD_ROW_RECENT) ? 'added' : 'title';
}
