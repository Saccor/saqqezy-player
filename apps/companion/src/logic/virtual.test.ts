import { describe, expect, it } from 'vitest';
import { indexAt, virtualWindow } from './virtual.ts';

describe('virtualWindow', () => {
  it('covers the visible rows plus overscan', () => {
    const w = virtualWindow({ count: 50_000, itemHeight: 50, scrollTop: 1000, viewportHeight: 500, overscan: 5 });
    expect(w).toEqual({ start: 15, end: 35, totalHeight: 2_500_000 });
  });

  it('clamps at the top and the bottom', () => {
    expect(virtualWindow({ count: 100, itemHeight: 50, scrollTop: -300, viewportHeight: 500, overscan: 5 }))
      .toEqual({ start: 0, end: 9, totalHeight: 5000 }); // rows 0..3 show in the 200 px left
    expect(virtualWindow({ count: 100, itemHeight: 50, scrollTop: 9_999_999, viewportHeight: 500, overscan: 5 }))
      .toEqual({ start: 100, end: 100, totalHeight: 5000 });
    expect(virtualWindow({ count: 100, itemHeight: 50, scrollTop: 4600, viewportHeight: 500, overscan: 5 }))
      .toEqual({ start: 87, end: 100, totalHeight: 5000 });
  });

  it('is empty for an empty list and renders few rows for a huge one', () => {
    expect(virtualWindow({ count: 0, itemHeight: 50, scrollTop: 0, viewportHeight: 500 })).toEqual({ start: 0, end: 0, totalHeight: 0 });
    const w = virtualWindow({ count: 50_000, itemHeight: 64, scrollTop: 640_000, viewportHeight: 900 });
    expect(w.end - w.start).toBeLessThan(40);
  });
});

describe('indexAt', () => {
  it('maps a y offset to a row, clamped to the list', () => {
    expect(indexAt(0, 50, 10)).toBe(0);
    expect(indexAt(124, 50, 10)).toBe(2);
    expect(indexAt(-40, 50, 10)).toBe(0);
    expect(indexAt(10_000, 50, 10)).toBe(9);
    expect(indexAt(10, 50, 0)).toBe(0);
  });
});
