/** Pure index math for the virtualised channel list (no Solid, no Lightning), unit-tested. */

/** Rows rendered beyond each edge of the viewport. */
export const BUFFER_ROWS = 5;

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
