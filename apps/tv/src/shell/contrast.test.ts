import { describe, expect, test } from 'vitest';
import { contrast } from './contrast.ts';
import { COLORS } from './theme.ts';

describe('contrast', () => {
  test('black on white is 21:1, a colour on itself 1:1', () => {
    expect(contrast(0x000000ff, 0xffffffff)).toBeCloseTo(21, 1);
    expect(contrast(0x4f8cffff, 0x4f8cffff)).toBeCloseTo(1, 5);
  });
  test('theme pairs meet the spec', () => {
    expect(contrast(COLORS.text, COLORS.background)).toBeGreaterThanOrEqual(7);
    expect(contrast(COLORS.muted, COLORS.background)).toBeGreaterThanOrEqual(7);
    expect(contrast(COLORS.subtle, COLORS.background)).toBeGreaterThanOrEqual(5);
    expect(contrast(COLORS.textSecondary, COLORS.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(COLORS.muted, COLORS.surfaceRaised)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(COLORS.onFocus, COLORS.focus)).toBeGreaterThanOrEqual(7);
    expect(contrast(COLORS.onFocusMuted, COLORS.focus)).toBeGreaterThanOrEqual(4.5);
    // A focused row's channel number on its logo tile; the keyboard's Shift key while on.
    expect(contrast(COLORS.onFocusMuted, COLORS.onFocusTrack)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(COLORS.onFocus, COLORS.subtle)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(COLORS.accent, COLORS.background)).toBeGreaterThanOrEqual(3);
    expect(contrast(COLORS.focus, COLORS.background)).toBeGreaterThanOrEqual(3);
  });
});
