export interface WindowInput {
  count: number;
  /** Fixed row height in px (row pitch, gaps included). */
  itemHeight: number;
  /** How far the list's top has scrolled past the top of the viewport (negative: the list starts lower down). */
  scrollTop: number;
  viewportHeight: number;
  /** Extra rows rendered above and below the visible ones. */
  overscan?: number;
}

export interface WindowRange {
  /** First rendered index. */
  start: number;
  /** One past the last rendered index. */
  end: number;
  totalHeight: number;
}

/** The rows of a fixed-height list to render for a scroll position. */
export function virtualWindow({ count, itemHeight, scrollTop, viewportHeight, overscan = 6 }: WindowInput): WindowRange {
  const totalHeight = count * itemHeight;
  if (count === 0 || itemHeight <= 0) return { start: 0, end: 0, totalHeight };
  const top = Math.max(0, scrollTop);
  const bottom = scrollTop + viewportHeight;
  const first = Math.floor(top / itemHeight);
  const last = Math.ceil(bottom / itemHeight);
  const start = Math.min(Math.max(first - overscan, 0), count);
  const end = Math.min(Math.max(last + overscan, 0), count);
  return { start, end: Math.max(start, end), totalHeight };
}

/** The row under `y` px from the list's top, clamped to the list. */
export function indexAt(y: number, itemHeight: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(Math.floor(y / itemHeight), 0), count - 1);
}
