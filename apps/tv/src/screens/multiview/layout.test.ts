import { describe, expect, it } from 'vitest';
import { layout, type Layout, type LayoutInput, type Rect } from './layout.ts';

type Row = [rect: [number, number, number, number], ring: [number, number, number, number], disc: [number, number, number], scrim: [number, number, number, number]];

const r = ([x, y, w, h]: [number, number, number, number]): Rect => ({ x, y, w, h });

/** Asserts every tile of `l` against the spec's table rows, in slot order. */
function expectRows(l: Layout, rows: Row[]) {
  expect(l.tiles.map((t) => [t.rect, t.ring, t.disc, t.scrim])).toEqual(
    rows.map(([rect, ring, [x, y, size], scrim]) => [r(rect), r(ring), { x, y, size }, r(scrim)]),
  );
}

describe('layout(): the spec tables, to the pixel', () => {
  it('(a) 2 tiles, equal, side by side (§3.3)', () => {
    const l = layout({ tiles: 2, windowLimit: 4 });
    expect(l.kind).toBe('a');
    expectRows(l, [
      [[56, 288, 896, 504], [48, 280, 912, 520], [880, 312, 48], [56, 664, 896, 128]],
      [[968, 288, 896, 504], [960, 280, 912, 520], [1792, 312, 48], [968, 664, 896, 128]],
    ]);
    expect(l.tiles.map((t) => t.tile)).toEqual([0, 1]);
    expect(l.empty).toBeUndefined();
  });

  it('(b) 2 tiles, one Large, the small one below with an empty "Add channel" slot (§3.4)', () => {
    const l = layout({ tiles: 2, large: 1, windowLimit: 3 });
    expect(l.kind).toBe('b');
    expectRows(l, [
      [[360, 28, 1200, 675], [352, 20, 1216, 691], [1488, 52, 48], [360, 575, 1200, 128]],
      [[360, 719, 592, 333], [352, 711, 608, 349], [896, 735, 40], [360, 980, 592, 72]],
    ]);
    expect(l.tiles.map((t) => t.tile)).toEqual([1, 0]); // the Large tile takes slot 1
    expect(l.empty).toEqual({ rect: r([968, 719, 592, 333]), ring: r([960, 711, 608, 349]) });
  });

  it('(b) with a window limit of 2: the small tile is centred and there is no empty slot', () => {
    const l = layout({ tiles: 2, large: 0, windowLimit: 2 });
    expectRows(l, [
      [[360, 28, 1200, 675], [352, 20, 1216, 691], [1488, 52, 48], [360, 575, 1200, 128]],
      [[664, 719, 592, 333], [656, 711, 608, 349], [1200, 735, 40], [664, 980, 592, 72]],
    ]);
    expect(l.empty).toBeUndefined();
  });

  it('(c) 3 tiles: Large on top, 2 small below; tile 1 is Large when none is marked (§3.5)', () => {
    const rows: Row[] = [
      [[360, 28, 1200, 675], [352, 20, 1216, 691], [1488, 52, 48], [360, 575, 1200, 128]],
      [[360, 719, 592, 333], [352, 711, 608, 349], [896, 735, 40], [360, 980, 592, 72]],
      [[968, 719, 592, 333], [960, 711, 608, 349], [1504, 735, 40], [968, 980, 592, 72]],
    ];
    const none = layout({ tiles: 3, windowLimit: 4 });
    expect(none.kind).toBe('c');
    expectRows(none, rows);
    expect(none.tiles.map((t) => t.tile)).toEqual([0, 1, 2]);
    const marked = layout({ tiles: 3, large: 2, windowLimit: 4 });
    expectRows(marked, rows);
    expect(marked.tiles.map((t) => t.tile)).toEqual([2, 0, 1]);
  });

  it('(d1) 4 tiles with one marked Large: 1 Large + 3 small (§3.6)', () => {
    const l = layout({ tiles: 4, large: 3, windowLimit: 4 });
    expect(l.kind).toBe('d1');
    expectRows(l, [
      [[296, 37, 1328, 747], [288, 29, 1344, 763], [1552, 61, 48], [296, 656, 1328, 128]],
      [[296, 800, 432, 243], [288, 792, 448, 259], [672, 816, 40], [296, 971, 432, 72]],
      [[744, 800, 432, 243], [736, 792, 448, 259], [1120, 816, 40], [744, 971, 432, 72]],
      [[1192, 800, 432, 243], [1184, 792, 448, 259], [1568, 816, 40], [1192, 971, 432, 72]],
    ]);
    expect(l.tiles.map((t) => t.tile)).toEqual([3, 0, 1, 2]);
  });

  it('(d2) 4 tiles, 2x2: the default with none marked (owner §12.4), and "Equal size" (§3.7)', () => {
    const rows: Row[] = [
      [[56, 28, 896, 504], [48, 20, 912, 520], [880, 52, 48], [56, 404, 896, 128]],
      [[968, 28, 896, 504], [960, 20, 912, 520], [1792, 52, 48], [968, 404, 896, 128]],
      [[56, 548, 896, 504], [48, 540, 912, 520], [880, 572, 48], [56, 924, 896, 128]],
      [[968, 548, 896, 504], [960, 540, 912, 520], [1792, 572, 48], [968, 924, 896, 128]],
    ];
    const none = layout({ tiles: 4, windowLimit: 4 });
    expect(none.kind).toBe('d2');
    expectRows(none, rows);
    expect(none.tiles.map((t) => t.tile)).toEqual([0, 1, 2, 3]);
    const equal = layout({ tiles: 4, large: 2, equal: true, windowLimit: 4 });
    expect(equal.kind).toBe('d2');
    expectRows(equal, rows);
    expect(equal.tiles.map((t) => t.tile)).toEqual([0, 1, 2, 3]); // insertion order, nothing swapped
  });

  it('1 tile is the full-screen player', () => {
    const l = layout({ tiles: 1, windowLimit: 4 });
    expect(l.kind).toBe('single');
    expect(l.tiles.map((t) => t.rect)).toEqual([r([0, 0, 1920, 1080])]);
  });

  it('size classes: 800 px wide or more is Large', () => {
    expect(layout({ tiles: 2, windowLimit: 4 }).tiles.map((t) => t.sizeClass)).toEqual(['large', 'large']);
    expect(layout({ tiles: 3, windowLimit: 4 }).tiles.map((t) => t.sizeClass)).toEqual(['large', 'small', 'small']);
  });
});

/** Every layout the rules can produce. */
function allInputs(): LayoutInput[] {
  const out: LayoutInput[] = [];
  for (const tiles of [2, 3, 4]) {
    for (const windowLimit of [2, 3, 4].filter((w) => w >= tiles)) {
      for (const large of [undefined, ...Array.from({ length: tiles }, (_, i) => i)]) {
        for (const equal of [false, true]) out.push(large === undefined ? { tiles, equal, windowLimit } : { tiles, large, equal, windowLimit });
      }
    }
  }
  return out;
}

describe('layout(): invariants', () => {
  it('every tile is exactly 16:9 and inside the screen', () => {
    for (const i of allInputs()) {
      for (const t of layout(i).tiles) {
        expect(t.rect.w * 9, JSON.stringify(i)).toBe(t.rect.h * 16);
        expect(t.ring.x >= 0 && t.ring.y >= 0 && t.ring.x + t.ring.w <= 1920 && t.ring.y + t.ring.h <= 1080).toBe(true);
      }
    }
  });

  it('neighbouring tiles are exactly 16 px apart, and rings never overlap', () => {
    for (const i of allInputs()) {
      const l = layout(i);
      const rects = [...l.tiles.map((t) => t.rect), ...(l.empty ? [l.empty.rect] : [])];
      const rings = [...l.tiles.map((t) => t.ring), ...(l.empty ? [l.empty.ring] : [])];
      for (const [ai, a] of rects.entries()) {
        for (const [bi, b] of rects.entries()) {
          if (ai >= bi) continue;
          const overlapY = a.y < b.y + b.h && b.y < a.y + a.h;
          const overlapX = a.x < b.x + b.w && b.x < a.x + a.w;
          // Neighbours only: no other tile sits between the two.
          const between = rects.some((c, ci) => ci !== ai && ci !== bi && (overlapY
            ? c.x >= Math.min(a.x, b.x) + 1 && c.x < Math.max(a.x, b.x) && c.y < a.y + a.h && a.y < c.y + c.h
            : c.y >= Math.min(a.y, b.y) + 1 && c.y < Math.max(a.y, b.y) && c.x < a.x + a.w && a.x < c.x + c.w));
          const gap = overlapY ? Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w) : Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
          if ((overlapY || overlapX) && !between) expect(gap, JSON.stringify(i)).toBe(16);
          if (overlapY || overlapX) expect(gap, JSON.stringify(i)).toBeGreaterThanOrEqual(16);
          const ra = rings[ai]!;
          const rb = rings[bi]!;
          const ringsOverlap = ra.x < rb.x + rb.w && rb.x < ra.x + ra.w && ra.y < rb.y + rb.h && rb.y < ra.y + ra.h;
          expect(ringsOverlap, JSON.stringify(i)).toBe(false);
        }
      }
    }
  });

  it('never two Large-class tiles, except the 2-up and 2x2 equal layouts', () => {
    // A seeded walk over add, close, Make large and Equal size (spec §9.1).
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let tiles = 2;
    let large: number | undefined;
    let equal = false;
    for (let step = 0; step < 500; step++) {
      const op = Math.floor(rand() * 4);
      if (op === 0 && tiles < 4) tiles++;
      else if (op === 1 && tiles > 2) {
        const closed = Math.floor(rand() * tiles);
        tiles--;
        if (large === closed) large = tiles >= 3 ? 0 : undefined;
        else if (large !== undefined && large > closed) large--;
      } else if (op === 2) {
        large = Math.floor(rand() * tiles);
        equal = false;
      } else if (op === 3 && tiles === 4) equal = true;
      const l = layout(large === undefined ? { tiles, equal, windowLimit: 4 } : { tiles, large, equal, windowLimit: 4 });
      const big = l.tiles.filter((t) => t.sizeClass === 'large').length;
      if (l.kind === 'a' || l.kind === 'd2') expect(big).toBe(l.tiles.length);
      else expect(big).toBe(1);
      expect(l.tiles).toHaveLength(tiles);
      expect(new Set(l.tiles.map((t) => t.tile)).size).toBe(tiles);
    }
  });
});
