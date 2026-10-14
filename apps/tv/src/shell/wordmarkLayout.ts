/**
 * Pure geometry for the arched brand wordmark: glyph centres and rotations along a quadratic Bézier, and a
 * straight letter-spaced run. No DOM; the canvas drawing lives in `Wordmark.tsx`.
 */

export interface Pt { x: number; y: number }
/** Quadratic Bézier `M p0 Q p1 p2`. */
export interface Quad { p0: Pt; p1: Pt; p2: Pt }
/** A glyph centre on its baseline, and the baseline's rotation in radians (canvas convention, y down). */
export interface GlyphPlacement { x: number; y: number; angle: number }

/** Samples used to build the arc-length table: plenty for a ~250 px wordmark arc. */
const SAMPLES = 256;

export function quadPoint(q: Quad, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * q.p0.x + 2 * u * t * q.p1.x + t * t * q.p2.x,
    y: u * u * q.p0.y + 2 * u * t * q.p1.y + t * t * q.p2.y,
  };
}

/** Direction of travel at `t`, as an angle for `ctx.rotate`. */
export function quadTangentAngle(q: Quad, t: number): number {
  const dx = 2 * (1 - t) * (q.p1.x - q.p0.x) + 2 * t * (q.p2.x - q.p1.x);
  const dy = 2 * (1 - t) * (q.p1.y - q.p0.y) + 2 * t * (q.p2.y - q.p1.y);
  return Math.atan2(dy, dx);
}

/** Cumulative chord lengths at `SAMPLES` + 1 evenly spaced `t` values. */
function lengthTable(q: Quad): number[] {
  const table = [0];
  let prev = q.p0;
  let total = 0;
  for (let i = 1; i <= SAMPLES; i++) {
    const p = quadPoint(q, i / SAMPLES);
    total += Math.hypot(p.x - prev.x, p.y - prev.y);
    table.push(total);
    prev = p;
  }
  return table;
}

export function curveLength(q: Quad): number {
  const table = lengthTable(q);
  return table[table.length - 1]!;
}

/** The `t` at arc length `s` (clamped to the curve), by linear interpolation in the table. */
function tAt(table: number[], s: number): number {
  const total = table[table.length - 1]!;
  if (s <= 0) return 0;
  if (s >= total) return 1;
  let lo = 0;
  let hi = table.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid]! < s) lo = mid;
    else hi = mid;
  }
  const a = table[lo]!;
  const b = table[hi]!;
  return (lo + (b > a ? (s - a) / (b - a) : 0)) / SAMPLES;
}

/**
 * Places a run of glyphs (advance widths in order) along the curve, centred on its middle by arc length.
 * `spacing` is added between neighbouring glyphs (not after the last one). In a run longer than the curve, the
 * overflowing glyphs pile up on the end points, so callers fit the font size to `curveLength` first.
 */
export function layoutOnCurve(q: Quad, widths: readonly number[], spacing: number): GlyphPlacement[] {
  if (widths.length === 0) return [];
  const table = lengthTable(q);
  const total = table[table.length - 1]!;
  const run = widths.reduce((sum, w) => sum + w, 0) + spacing * (widths.length - 1);
  let s = (total - run) / 2;
  return widths.map((w) => {
    const t = tAt(table, s + w / 2);
    s += w + spacing;
    const p = quadPoint(q, t);
    return { x: p.x, y: p.y, angle: quadTangentAngle(q, t) };
  });
}

/** Glyph centre x positions for a straight run centred on `cx`, with `spacing` between glyphs. */
export function layoutLine(widths: readonly number[], spacing: number, cx: number): number[] {
  const run = widths.reduce((sum, w) => sum + w, 0) + spacing * Math.max(0, widths.length - 1);
  let x = cx - run / 2;
  return widths.map((w) => {
    const centre = x + w / 2;
    x += w + spacing;
    return centre;
  });
}
