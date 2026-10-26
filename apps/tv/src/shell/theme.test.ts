import { describe, expect, it } from 'vitest';
import { contrast } from './contrast.ts';
import { ALPHA, COLORS, LAYOUT, LINE, MOTION, RADIUS, SPACE, STROKE, TYPE, centerText } from './theme.ts';

describe('theme tokens 2.0 (spec 2026-10-26 §1.1)', () => {
  it('four text sizes plus the numeral', () => {
    expect(TYPE).toEqual({ meta: 24, body: 28, title: 40, hero: 64, numeral: 72 });
  });
  it('spacing is 8 / 16 / 24 / 48, and the base gap is one of them', () => {
    expect(SPACE).toEqual({ s: 8, m: 16, l: 24, xl: 48 });
    expect(Object.values(SPACE)).toContain(LAYOUT.gap);
  });
  it('radius is 12 for cards, cells and rows, and a pill is half the height', () => {
    expect(RADIUS.card).toBe(12);
    expect(RADIUS.pill(64)).toBe(32);
    expect('radius' in LAYOUT).toBe(false);
  });
  it('one auto-hide for every auto-hide', () => {
    expect(MOTION.autoHide).toBe(4000);
  });
  it('line heights, the dimmed alpha and the badge outline are tokens', () => {
    expect(LINE).toEqual({ meta: 32, body: 36, title: 48 });
    expect(ALPHA).toEqual({ dimmed: 0.5 });
    expect(STROKE).toEqual({ outline: 2 });
  });
  it('centres a text line in a box the way the screens already did', () => {
    expect(centerText(72, TYPE.body)).toBe(18);
    expect(centerText(64, TYPE.meta)).toBe(16);
  });
  it('the merged colours are gone', () => {
    for (const k of ['osd', 'onFocusTrack', 'buffered', 'scrubAhead', 'scrubBack', 'subtitleOutline', 'imageTrack']) {
      expect(k in COLORS, k).toBe(false);
    }
  });
  it('the buffered range keeps its own step of track, and progress stays dominant over it', () => {
    expect(COLORS.trackBuffered).toBe(0x3a4356ff);
    expect(contrast(COLORS.trackBuffered, COLORS.track)).toBeGreaterThanOrEqual(1.4);
    expect(contrast(COLORS.accent, COLORS.trackBuffered)).toBeGreaterThanOrEqual(3);
  });
});
