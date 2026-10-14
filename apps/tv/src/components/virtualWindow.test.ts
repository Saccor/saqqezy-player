import { describe, expect, it } from 'vitest';
import { moveFocus, pageFocus, renderRange, scrollTopFor } from './virtualWindow.ts';
import { firstSelectable, stepSelectable } from './virtualWindow.ts';

describe('virtual window math', () => {
  it('keeps the focused row inside the viewport and clamps to the list', () => {
    expect(scrollTopFor(0, 0, 10, 200)).toBe(0);
    expect(scrollTopFor(9, 0, 10, 200)).toBe(0);
    expect(scrollTopFor(10, 0, 10, 200)).toBe(1);
    expect(scrollTopFor(4, 8, 10, 200)).toBe(4);
    expect(scrollTopFor(199, 0, 10, 200)).toBe(190);
    expect(scrollTopFor(3, 150, 10, 5)).toBe(0);
    expect(scrollTopFor(0, 0, 10, 0)).toBe(0);
  });

  it('renders only the visible rows plus 5 above and 5 below', () => {
    expect(renderRange(0, 10, 200)).toEqual({ from: 0, to: 15 });
    expect(renderRange(50, 10, 200)).toEqual({ from: 45, to: 65 });
    expect(renderRange(190, 10, 200)).toEqual({ from: 185, to: 200 });
    expect(renderRange(0, 10, 3)).toEqual({ from: 0, to: 3 });
    expect(renderRange(0, 10, 0)).toEqual({ from: 0, to: 0 });
    const r = renderRange(100, 10, 200, 5);
    expect(r.to - r.from).toBeLessThanOrEqual(10 + 10);
  });

  it('moves and pages focus within bounds', () => {
    expect(moveFocus(0, -1, 200)).toBe(0);
    expect(moveFocus(5, 1, 200)).toBe(6);
    expect(moveFocus(199, 1, 200)).toBe(199);
    expect(moveFocus(0, 1, 0)).toBe(0);
    expect(pageFocus(5, 1, 10, 200)).toBe(15);
    expect(pageFocus(195, 1, 10, 200)).toBe(199);
    expect(pageFocus(5, -1, 10, 200)).toBe(0);
  });
});

describe('stepSelectable', () => {
  // Rows 0 and 3 are headings.
  const ok = (i: number) => i !== 0 && i !== 3;

  it('skips headings', () => {
    expect(stepSelectable(2, 1, 6, ok)).toBe(4);
    expect(stepSelectable(4, -1, 6, ok)).toBe(2);
  });

  it('stays put when only headings lie beyond', () => {
    expect(stepSelectable(1, -1, 6, ok)).toBe(1);
    expect(stepSelectable(5, 1, 6, ok)).toBe(5);
  });

  it('a start on a heading moves to the nearest selectable row in that direction', () => {
    expect(stepSelectable(0, 1, 6, ok)).toBe(1);
  });

  it('every row selectable: plain clamped moves', () => {
    expect(stepSelectable(0, -1, 3, () => true)).toBe(0);
    expect(stepSelectable(1, 1, 3, () => true)).toBe(2);
  });
});

describe('firstSelectable', () => {
  it('keeps a selectable index and moves off headings (down first, then up)', () => {
    const ok = (i: number) => i !== 0 && i !== 3;
    expect(firstSelectable(2, 6, ok)).toBe(2);
    expect(firstSelectable(0, 6, ok)).toBe(1);
    expect(firstSelectable(3, 4, ok)).toBe(2);
    expect(firstSelectable(9, 6, ok)).toBe(5);
    expect(firstSelectable(0, 0, ok)).toBe(0);
  });
});
