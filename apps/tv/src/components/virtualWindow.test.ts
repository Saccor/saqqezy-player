import { describe, expect, it } from 'vitest';
import { moveFocus, pageFocus, renderRange, scrollTopFor } from './virtualWindow.ts';

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
