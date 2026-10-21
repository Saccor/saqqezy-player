/** Where a vertically paged list of rows sits on screen (Start, Movies, Series). Pure: no Solid, no Lightning. */

/** `top` is the focused row's y, `bottom` the lowest edge any row may reach. */
export interface RowFrame { top: number; gap: number; bottom: number; peek: number }

/**
 * The rows on screen, the focused one on top (the page scrolls a row at a time) and the rows after it below, each
 * `gap` under the last. `peek`: a row is drawn while at least `peek` of it (its title and a strip of tiles) shows
 * above `bottom`, so the next row always shows its title. `whole` (pointer mode, which keeps the bottom button row
 * free): only rows that fit entirely. The focused row is always there.
 */
export function rowSlots(heights: readonly number[], focusRow: number, f: RowFrame, mode: 'peek' | 'whole'): { index: number; y: number }[] {
  if (focusRow < 0 || focusRow >= heights.length) return [];
  const out = [{ index: focusRow, y: f.top }];
  let y = f.top + heights[focusRow]! + f.gap;
  for (let i = focusRow + 1; i < heights.length; i++) {
    const need = mode === 'peek' ? Math.min(f.peek, heights[i]!) : heights[i]!;
    if (y + need > f.bottom) break;
    out.push({ index: i, y });
    y += heights[i]! + f.gap;
  }
  return out;
}

/** Each row's top in the column that holds them all (the first row at 0), each `gap` under the last. */
export function rowTops(heights: readonly number[], gap: number): number[] {
  const out: number[] = [];
  let y = 0;
  for (const h of heights) { out.push(y); y += h + gap; }
  return out;
}

/**
 * The column's height: its last row's bottom edge. The column node needs it explicitly: a node with no height takes its
 * parent's (the clip's), and once the column slides up by more than that, the renderer counts it out of bounds and
 * stops updating every row in it (they are never drawn).
 */
export function columnHeight(heights: readonly number[], gap: number): number {
  if (heights.length === 0) return 0;
  return rowTops(heights, gap)[heights.length - 1]! + heights[heights.length - 1]!;
}

/** The column glides over at most this many rows; a longer move (Home/End, a pointer jump) snaps. */
export const SHIFT_MAX_ROWS = 2;

/**
 * How the row column moves when the focused row goes from `from` to `to` (motion research §4 #5). `snap`: the first
 * layout, no move, a move of more than `SHIFT_MAX_ROWS` rows, or a `from` row that no longer exists. Otherwise the
 * column glides, and `extra` is the one row of the old layout that leaves the new one (nearest the new focus) and stays
 * mounted while it slides out, so it does not vanish mid-glide. Only one, to keep texture memory flat.
 */
export function rowShift(heights: readonly number[], from: number | undefined, to: number, f: RowFrame, mode: 'peek' | 'whole'): { snap: boolean; extra: number | undefined } {
  if (from === undefined || from === to || from >= heights.length || Math.abs(to - from) > SHIFT_MAX_ROWS) return { snap: true, extra: undefined };
  const now = new Set(rowSlots(heights, to, f, mode).map((s) => s.index));
  let extra: number | undefined;
  for (const s of rowSlots(heights, from, f, mode)) {
    if (now.has(s.index)) continue;
    if (extra === undefined || Math.abs(s.index - to) < Math.abs(extra - to)) extra = s.index;
  }
  return { snap: false, extra };
}
