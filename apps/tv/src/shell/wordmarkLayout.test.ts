import { describe, expect, it } from 'vitest';
import {
  type Quad, curveLength, layoutLine, layoutOnCurve, quadPoint, quadTangentAngle,
} from './wordmarkLayout.ts';

/** The variant A arc: `M40,95 Q150,10 260,95` in a 300x130 box. */
const ARC: Quad = { p0: { x: 40, y: 95 }, p1: { x: 150, y: 10 }, p2: { x: 260, y: 95 } };

describe('quadratic curve helpers', () => {
  it('passes through its end points and peaks at t = 0.5 for a symmetric arc', () => {
    expect(quadPoint(ARC, 0)).toEqual({ x: 40, y: 95 });
    expect(quadPoint(ARC, 1)).toEqual({ x: 260, y: 95 });
    const mid = quadPoint(ARC, 0.5);
    expect(mid.x).toBeCloseTo(150);
    expect(mid.y).toBeCloseTo(52.5);
  });

  it('has a level tangent at the apex, rising on the left and falling on the right (y grows downwards)', () => {
    expect(quadTangentAngle(ARC, 0.5)).toBeCloseTo(0);
    expect(quadTangentAngle(ARC, 0)).toBeCloseTo(Math.atan2(-170, 220));
    expect(quadTangentAngle(ARC, 1)).toBeCloseTo(Math.atan2(170, 220));
  });

  it('measures the arc length (a straight curve equals its chord)', () => {
    const line: Quad = { p0: { x: 0, y: 0 }, p1: { x: 50, y: 0 }, p2: { x: 100, y: 0 } };
    expect(curveLength(line)).toBeCloseTo(100, 3);
    // Longer than the 220 chord, shorter than the control polygon (2 x 139.3).
    const len = curveLength(ARC);
    expect(len).toBeGreaterThan(235);
    expect(len).toBeLessThan(250);
  });
});

describe('layoutOnCurve', () => {
  it('centres the run on the curve: symmetric widths give mirrored glyphs and a level middle glyph', () => {
    const widths = [26, 26, 30, 30, 30, 26, 26];
    const g = layoutOnCurve(ARC, widths, 3);
    expect(g).toHaveLength(7);
    const mid = g[3]!;
    expect(mid.x).toBeCloseTo(150, 1);
    expect(mid.y).toBeCloseTo(52.5, 1);
    expect(mid.angle).toBeCloseTo(0, 3);
    for (let i = 0; i < 3; i++) {
      const a = g[i]!;
      const b = g[6 - i]!;
      expect(a.x + b.x).toBeCloseTo(300, 1);
      expect(a.y).toBeCloseTo(b.y, 1);
      expect(a.angle).toBeCloseTo(-b.angle, 3);
    }
  });

  it('puts every glyph centre on the curve, left to right, rotated to the local tangent', () => {
    const g = layoutOnCurve(ARC, [20, 34, 20, 28], 3);
    for (let i = 1; i < g.length; i++) expect(g[i]!.x).toBeGreaterThan(g[i - 1]!.x);
    for (const p of g) {
      // Solve x(t) for the symmetric arc (x is linear in t here) and compare.
      const t = (p.x - 40) / 220;
      expect(p.y).toBeCloseTo(quadPoint(ARC, t).y, 1);
      expect(p.angle).toBeCloseTo(quadTangentAngle(ARC, t), 2);
    }
  });

  it('spaces glyph centres by half widths plus the letter spacing, measured along the curve', () => {
    const widths = [20, 40, 20];
    const g = layoutOnCurve(ARC, widths, 5);
    const along = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);
    // On a gently curved arc the chord between neighbours is within a hair of the arc distance.
    expect(along(g[0]!, g[1]!)).toBeCloseTo(10 + 5 + 20, 0);
    expect(along(g[1]!, g[2]!)).toBeCloseTo(20 + 5 + 10, 0);
  });

  it('returns nothing for an empty run', () => {
    expect(layoutOnCurve(ARC, [], 3)).toEqual([]);
  });
});

describe('layoutLine', () => {
  it('returns glyph centres for a straight run centred on cx, with spacing between glyphs only', () => {
    // total = 10 + 20 + 10 + 2 x 7 = 54, so the run spans 123..177 around 150.
    expect(layoutLine([10, 20, 10], 7, 150)).toEqual([128, 150, 172]);
    expect(layoutLine([], 7, 150)).toEqual([]);
  });
});
