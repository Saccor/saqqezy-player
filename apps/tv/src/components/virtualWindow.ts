/** Pure index math for the virtualised channel list (no Solid, no Lightning), unit-tested. */

/** Rows rendered beyond each edge of the viewport. */
const BUFFER_ROWS = 5;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** New first visible row so that `focus` is inside the viewport, moving as little as possible. */
export function scrollTopFor(focus: number, top: number, viewRows: number, total: number): number {
  const maxTop = Math.max(0, total - viewRows);
  let next = top;
  if (focus < next) next = focus;
  else if (focus > next + viewRows - 1) next = focus - viewRows + 1;
  return clamp(next, 0, maxTop);
}

/** Row indices to render: the visible rows plus `buffer` above and below (`to` is exclusive). */
export function renderRange(top: number, viewRows: number, total: number, buffer = BUFFER_ROWS): { from: number; to: number } {
  const from = clamp(top - buffer, 0, total);
  const to = clamp(top + viewRows + buffer, from, total);
  return { from, to };
}

/** Focus after moving by `delta` rows, clamped to the list. */
export function moveFocus(focus: number, delta: number, total: number): number {
  if (total <= 0) return 0;
  return clamp(focus + delta, 0, total - 1);
}

/** Focus after paging one screen up (-1) or down (+1). */
export function pageFocus(focus: number, dir: 1 | -1, viewRows: number, total: number): number {
  return moveFocus(focus, dir * viewRows, total);
}

/** The next selectable row from `focus` in direction `d` (skipping e.g. section headings), or `focus` if none. */
export function stepSelectable(focus: number, d: 1 | -1, total: number, selectable: (i: number) => boolean): number {
  for (let i = focus + d; i >= 0 && i < total; i += d) if (selectable(i)) return i;
  return focus;
}

/** `index` clamped to the list and moved off a non-selectable row: the next selectable row below, else above. */
export function firstSelectable(index: number, total: number, selectable: (i: number) => boolean): number {
  if (total <= 0) return 0;
  const i = Math.max(0, Math.min(index, total - 1));
  if (selectable(i)) return i;
  const down = stepSelectable(i, 1, total, selectable);
  return down !== i ? down : stepSelectable(i, -1, total, selectable);
}
