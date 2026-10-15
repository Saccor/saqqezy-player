import { describe, expect, test } from 'vitest';
import { CARD_COLOURS, barWidth, formatRuntime, metaLine, titleCardColour } from './posterLogic.ts';

describe('posterLogic', () => {
  test('title-card colour is stable and from the palette', () => {
    const c = titleCardColour('Synthetic Film 001');
    expect(CARD_COLOURS).toContain(c);
    expect(titleCardColour('Synthetic Film 001')).toBe(c);
    expect(new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(titleCardColour)).size).toBeGreaterThan(1);
  });
  test('runtime', () => {
    expect(formatRuntime(114)).toBe('1 h 54 min');
    expect(formatRuntime(48)).toBe('48 min');
    expect(formatRuntime(120)).toBe('2 h');
    expect(formatRuntime(undefined)).toBeUndefined();
    expect(formatRuntime(0)).toBeUndefined();
  });
  test('meta line skips missing parts', () => {
    expect(metaLine({ year: 2022, runtimeMin: 114, genre: 'Drama', ageRating: '12', rating: 7.6 })).toBe('2022 · 1 h 54 min · Drama · 12 · ★ 7.6');
    expect(metaLine({ year: 2022 })).toBe('2022');
    expect(metaLine({ rating: 8 })).toBe('★ 8.0');
    expect(metaLine({})).toBe('');
  });
  test('progress bar width', () => {
    expect(barWidth(0.5, 188)).toBe(94);
    expect(barWidth(undefined, 188)).toBe(0);
    expect(barWidth(2, 188)).toBe(188);
    expect(barWidth(-1, 188)).toBe(0);
  });
});
