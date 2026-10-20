/**
 * Pure time/grid math for the EPG guide (no Solid, no Lightning), unit-tested.
 *
 * Focus model: a row index plus an `anchor` time. The focused programme is the block of the focused row that
 * contains the anchor, so Up/Down keep the time position and data arriving later never loses the focus.
 * Left/Right (`stepLeft` / `stepRight`) move the anchor to the neighbouring block and scroll the view when needed.
 */

import type { ScreenId } from '../shell/router.ts';

export const MINUTE = 60_000;
export const HALF_HOUR = 30 * MINUTE;
export const HOUR = 60 * MINUTE;
/** Timeline scale: one hour is 682 px. */
export const PX_PER_HOUR = 682;
/** Visible 2 h time span of the timeline. */
export const VIEW_SPAN = 2 * HOUR;
/** The guide covers now - 6 h .. now + 48 h. */
export const WINDOW_BACK = 6 * HOUR;
export const WINDOW_AHEAD = 48 * HOUR;
/** Rows are fetched for the visible 2 h plus this much either side. */
export const PREFETCH = 2 * HOUR;
export const NO_INFO = 'No information';

/**
 * Where a channel chosen in the guide plays. Opened from the Player (`▦ Guide`), the guide goes back to it with the new
 * channel id instead of pushing a second Player (each Player → Guide → Player cycle grew the stack by two). From
 * anywhere else it pushes one.
 */
export function guidePlayAction(below: ScreenId | undefined): 'back' | 'push' {
  return below === 'player' ? 'back' : 'push';
}

export interface TimeRange { start: number; end: number }
export interface ProgrammeLike { title: string; start: number; stop: number; desc?: string; archive?: boolean }
/** `archive`: the source's own archive answer for the programme, when its row was refined. */
export interface Block { start: number; stop: number; title: string; desc?: string; filler: boolean; archive?: boolean }
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

/** Guide history at most (spec 2026-10-20-catch-up §5.1, decision 1). */
export const CATCHUP_BACK_MAX = 7 * 24 * HOUR;

/** The guide's time window, fixed when it opens. Both ends are half-hour aligned. `backMs`: see `guideBackMs`. */
export function guideWindow(now: number, backMs = WINDOW_BACK): TimeRange {
  const base = floorHalfHour(now);
  return { start: base - backMs, end: base + WINDOW_AHEAD };
}

/** How far back the guide reaches: 6 h, or the source's largest archive (`catchupDays`), capped at 7 days. */
export function guideBackMs(catchupDays: number): number {
  return catchupDays > 0 ? Math.max(WINDOW_BACK, Math.min(catchupDays * 24 * HOUR, CATCHUP_BACK_MAX)) : WINDOW_BACK;
}

/**
 * "Go to day" (§5.1): Today, Yesterday and older days back to the window start (labels as the ruler's). `at` is
 * now for Today, else 18:00 that day (local time), never before the window.
 */
export function dayJumpTargets(now: number, win: TimeRange): { label: string; at: number }[] {
  const out: { label: string; at: number }[] = [{ label: 'Today', at: now }];
  const d = new Date(now);
  for (let back = 1; back <= 8; back++) {
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
    const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back + 1).getTime();
    if (dayEnd <= win.start) break;
    const evening = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, 18).getTime();
    out.push({ label: dayLabel(dayStart, now), at: Math.max(evening, win.start) });
  }
  return out;
}

/** The view a day jump opens: Today as the guide opens, another day from its `at`. */
export function dayJumpView(at: number, now: number, win: TimeRange): { viewStart: number; anchor: number } {
  if (at >= now) return { viewStart: initialViewStart(now, win), anchor: now };
  return { viewStart: clampViewStart(floorHalfHour(at), win), anchor: at };
}

export function clampViewStart(viewStart: number, win: TimeRange, span = VIEW_SPAN): number {
  return clamp(viewStart, win.start, Math.max(win.start, win.end - span));
}

/** The view opens at the half hour before now. */
export function initialViewStart(now: number, win: TimeRange): number {
  return clampViewStart(floorHalfHour(now), win);
}

/**
 * Where the guide opens: route params (Search opens it at a channel and time), else now and the remembered group.
 * `rememberGroup` is false for a channel target (from Search): that open must not replace the remembered group.
 */
export function guideOpenTarget(
  params: Record<string, unknown>, now: number, win: TimeRange,
): { channelId?: string; groupId?: string; viewStart: number; anchor: number; rememberGroup: boolean } {
  const out: { channelId?: string; groupId?: string; viewStart: number; anchor: number; rememberGroup: boolean } =
    { viewStart: initialViewStart(now, win), anchor: now, rememberGroup: true };
  const channelId = typeof params.channelId === 'string' ? params.channelId : undefined;
  const groupId = typeof params.groupId === 'string' ? params.groupId : undefined;
  if (channelId !== undefined) {
    out.channelId = channelId;
    out.rememberGroup = false;
  }
  if (groupId !== undefined) out.groupId = groupId;
  else if (channelId !== undefined) out.groupId = 'all';
  const at = params.at;
  if (channelId !== undefined && typeof at === 'number' && Number.isFinite(at)) {
    out.anchor = Math.max(win.start, Math.min(win.end - 1, at));
    out.viewStart = clampViewStart(floorHalfHour(out.anchor), win);
  }
  return out;
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
    if (p.archive !== undefined) b.archive = p.archive;
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
 * view, back to its start (or to its last 2 h when it is longer); when it starts in the last half hour or later,
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
    // Nothing further loaded: scroll on while the window has room, so the data can fill in (never a dead end).
    return scrollBy(view, HOUR, win, cur) ?? { kind: 'none' };
  }
  const viewStart = revealStart(next, view.viewStart, win);
  return { kind: 'move', index: index + 1, viewStart, anchor: Math.max(next.start, viewStart) };
}

/**
 * Left: the previous programme, one hour back inside a long block, or `edge` at the start of the window. While the
 * data before the first loaded block is still loading, the view scrolls back instead (never a false edge).
 */
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
  if (cur.start <= win.start || view.viewStart <= win.start) return { kind: 'edge' };
  return scrollBy(view, -HOUR, win, cur) ?? { kind: 'edge' };
}

/** `‹ Earlier` / `Later ›` (pointer): the view moves by its whole span (2 h) and the anchor stays inside it. */
export function pageTime(view: HView, dir: 1 | -1, win: TimeRange): HStep {
  return scrollBy(view, dir * VIEW_SPAN, win) ?? { kind: 'none' };
}

export type GuideClick = 'focus' | 'ok';

/**
 * A pointer click in the grid. A channel name acts like Ok in the channel column (watch). A programme cell that is
 * not the focused one takes focus; a click on the focused cell acts like Ok (watch if on air, else toggle details).
 */
export function guideClick(
  hit: { area: 'channels' } | { area: 'grid'; row: number; start: number },
  focus: { row: number; area: 'grid' | 'channels'; focusStart: number | undefined },
): GuideClick {
  if (hit.area === 'channels') return 'ok';
  return focus.area === 'grid' && hit.row === focus.row && hit.start === focus.focusStart ? 'ok' : 'focus';
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

/** Two initials for a channel without a logo: the first letters of the first two words, else the first two letters. */
export function monogram(name: string): string {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return '';
  const w0 = [...words[0]!];
  const out = words.length > 1 ? w0[0]! + [...words[1]!][0]! : w0.slice(0, 2).join('');
  return out.toUpperCase();
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

/** Pointer-only buttons by the grid. */
export const GUIDE_POINTER_LABELS = { groups: 'Groups', earlier: '‹ Earlier', later: 'Later ›' } as const;
