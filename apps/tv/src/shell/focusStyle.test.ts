import { describe, expect, it } from 'vitest';
import { drawnFocus, focusInit, hoverMove } from './focusStyle.ts';

describe('drawnFocus (spec 2026-10-26 §1.2: one hover style, equal to focus)', () => {
  it('draws the key selection, or the hovered item in pointer mode', () => {
    expect(drawnFocus(2, undefined, false)).toBe(2);
    expect(drawnFocus(2, 4, false)).toBe(2);
    expect(drawnFocus(2, 4, true)).toBe(4);
    expect(drawnFocus(2, undefined, true)).toBe(2);
  });
});

describe('hoverMove (hover merges into focus: a genuine pointer move onto a row selects it)', () => {
  const at = (x: number, y: number) => ({ x, y });
  it('selects the row after a genuine move onto it', () => {
    expect(hoverMove(focusInit(), 4, at(10, 300)).select).toBe(4);
  });
  it('a rehover at the same point (after a wheel step) selects nothing, even if a different row is now under it', () => {
    const s = hoverMove(focusInit(), 4, at(10, 300)).focus;
    expect(hoverMove(s, 4, at(10, 300)).select).toBeUndefined();
    expect(hoverMove(s, 6, at(10, 300)).select).toBeUndefined();
  });
  it('moving again, even within the same row, selects the hovered row', () => {
    const s = hoverMove(focusInit(), 4, at(10, 300)).focus;
    expect(hoverMove(s, 4, at(12, 300)).select).toBe(4);
    expect(hoverMove(s, 6, at(10, 380)).select).toBe(6);
  });
  it('a heading or no row (index undefined) selects nothing', () => {
    expect(hoverMove(focusInit(), undefined, at(10, 300)).select).toBeUndefined();
    expect(hoverMove(focusInit(), undefined, undefined).select).toBeUndefined();
  });
  it('leaving and coming back counts as a move', () => {
    let s = hoverMove(focusInit(), 4, at(10, 300)).focus;
    s = hoverMove(s, undefined, undefined).focus;
    expect(hoverMove(s, 4, at(10, 300)).select).toBe(4);
  });
});
