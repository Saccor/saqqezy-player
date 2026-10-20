import { VOD_ROW_RECENT, type VodHome, type VodTile } from '@iptv/app-api';
import type { VodSort } from '@iptv/core';

/** The Movies browse rows and focus. Pure: no Solid, no Lightning. */

export interface RowModel { id: string; title: string; total: number; items: VodTile[]; loaded: boolean; stale?: boolean }
export type Cell = { kind: 'tile'; tile: VodTile } | { kind: 'viewAll'; total: number } | { kind: 'loading' };
export interface BrowseFocus { row: number; col: number }
/** The focus by identity (row id, tile id), with the indexes as the fallback when either is gone. */
export interface FocusMemory extends BrowseFocus { rowId?: string; tileId?: string }
/** Posters fully visible in a row (a ninth peeks in). */
export const ROW_VISIBLE_COLS = 8;

/** Rows past the first few arrive without items (`getVodHome`); they load as focus comes near. */
export function toRowModels(home: VodHome): RowModel[] {
  return home.rows.filter((r) => r.total > 0).map((r) => ({ id: r.id, title: r.title, total: r.total, items: r.items, loaded: r.items.length > 0 }));
}

/** After a reload: a lazy row that was already loaded keeps its items (with the new title and total); rows that vanished are dropped. */
export function mergeRows(prev: RowModel[], next: RowModel[]): RowModel[] {
  const byId = new Map(prev.map((r) => [r.id, r]));
  return next.map((r) => {
    if (r.loaded) return r;
    const old = byId.get(r.id);
    return old?.loaded ? { ...r, items: old.items.slice(0, r.total), loaded: true, stale: true } : r;
  });
}

/** Tiles, then a View all tile when the row has more titles than items; one loading cell until loaded. */
export function cellCount(r: RowModel): number {
  if (!r.loaded) return 1;
  return r.items.length + (r.total > r.items.length ? 1 : 0);
}

/** Tiles drawn: a row still loading fills its strip with skeleton tiles (its first one is the focusable loading cell). */
export function drawnCells(r: RowModel): number {
  return r.loaded ? cellCount(r) : ROW_VISIBLE_COLS + 1;
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

/**
 * Where a remembered focus is now. Rows above it come and go (Continue watching after a first play, Favourites) and
 * tiles move within a row, so the row is found by id and the column by tile id; the indexes, clamped, only stand in
 * when the row or the tile is gone. A row that has not loaded its items yet keeps the row, on its loading cell.
 */
export function locateFocus(rows: RowModel[], mem: FocusMemory): BrowseFocus {
  const row = mem.rowId === undefined ? -1 : rows.findIndex((r) => r.id === mem.rowId);
  if (row < 0) return clampFocus(rows, mem);
  const r = rows[row]!;
  const col = mem.tileId === undefined ? -1 : r.items.findIndex((t) => t.id === mem.tileId);
  return { row, col: col >= 0 ? col : clampCol(r, mem.col) };
}

/** The focused row and the one below, when not loaded yet (or carried over and stale) and not empty. */
export function rowsToLoad(rows: RowModel[], focusRow: number): number[] {
  return [focusRow, focusRow + 1].filter((i) => rows[i] !== undefined && (!rows[i]!.loaded || rows[i]!.stale) && rows[i]!.total > 0);
}

/** Category rows are sorted like the worker's home rows: by date when the source has dates. */
export function rowSort(rows: RowModel[]): VodSort {
  return rows.some((r) => r.id === VOD_ROW_RECENT) ? 'added' : 'title';
}

/** A wheel step on the rows (pointer mode): vertical moves between rows, horizontal along the row. */
export function wheelKey(dy: number, dx: number): 'up' | 'down' | 'left' | 'right' | undefined {
  if (dy !== 0) return dy > 0 ? 'down' : 'up';
  if (dx !== 0) return dx > 0 ? 'right' : 'left';
  return undefined;
}

/** Skeleton rows stand in for the rows while the first catalogue load runs (spec §3.7). */
export function skeletonShown(status: VodHome['status'] | undefined, rowCount: number): boolean {
  return status === 'loading' && rowCount === 0;
}

export interface SkeletonRect { x: number; y: number; w: number; h: number }
export interface SkeletonRow { label: SkeletonRect; posters: SkeletonRect[] }

const SKELETON_LABEL_W = 260;
const SKELETON_LABEL_H = 20;
const SKELETON_LABEL_GAP = 14;

/**
 * `rows` skeleton rows filling `area` (left edge x, top to bottom): a row label bar, then `cols` portrait (2:3) poster
 * placeholders `gap` apart, with `gap` between rows.
 */
export function skeletonRows(area: { x: number; top: number; bottom: number }, rows = 3, cols = 7, gap = 24): SkeletonRow[] {
  const pitch = Math.floor((area.bottom - area.top + gap) / rows);
  const posterH = Math.max(0, pitch - gap - SKELETON_LABEL_H - SKELETON_LABEL_GAP);
  const posterW = Math.round((posterH * 2) / 3);
  return Array.from({ length: rows }, (_, r) => {
    const y = area.top + r * pitch;
    const py = y + SKELETON_LABEL_H + SKELETON_LABEL_GAP;
    return {
      label: { x: area.x, y, w: SKELETON_LABEL_W, h: SKELETON_LABEL_H },
      posters: Array.from({ length: cols }, (_, c) => ({ x: area.x + c * (posterW + gap), y: py, w: posterW, h: posterH })),
    };
  });
}

/**
 * The rows drawn: the focused one and the next peeking in below. In pointer mode only the focused one: the peek row's
 * label would sit under the shell's Back button.
 */
export function visibleRowIndexes(focusRow: number, rowCount: number, pointer: boolean): number[] {
  return (pointer ? [focusRow] : [focusRow, focusRow + 1]).filter((i) => i >= 0 && i < rowCount);
}
