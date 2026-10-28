import { formatClock } from '../shell/logic.ts';
import { clock } from './vodPlayerLogic.ts';

/** The fraction (0..1) of a timeline `width` wide at node-local `x`; 0 for an empty width. */
export function fractionAt(x: number, width: number): number {
  if (!(width > 0)) return 0;
  return Math.max(0, Math.min(1, x / width));
}

/** Where the buffered range ends: the playhead plus what is buffered ahead, never past the end. Undefined: unknown. */
export function bufferedEndMs(posMs: number, aheadMs: number | undefined, durMs: number): number | undefined {
  if (aheadMs === undefined || !Number.isFinite(aheadMs) || aheadMs <= 0) return undefined;
  return Math.min(durMs, posMs + aheadMs);
}

/** "12:34 / 1:45:00" (elapsed / total), or the elapsed time alone while the length is unknown. */
export function elapsedText(posMs: number, durMs: number | undefined): string {
  return durMs === undefined ? clock(posMs) : `${clock(posMs)} / ${clock(durMs)}`;
}

/** "−1:32:26 · ends 21:47": the time left and the local wall-clock time it ends at (24 h). */
export function remainingText(posMs: number, durMs: number, nowMs: number): string {
  const left = Math.max(0, durMs - posMs);
  const end = new Date(nowMs + left);
  return `−${clock(left)} · ends ${formatClock(end)}`;
}

/**
 * The x of every button in a row `width` wide holding three groups (button widths, `gap` apart): the left group from
 * 0, the centre group centred, the right group ending at `width`. In row order: left, centre, right.
 */
export function groupXs(width: number, gap: number, left: number[], centre: number[], right: number[]): number[] {
  const run = (ws: number[], from: number) => {
    let x = from;
    return ws.map((w) => { const at = x; x += w + gap; return at; });
  };
  const span = (ws: number[]) => (ws.length === 0 ? 0 : ws.reduce((s, w) => s + w + gap, -gap));
  return [...run(left, 0), ...run(centre, (width - span(centre)) / 2), ...run(right, width - span(right))];
}

/** The left x of a bubble `w` wide centred on `centreX`, kept within [min, max]. */
export function bubbleX(centreX: number, w: number, min: number, max: number): number {
  return Math.max(min, Math.min(max - w, centreX - w / 2));
}
