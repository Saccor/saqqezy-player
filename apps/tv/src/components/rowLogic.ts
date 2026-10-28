/** Row (spec 2026-10-26 §1.3): one virtualised row of tiles. Pure: no Solid, no Lightning. */
import { ROW_VISIBLE_COLS } from '../vod/browseLogic.ts';
import { EP_VISIBLE } from './tileLogic.ts';
import { renderRange, scrollTopFor } from './virtualWindow.ts';

export type RowVariant = 'poster' | 'wide' | 'wideCompact' | 'episode';

/**
 * Tiles fully visible and kept rendered beyond each edge. TVs keep 2 posters: a down move mounts a whole row, each tile
 * ~6 nodes, two rounded shaders and an image load (the old PosterRow's numbers).
 */
export function rowDefaults(variant: RowVariant, tv: boolean): { visible: number; buffer: number } {
  if (variant === 'poster') return { visible: ROW_VISIBLE_COLS, buffer: tv ? 2 : 3 };
  if (variant === 'episode') return { visible: EP_VISIBLE, buffer: 3 };
  return { visible: 5, buffer: 2 };
}

export function rowScroll(focusCol: number | undefined, last: number, visible: number, cells: number): number {
  return focusCol !== undefined ? scrollTopFor(focusCol, last, visible, cells) : Math.min(last, Math.max(0, cells - visible));
}

export function rowCols(scroll: number, visible: number, drawn: number, buffer: number): number[] {
  const r = renderRange(scroll, visible, drawn, buffer);
  return Array.from({ length: r.to - r.from }, (_, i) => r.from + i);
}

/** The column under `px` (row-local), or undefined in a gap or past the last cell. */
export function rowColAt(px: number, scroll: number, pitch: number, w: number, cells: number): number | undefined {
  if (px < 0) return undefined;
  const c = scroll + Math.floor(px / pitch);
  return px % pitch < w && c < cells ? c : undefined;
}

/** The strip snaps on its first position, a pitch change, or a jump of more than a window; otherwise it glides. */
export function rowSnaps(prev: { scroll: number; pitch: number } | undefined, scroll: number, pitch: number, visible: number): boolean {
  return prev === undefined || prev.pitch !== pitch || Math.abs(scroll - prev.scroll) > visible;
}
