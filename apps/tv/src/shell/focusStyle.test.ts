import { describe, expect, it } from 'vitest';
import { COLORS } from './theme.ts';
import { SELECTED_MARK, controlFill, drawnFocus, controlSubText, controlText, hoverInit, hoverMove, isLit, selectedInk } from './focusStyle.ts';
import { contrast } from './contrast.ts';

describe('drawnFocus (one hover style, equal to focus; only one item lit)', () => {
  it('draws the key selection, or the hovered item in pointer mode', () => {
    expect(drawnFocus(2, undefined, false)).toBe(2);
    expect(drawnFocus(2, 4, false)).toBe(2);
    expect(drawnFocus(2, 4, true)).toBe(4);
    expect(drawnFocus(2, undefined, true)).toBe(2);
    expect(drawnFocus(undefined, 4, true)).toBe(4);
    expect(drawnFocus(undefined, undefined, true)).toBeUndefined();
  });
});

describe('hoverMove (hover merges into focus: a genuine pointer move onto a row selects it)', () => {
  const at = (x: number, y: number) => ({ x, y });
  it('selects the row after a genuine move onto it', () => {
    expect(hoverMove(hoverInit(), 4, at(10, 300)).select).toBe(4);
  });
  it('a rehover at the same point (after a wheel step) selects nothing, even if a different row is now under it', () => {
    const s = hoverMove(hoverInit(), 4, at(10, 300)).focus;
    expect(hoverMove(s, 4, at(10, 300)).select).toBeUndefined();
    expect(hoverMove(s, 6, at(10, 300)).select).toBeUndefined();
  });
  it('moving again, even within the same row, selects the hovered row', () => {
    const s = hoverMove(hoverInit(), 4, at(10, 300)).focus;
    expect(hoverMove(s, 4, at(12, 300)).select).toBe(4);
    expect(hoverMove(s, 6, at(10, 380)).select).toBe(6);
  });
  it('a heading or no row (index undefined) selects nothing', () => {
    expect(hoverMove(hoverInit(), undefined, at(10, 300)).select).toBeUndefined();
    expect(hoverMove(hoverInit(), undefined, undefined).select).toBeUndefined();
  });
  it('leaving and coming back counts as a move', () => {
    let s = hoverMove(hoverInit(), 4, at(10, 300)).focus;
    s = hoverMove(s, undefined, undefined).focus;
    expect(hoverMove(s, 4, at(10, 300)).select).toBe(4);
  });
});

describe('controls: a focus fill with onFocus text, no scale (spec §1.2)', () => {
  it('lit when focused, or hovered in pointer mode', () => {
    expect(isLit(true, false, false)).toBe(true);
    expect(isLit(false, true, true)).toBe(true);
    expect(isLit(false, true, false)).toBe(false);
  });
  it('fill and text follow lit; the rest fill is up to the caller', () => {
    expect(controlFill(true, COLORS.surfaceRaised)).toBe(COLORS.focus);
    expect(controlFill(false, COLORS.surfaceRaised)).toBe(COLORS.surfaceRaised);
    expect(controlFill(false)).toBe(COLORS.transparent);
    expect(controlText(true)).toBe(COLORS.onFocus);
    expect(controlText(false)).toBe(COLORS.text);
    expect(controlSubText(true)).toBe(COLORS.onFocusMuted);
    expect(controlSubText(false)).toBe(COLORS.muted);
  });
  it('selected is a ✓ in accent, readable at rest and on a focus fill', () => {
    expect(SELECTED_MARK).toBe('✓');
    expect(selectedInk(false)).toBe(COLORS.accent);
    expect(selectedInk(true)).toBe(COLORS.onFocus);
    expect(contrast(COLORS.accent, COLORS.surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(COLORS.accent, COLORS.background)).toBeGreaterThanOrEqual(3);
    expect(contrast(COLORS.accent, COLORS.surfaceRaised)).toBeGreaterThanOrEqual(3);
  });
});
