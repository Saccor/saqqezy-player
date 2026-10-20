import type { PosterSize, VodSort } from '@iptv/core';
import { LAYOUT } from '../shell/theme.ts';
import { POSTER_GAP } from './posterLogic.ts';

/** The category grid. Pure: no Solid, no Lightning. */

/** Space between two rows of posters (the column gap is the rows' `POSTER_GAP`). */
export const GRID_ROW_GAP = 28;

/** Cell sizes across the content width with `POSTER_GAP` column gaps and `GRID_ROW_GAP` row gaps. */
export function gridLayout(size: PosterSize): { cols: number; cellW: number; cellH: number; rowPitch: number } {
  const cols = size === 'compact' ? 10 : 8;
  const cellW = Math.floor((LAYOUT.contentW - POSTER_GAP * (cols - 1)) / cols);
  const cellH = Math.floor(cellW * 1.5);
  return { cols, cellW, cellH, rowPitch: cellH + GRID_ROW_GAP };
}

export const GRID_COLS = 8;
/** Rows fully visible (a fourth peeks in). */
export const GRID_VIEW_ROWS = 3;
/** The first row's top edge (design px). */
export const GRID_Y = 150;
/** A row past the full ones is drawn only when at least this much of it is on screen. */
const MIN_PEEK = 60;

/**
 * Rows to draw from the top row: the rows that start at least `MIN_PEEK` px above the screen's bottom edge. Each drawn
 * row costs a row of natural-size poster textures (memory on 1 GB TVs), so a sliver of a row is not worth drawing:
 * Standard draws 3 (its fourth row would show 6 px), Compact 4 (its fourth shows 198 px).
 */
export function renderedRows(size: PosterSize): number {
  const { rowPitch } = gridLayout(size);
  let rows = 0;
  while (GRID_Y + rows * rowPitch + MIN_PEEK <= LAYOUT.height) rows++;
  return Math.max(GRID_VIEW_ROWS, rows);
}
/** Tiles per `getVodSlice` page: two screens. */
export const GRID_PAGE = 48;

export function gridMove(index: number, key: 'up' | 'down' | 'left' | 'right', total: number, cols = GRID_COLS): number | 'rail' | 'header' {
  const col = index % cols;
  if (key === 'left') return col === 0 ? 'rail' : index - 1;
  if (key === 'right') return col === cols - 1 || index + 1 >= total ? index : index + 1;
  if (key === 'up') return index < cols ? 'header' : index - cols;
  if (index + cols < total) return index + cols;
  // Down into a shorter last row: its last item; already on the last row: stay.
  const lastRowStart = Math.floor((total - 1) / cols) * cols;
  return index < lastRowStart ? total - 1 : index;
}

export function gridPage(index: number, dir: 1 | -1, total: number, cols = GRID_COLS, rows = GRID_VIEW_ROWS): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(total - 1, index + dir * cols * rows));
}

/** Page numbers covering tile indexes `fromIndex..toIndex` (inclusive). */
export function pagesFor(fromIndex: number, toIndex: number): number[] {
  if (toIndex < fromIndex) return [];
  const out: number[] = [];
  for (let p = Math.floor(fromIndex / GRID_PAGE); p <= Math.floor(toIndex / GRID_PAGE); p++) out.push(p);
  return out;
}

/**
 * After a reload whose page reads were settled one by one: a page that failed keeps the rows it had (trimmed to the
 * new total) instead of turning into loading cells; a failed page that was never loaded stays out (fetched later).
 */
export function keepFailedPages<T>(fresh: ReadonlyMap<number, T[]>, failed: number[], old: ReadonlyMap<number, T[]>, total: number, pageSize: number): Map<number, T[]> {
  const out = new Map(fresh);
  for (const p of failed) {
    const rows = old.get(p);
    const room = total - p * pageSize;
    if (rows && room > 0) out.set(p, rows.slice(0, room));
  }
  return out;
}

export const SORT_LABELS: Record<VodSort, string> = { added: 'Recently added', title: 'A–Z', rating: 'Rating' };

export function sortsFor(hasRecent: boolean): VodSort[] {
  return hasRecent ? ['added', 'title', 'rating'] : ['title', 'rating'];
}

export interface SortStore { getItem(k: string): string | null; setItem(k: string, v: string): void }

const sortKey = (kind: string) => `vodSort:${kind}`;

/** The remembered sort when this source offers it, else the first available. Storage may be missing or throw. */
export function loadSort(kind: string, sorts: VodSort[], store: SortStore | undefined): VodSort {
  try {
    const v = store?.getItem(sortKey(kind));
    if (v && (sorts as string[]).includes(v)) return v as VodSort;
  } catch {
    // Private mode, blocked storage: fall back.
  }
  return sorts[0]!;
}

export function saveSort(kind: string, sort: VodSort, store: SortStore | undefined): void {
  try {
    store?.setItem(sortKey(kind), sort);
  } catch {
    // Not remembered this time.
  }
}

export interface GridGeometry {
  /** Space between the grid node's edge and the first tile (left and top). */
  pad: number;
  cellW: number;
  gap: number;
  /** Distance between two rows. */
  rowPitch: number;
  /** Rendered height of one cell (the rest of the pitch is gap). */
  hitH: number;
}

/** The tile index under a grid-node-local point (design px), or undefined over padding, gaps or past the last tile. */
export function gridCellAt(px: number, py: number, topRow: number, g: GridGeometry, total: number, cols = GRID_COLS): number | undefined {
  const x = px - g.pad;
  const y = py - g.pad;
  if (!(x >= 0) || !(y >= 0)) return undefined;
  const colPitch = g.cellW + g.gap;
  const col = Math.floor(x / colPitch);
  if (col >= cols || x - col * colPitch >= g.cellW) return undefined;
  const row = topRow + Math.floor(y / g.rowPitch);
  if (y - (row - topRow) * g.rowPitch >= g.hitH) return undefined;
  const i = row * cols + col;
  return i < total ? i : undefined;
}
