/**
 * Pure time/grid math for the EPG guide (no Solid, no Lightning), unit-tested.
 *
 * Focus model: a row index plus an `anchor` time. The focused programme is the block of the focused row that
 * contains the anchor, so Up/Down keep the time position and data arriving later never loses the focus.
 * Left/Right (`stepLeft` / `stepRight`) move the anchor to the neighbouring block and scroll the view when needed.
 */

export const MINUTE = 60_000;
export const HALF_HOUR = 30 * MINUTE;
export const HOUR = 60 * MINUTE;
/** Timeline scale: one hour is 480 px. */
export const PX_PER_HOUR = 480;
/** Visible time span of the timeline. */
export const VIEW_SPAN = 3 * HOUR;
/** The guide covers now - 6 h .. now + 48 h. */
export const WINDOW_BACK = 6 * HOUR;
export const WINDOW_AHEAD = 48 * HOUR;
/** Rows are fetched for the visible 3 h plus this much either side. */
export const PREFETCH = 3 * HOUR;
export const NO_INFO = 'No information';

export interface TimeRange { start: number; end: number }
export interface ProgrammeLike { title: string; start: number; stop: number; desc?: string }
export interface Block { start: number; stop: number; title: string; desc?: string; filler: boolean }
export interface HView { viewStart: number; anchor: number }
export type HStep =
  | { kind: 'move'; index: number; viewStart: number; anchor: number }
  | { kind: 'scroll'; viewStart: number; anchor: number }
  /** Nothing further left: the caller moves focus to the channel column. */
  | { kind: 'edge' }
  /** Nothing further right (end of the window). */
  | { kind: 'none' };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const timeToX = (t: number, viewStart: number): number => ((t - viewStart) * PX_PER_HOUR) / HOUR;
export const xToTime = (x: number, viewStart: number): number => viewStart + (x * HOUR) / PX_PER_HOUR;
export const floorHalfHour = (t: number): number => Math.floor(t / HALF_HOUR) * HALF_HOUR;

/** The guide's time window, fixed when it opens. Both ends are half-hour aligned. */
export function guideWindow(now: number): TimeRange {
  const base = floorHalfHour(now);
  return { start: base - WINDOW_BACK, end: base + WINDOW_AHEAD };
}

export function clampViewStart(viewStart: number, win: TimeRange, span = VIEW_SPAN): number {
  return clamp(viewStart, win.start, Math.max(win.start, win.end - span));
}

/** The view opens at the half hour before now. */
export function initialViewStart(now: number, win: TimeRange): number {
  return clampViewStart(floorHalfHour(now), win);
}

/** Half-hour tick marks inside [viewStart, viewStart + span). */
export function ticks(viewStart: number, span = VIEW_SPAN): number[] {
  const out: number[] = [];
  for (let t = Math.ceil(viewStart / HALF_HOUR) * HALF_HOUR; t < viewStart + span; t += HALF_HOUR) out.push(t);
  return out;
}

function mergeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/**
 * The blocks of one row: its programmes (sorted, duplicates and empty ones dropped, overlaps clipped) plus
 * "No information" fillers for every gap inside the loaded ranges. A channel without EPG becomes one filler
 * per contiguous loaded range. Nothing is invented outside the loaded ranges (those are still loading).
 */
export function buildBlocks(programmes: readonly ProgrammeLike[], covered: readonly TimeRange[]): Block[] {
  const ranges = mergeRanges(covered);
  const seen = new Set<number>();
  const progs: Block[] = [];
  let prevStop = -Infinity;
  for (const p of [...programmes].sort((a, b) => a.start - b.start)) {
    if (seen.has(p.start)) continue;
    seen.add(p.start);
    const start = Math.max(p.start, prevStop);
    if (p.stop <= start) continue;
    const b: Block = { start, stop: p.stop, title: p.title, filler: false };
    if (p.desc !== undefined) b.desc = p.desc;
    progs.push(b);
    prevStop = p.stop;
  }

  const out: Block[] = [];
  const used = new Set<Block>();
  for (const r of ranges) {
    let cursor = r.start;
    for (const p of progs) {
      if (p.stop <= r.start || p.start >= r.end) continue;
      if (p.start > cursor) out.push({ start: cursor, stop: p.start, title: NO_INFO, filler: true });
      if (!used.has(p)) {
        used.add(p);
        out.push(p);
      }
      cursor = Math.max(cursor, p.stop);
    }
    if (cursor < r.end) out.push({ start: cursor, stop: r.end, title: NO_INFO, filler: true });
  }
  return out;
}

/** The block containing `t` (start inclusive), else the nearest one, else -1 for an empty row. */
export function blockIndexAt(blocks: readonly Block[], t: number): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.start <= t && t < b.stop) return i;
    const d = t < b.start ? b.start - t : t - b.stop;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

export const isOnAir = (b: { start: number; stop: number }, now: number): boolean => b.start <= now && now < b.stop;

/**
 * The view start that shows `block`: unchanged while it starts well inside the view; when it starts before the
 * view, back to its start (or to its last 3 h when it is longer); when it starts in the last half hour or later,
 * forward so that it sits one hour into the view.
 */
export function revealStart(block: Block, viewStart: number, win: TimeRange, span = VIEW_SPAN): number {
  if (block.start < viewStart) {
    return clampViewStart(Math.min(viewStart, Math.max(floorHalfHour(block.start), floorHalfHour(block.stop - span))), win, span);
  }
  if (block.start >= viewStart + span - HALF_HOUR) {
    return clampViewStart(Math.max(viewStart, floorHalfHour(block.start) - HOUR), win, span);
  }
  return viewStart;
}

type Scroll = Extract<HStep, { kind: 'scroll' }>;

function scrollBy(view: HView, delta: number, win: TimeRange, anchorIn?: Block): Scroll | undefined {
  const viewStart = clampViewStart(view.viewStart + delta, win);
  if (viewStart === view.viewStart) return undefined;
  const lo = anchorIn ? Math.max(anchorIn.start, viewStart) : viewStart;
  return { kind: 'scroll', viewStart, anchor: clamp(view.anchor, lo, viewStart + VIEW_SPAN - 1) };
}

/** Right: the next programme, or one hour of time when the focused block runs on for more than an hour. */
export function stepRight(blocks: readonly Block[], index: number, view: HView, win: TimeRange): HStep {
  const cur = blocks[index];
  const end = view.viewStart + VIEW_SPAN;
  if (!cur) return scrollBy(view, HOUR, win) ?? { kind: 'none' };
  if (cur.stop - end > HOUR) return scrollBy(view, HOUR, win, cur) ?? { kind: 'none' };
  const next = blocks[index + 1];
  if (!next || next.start >= win.end) {
    return (cur.stop > end ? scrollBy(view, HOUR, win, cur) : undefined) ?? { kind: 'none' };
  }
  const viewStart = revealStart(next, view.viewStart, win);
  return { kind: 'move', index: index + 1, viewStart, anchor: Math.max(next.start, viewStart) };
}

/** Left: the previous programme, one hour back inside a long block, or `edge` at the start of the row. */
export function stepLeft(blocks: readonly Block[], index: number, view: HView, win: TimeRange): HStep {
  const cur = blocks[index];
  if (!cur) return scrollBy(view, -HOUR, win) ?? { kind: 'edge' };
  if (view.viewStart - cur.start > HOUR) {
    const s = scrollBy(view, -HOUR, win, cur);
    if (s) return { ...s, anchor: Math.max(cur.start, s.viewStart) };
  }
  const prev = blocks[index - 1];
  if (prev && prev.stop > win.start) {
    const viewStart = revealStart(prev, view.viewStart, win);
    return { kind: 'move', index: index - 1, viewStart, anchor: Math.max(prev.start, viewStart) };
  }
  if (cur.start < view.viewStart) {
    const viewStart = clampViewStart(floorHalfHour(cur.start), win);
    if (viewStart < view.viewStart) return { kind: 'scroll', viewStart, anchor: Math.max(cur.start, viewStart) };
  }
  return { kind: 'edge' };
}

/** Time range to have loaded for a view: the visible span plus `PREFETCH` either side, inside the window. */
export function prefetchRange(viewStart: number, win: TimeRange, span = VIEW_SPAN): TimeRange {
  return { start: Math.max(win.start, viewStart - PREFETCH), end: Math.min(win.end, viewStart + span + PREFETCH) };
}

/** Starts of the `chunkMs`-aligned chunks touching [range.start, range.end). */
export function chunkStarts(range: TimeRange, chunkMs: number): number[] {
  const out: number[] = [];
  if (range.end <= range.start) return out;
  for (let t = Math.floor(range.start / chunkMs) * chunkMs; t < range.end; t += chunkMs) out.push(t);
  return out;
}

/** Page indices of `perPage` rows touching rows [from, to). */
export function pageRange(from: number, to: number, perPage: number): number[] {
  const out: number[] = [];
  if (to <= from) return out;
  for (let p = Math.floor(Math.max(0, from) / perPage); p <= Math.floor((to - 1) / perPage); p++) out.push(p);
  return out;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Today`, `Tomorrow`, `Yesterday` or `Tue 13 Jan` for `t`, relative to `now` (local time). */
export function dayLabel(t: number, now: number): string {
  const d = new Date(t);
  const n = new Date(now);
  const days = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
      - new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()) / (24 * HOUR),
  );
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** `On now`, `Starts in 1 h 5 min` or `Ended`. */
export function relativeLabel(b: { start: number; stop: number }, now: number): string {
  if (isOnAir(b, now)) return 'On now';
  if (b.stop <= now) return 'Ended';
  const mins = Math.ceil((b.start - now) / MINUTE);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `Starts in ${m} min`;
  return m === 0 ? `Starts in ${h} h` : `Starts in ${h} h ${m} min`;
}
