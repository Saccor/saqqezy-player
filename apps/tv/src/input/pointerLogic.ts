/**
 * Pure model of the mouse and pointer-remote layer (unit-tested; `pointer.ts` wires it to the DOM): pointer mode,
 * client-to-design coordinates, row and guide-cell hit maths, the click and double-click classifier, the wheel
 * throttle, button-row layout and hit-test ordering. The jitter filter and the click classifier measure CSS px;
 * everything else is design px (the 1920x1080 design).
 */

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

/** Pointer-only button rows (`PointerBar`): height and default button width. */
export const POINTER_BAR_H = 56;
export const POINTER_BTN_W = 200;
/** The options button at the right end of a hovered channel row. */
export const ROW_OPTIONS_LABEL = '⋯';

// ---- pointer mode ----

/** A move within this distance of the last accepted position is jitter. */
export const JITTER_PX = 3;
/** Screens that opt in (the Player) leave pointer mode after this long without movement. */
export const AUTO_HIDE_MS = 3000;

export interface PointerModeState {
  on: boolean;
  lastMoveAt: number;
  /** The last accepted position (client px); NaN before the first move. */
  lastX: number;
  lastY: number;
}

export const POINTER_START: PointerModeState = { on: false, lastMoveAt: 0, lastX: Number.NaN, lastY: Number.NaN };

export type PointerModeEvent =
  | { type: 'move'; x: number; y: number; at: number }
  /** A mouse button press: always wakes pointer mode (no jitter check), so a click or right click without movement counts. */
  | { type: 'press'; x: number; y: number; at: number }
  | { type: 'key' }
  | { type: 'cursorHidden' }
  | { type: 'cursorShown'; at: number }
  | { type: 'tick'; now: number; autoHide: boolean };

/**
 * Pointer mode: a move (past the jitter) or any button press turns it on, any logical remote key and a hidden webOS
 * cursor turn it off, and a tick turns it off after `AUTO_HIDE_MS` without movement or press where the screen opted
 * in. A press never turns it off. Returns the same object when nothing changed.
 */
export function pointerModeReducer(s: PointerModeState, e: PointerModeEvent): PointerModeState {
  switch (e.type) {
    case 'move':
      // NaN (no move yet) never counts as jitter.
      if (Math.hypot(e.x - s.lastX, e.y - s.lastY) <= JITTER_PX) return s;
      return { on: true, lastMoveAt: e.at, lastX: e.x, lastY: e.y };
    case 'press':
      return { on: true, lastMoveAt: e.at, lastX: e.x, lastY: e.y };
    case 'key':
    case 'cursorHidden':
      return s.on ? { ...s, on: false } : s;
    case 'cursorShown':
      return { ...s, on: true, lastMoveAt: e.at };
    case 'tick':
      return s.on && e.autoHide && e.now - s.lastMoveAt >= AUTO_HIDE_MS ? { ...s, on: false } : s;
  }
}

/**
 * A press reads what it acts on BEFORE it wakes pointer mode. Waking mounts pointer-only buttons synchronously; read
 * after, the press would land on a button the user could not see yet (one click on the Player's video would zap).
 */
export function hitBeforeWake<T>(hit: () => T, wake: () => void): T {
  const target = hit();
  wake();
  return target;
}

// ---- coordinates ----

/** Client px (a DOM pointer event) to design px: relative to the canvas, divided by the canvas scale. */
export function toDesign(clientX: number, clientY: number, origin: { left: number; top: number }, scale: number): Point {
  const k = scale > 0 ? scale : 1;
  return { x: (clientX - origin.left) / k, y: (clientY - origin.top) / k };
}

export function inRect(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
}

export function localPoint(r: Rect, p: Point): Point {
  return { x: p.x - r.x, y: p.y - r.y };
}

// ---- lists and the guide ----

/** The row index under `y` (relative to the list's top edge) for a list scrolled to `top`, or undefined. */
export function rowAt(y: number, top: number, rowH: number, total: number): number | undefined {
  if (!(y >= 0) || rowH <= 0) return undefined;
  const i = top + Math.floor(y / rowH);
  return i >= 0 && i < total ? i : undefined;
}

/**
 * Like `rowAt` for rows drawn `pitch - gap` high with a `gap` under each: a point in the gap hits no row, so a click
 * between two buttons runs neither.
 */
export function rowHit(y: number, top: number, pitch: number, gap: number, total: number): number | undefined {
  const i = rowAt(y, top, pitch, total);
  if (i === undefined) return undefined;
  return y - (i - top) * pitch < pitch - gap ? i : undefined;
}

/** The guide grid's layout (design px, relative to the grid node). */
export interface GridGeometry {
  rulerH: number;
  rowH: number;
  viewRows: number;
  channelW: number;
  timelineX: number;
  timelineW: number;
  pxPerHour: number;
}

export type GridHit<B> = { area: 'channels'; row: number } | { area: 'grid'; row: number; block: B };

const HOUR_MS = 3_600_000;

/**
 * The guide cell under a point: a channel name (the channel column) or the programme block whose time span holds
 * the point's time (start inclusive). The ruler, the gap between the columns and empty time are not cells.
 */
export function cellAt<B extends { start: number; stop: number }>(
  x: number, y: number, g: GridGeometry, top: number, total: number, viewStart: number,
  blocksOf: (row: number) => readonly B[],
): GridHit<B> | undefined {
  const yIn = y - g.rulerH;
  if (yIn < 0 || yIn >= g.viewRows * g.rowH) return undefined;
  const row = rowAt(yIn, top, g.rowH, total);
  if (row === undefined) return undefined;
  if (x >= 0 && x < g.channelW) return { area: 'channels', row };
  if (x < g.timelineX || x >= g.timelineX + g.timelineW) return undefined;
  const t = viewStart + ((x - g.timelineX) * HOUR_MS) / g.pxPerHour;
  const block = blocksOf(row).find((b) => b.start <= t && t < b.stop);
  return block ? { area: 'grid', row, block } : undefined;
}

// ---- clicks ----

export const CLICK_SLOP_PX = 8;
export const CLICK_MAX_MS = 500;
export const DOUBLE_CLICK_MS = 350;

/** A left-button press or release (client px, ms). */
export interface Press { x: number; y: number; at: number }
/**
 * The last click: when, and on which target (its sequence number). `sub` tells apart the parts of one target: lists
 * register one target for their whole area, so they pass the row index (the guide passes the cell index) as `sub`.
 */
export interface LastClick { at: number; target: number; sub?: number }

/** A release within `CLICK_SLOP_PX` and `CLICK_MAX_MS` of its press. */
export function isClick(down: Press, up: Press): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) <= CLICK_SLOP_PX && up.at - down.at <= CLICK_MAX_MS;
}

/**
 * A second click on the same target within `DOUBLE_CLICK_MS` of the first. When either click has a `sub` (the row
 * index for lists), both must have the same one.
 */
export function isDoubleClick(last: LastClick | undefined, at: number, target: number, sub?: number): boolean {
  return last !== undefined && last.target === target && last.sub === sub && at - last.at <= DOUBLE_CLICK_MS;
}

/**
 * Classifies a click and gives the next "last click": a double click resets it (a third click starts over), any other
 * click becomes it.
 */
export function nextClick(
  last: LastClick | undefined, at: number, target: number, sub?: number,
): { double: boolean; last: LastClick | undefined } {
  const double = isDoubleClick(last, at, target, sub);
  return { double, last: double ? undefined : { at, target, sub } };
}

// ---- wheel ----

export const WHEEL_STEP_MS = 120;
/** Accumulated px per step (a mouse notch is about 100 px). */
export const WHEEL_STEP_PX = 50;
export const WHEEL_LINE_PX = 40;
export const WHEEL_PAGE_PX = 800;

export type WheelDir = -1 | 0 | 1;
export interface WheelState { accY: number; accX: number; lastY: number; lastX: number }
export const WHEEL_START: WheelState = {
  accY: 0, accX: 0, lastY: Number.NEGATIVE_INFINITY, lastX: Number.NEGATIVE_INFINITY,
};

/** `WheelEvent.deltaMode`: 0 px, 1 lines, 2 pages. */
export function wheelPixels(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * WHEEL_LINE_PX;
  if (deltaMode === 2) return delta * WHEEL_PAGE_PX;
  return delta;
}

function axis(acc: number, last: number, d: number, at: number): { acc: number; last: number; step: WheelDir } {
  if (d === 0 || !Number.isFinite(d)) return { acc, last, step: 0 };
  // A change of direction drops what was accumulated the other way.
  const sum = Math.sign(d) !== Math.sign(acc) ? d : acc + d;
  const capped = Math.max(-WHEEL_STEP_PX, Math.min(WHEEL_STEP_PX, sum));
  if (Math.abs(capped) >= WHEEL_STEP_PX && at - last >= WHEEL_STEP_MS) return { acc: 0, last: at, step: capped > 0 ? 1 : -1 };
  return { acc: capped, last, step: 0 };
}

/** Accumulates wheel px per axis and yields at most one step per axis every `WHEEL_STEP_MS`. */
export function wheelStep(s: WheelState, dy: number, dx: number, at: number): { state: WheelState; dy: WheelDir; dx: WheelDir } {
  const y = axis(s.accY, s.lastY, dy, at);
  const x = axis(s.accX, s.lastX, dx, at);
  return { state: { accY: y.acc, accX: x.acc, lastY: y.last, lastX: x.last }, dy: y.step, dx: x.step };
}

// ---- layout ----

/** Offsets of buttons laid out one after another with `gap` between them, and the row's total size. */
export function barLayout(sizes: readonly number[], gap: number): { offsets: number[]; total: number } {
  const offsets: number[] = [];
  let at = 0;
  for (const s of sizes) {
    offsets.push(at);
    at += s + gap;
  }
  return { offsets, total: sizes.length === 0 ? 0 : at - gap };
}

// ---- hit testing ----

export interface HitCandidate {
  /** Absolute rect, design px. */
  rect: Rect;
  /** Menus, keyboards, dialogs and the Player overlay: they beat every screen target. */
  overlay: boolean;
  /** Registration order: the latest wins within a layer. */
  seq: number;
  enabled: boolean;
  /** Rendered, and no ancestor is fully transparent. */
  visible: boolean;
  /** Registered on the screen now on top, or shell-owned. */
  inScope: boolean;
}

/**
 * The target under `p`: overlays first, then the latest registration. Disabled, invisible and other screens' targets
 * are skipped. An overlay that is enabled, visible and in scope is modal: while one exists, no screen target (global
 * ones included) is hit anywhere, so a click outside the overlay's targets lands on its backdrop or on nothing.
 */
export function pickTarget(cands: readonly HitCandidate[], p: Point): number | undefined {
  const live = (c: HitCandidate) => c.enabled && c.visible && c.inScope;
  const modal = cands.some((c) => c.overlay && live(c));
  let best: number | undefined;
  cands.forEach((c, i) => {
    if (!live(c) || (modal && !c.overlay) || !inRect(c.rect, p)) return;
    const b = best === undefined ? undefined : cands[best];
    if (!b || (c.overlay && !b.overlay) || (c.overlay === b.overlay && c.seq > b.seq)) best = i;
  });
  return best;
}
