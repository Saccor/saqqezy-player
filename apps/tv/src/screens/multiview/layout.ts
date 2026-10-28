/**
 * Multiview geometry in the 1920x1080 design space (spec 2026-10-20-multiview §3, owner decisions §12.4 and 14; up to
 * 6 windows: plan 2026-10-22-multiview-p2). Pure: the canvas chrome and the DOM video boxes both read this one
 * function, so they stay pixel-locked. Every tile is 16:9 (except the Large one of (f), 1200x682) with 16 px gutters;
 * there is never more than one Large-class tile except in the equal layouts (a) and (d2).
 */
export type LayoutKind = 'single' | 'a' | 'b' | 'c' | 'd1' | 'd2' | 'e' | 'f';
export type SizeClass = 'large' | 'small';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TileGeometry {
  /** The tile's index in insertion order. */
  tile: number;
  rect: Rect;
  /** The focus ring: the rect grown by 8 on each side, outside the picture. */
  ring: Rect;
  /** The audio disc's top-left corner and size. */
  disc: { x: number; y: number; size: number };
  /** The label scrim at the tile's bottom. */
  scrim: Rect;
  sizeClass: SizeClass;
}

export interface LayoutInput {
  /** Open tiles, 1..4. */
  tiles: number;
  /** The tile marked Large (insertion index). */
  large?: number;
  /** "Equal size": 4 tiles in 2x2 even with one marked Large (Make large clears it). */
  equal?: boolean;
  /** min(device ceiling, Max windows): with 6, five windows show an empty "Add channel" slot in the sixth place. */
  windowLimit: number;
}

export interface Layout {
  kind: LayoutKind;
  /** In slot order: the Large tile first where there is one. */
  tiles: TileGeometry[];
  /** The empty "Add channel" slot (five windows with room for a sixth). */
  empty?: { rect: Rect; ring: Rect };
}

const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

/** Slot rects per layout (spec §3.3 to §3.7). */
const FULL = rect(0, 0, 1920, 1080);
const A = [rect(56, 288, 896, 504), rect(968, 288, 896, 504)];
const LARGE_C = rect(360, 28, 1200, 675);
const SMALL_C = [rect(360, 719, 592, 333), rect(968, 719, 592, 333)];
/** (b): the one small window centred under the Large one (no empty slot beside it; owner 2026-10-28). */
const SMALL_CENTRED = rect(664, 719, 592, 333);
const D1 = [rect(296, 37, 1328, 747), rect(296, 800, 432, 243), rect(744, 800, 432, 243), rect(1192, 800, 432, 243)];
const D2 = [rect(56, 28, 896, 504), rect(968, 28, 896, 504), rect(56, 548, 896, 504), rect(968, 548, 896, 504)];
/** (e) 5-6 windows: a 3x2 grid of 592x333. */
const E = [
  rect(56, 199, 592, 333), rect(664, 199, 592, 333), rect(1272, 199, 592, 333),
  rect(56, 548, 592, 333), rect(664, 548, 592, 333), rect(1272, 548, 592, 333),
];
/** (f) 1 Large + 5: a 3x3 grid of 592x333 cells; the Large window covers the top-left 2x2 block (7 px off 16:9). */
const F = [
  rect(56, 24, 1200, 682), rect(1272, 24, 592, 333), rect(1272, 373, 592, 333),
  rect(56, 722, 592, 333), rect(664, 722, 592, 333), rect(1272, 722, 592, 333),
];

/** A tile 800 px wide or more is Large class. */
const LARGE_MIN_W = 800;
const RING = 8;

const ringOf = (r: Rect): Rect => rect(r.x - RING, r.y - RING, r.w + 2 * RING, r.h + 2 * RING);

function geometry(tile: number, r: Rect): TileGeometry {
  const sizeClass: SizeClass = r.w >= LARGE_MIN_W ? 'large' : 'small';
  const [disc, inset, scrimH] = sizeClass === 'large' ? [48, 24, 128] : [40, 16, 72];
  return {
    tile,
    rect: r,
    ring: ringOf(r),
    disc: { x: r.x + r.w - inset - disc, y: r.y + inset, size: disc },
    scrim: rect(r.x, r.y + r.h - scrimH, r.w, scrimH),
    sizeClass,
  };
}

/** Insertion order with `large` moved to the front. */
function largeFirst(tiles: number, large: number): number[] {
  const order = Array.from({ length: tiles }, (_, i) => i);
  return [large, ...order.filter((i) => i !== large)];
}

export function layout(i: LayoutInput): Layout {
  const n = Math.max(1, Math.min(6, Math.floor(i.tiles)));
  const large = i.large !== undefined && i.large >= 0 && i.large < n ? i.large : undefined;
  const place = (kind: LayoutKind, order: number[], rects: Rect[]): Layout => ({
    kind, tiles: order.map((t, k) => geometry(t, rects[k]!)),
  });
  const inOrder = Array.from({ length: n }, (_, k) => k);
  if (n === 1) return place('single', inOrder, [FULL]);
  if (n === 2) {
    if (large === undefined) return place('a', inOrder, A);
    return place('b', largeFirst(2, large), [LARGE_C, SMALL_CENTRED]);
  }
  if (n === 3) return place('c', largeFirst(3, large ?? 0), [LARGE_C, ...SMALL_C]);
  if (n === 4) {
    if (large === undefined || i.equal) return place('d2', inOrder, D2);
    return place('d1', largeFirst(4, large), D1);
  }
  // 5-6: the 3x2 grid, or 1 Large + 5; with 5 windows and room for a 6th, the last slot is the empty one.
  const [kind, order, rects] = large === undefined || i.equal ? ['e' as const, inOrder, E] : ['f' as const, largeFirst(n, large), F];
  const l = place(kind, order, rects);
  if (n === 5 && i.windowLimit >= 6) l.empty = { rect: rects[5]!, ring: ringOf(rects[5]!) };
  return l;
}
