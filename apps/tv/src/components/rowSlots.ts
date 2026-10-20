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
