import { describe, expect, test } from 'vitest';
import { CARD_COLOURS, barWidth, formatRuntime, metaLine, posterFace, titleCardColour } from './posterLogic.ts';

describe('posterLogic', () => {
  test('title-card colour is stable and from the palette', () => {
    const c = titleCardColour('Synthetic Film 001');
    expect(CARD_COLOURS).toContain(c);
    expect(titleCardColour('Synthetic Film 001')).toBe(c);
    expect(c).toBe(0x1d3b53ff); // pinned: a hash change must be visible
    expect(new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(titleCardColour)).size).toBeGreaterThan(1);
  });
  test('runtime', () => {
    expect(formatRuntime(114)).toBe('1 h 54 min');
    expect(formatRuntime(48)).toBe('48 min');
    expect(formatRuntime(120)).toBe('2 h');
    expect(formatRuntime(undefined)).toBeUndefined();
    expect(formatRuntime(0)).toBeUndefined();
    expect(formatRuntime(NaN)).toBeUndefined();
    expect(formatRuntime(Infinity)).toBeUndefined();
    expect(formatRuntime(114.5)).toBe('1 h 55 min');
    expect(formatRuntime(59)).toBe('59 min');
    expect(formatRuntime(60)).toBe('1 h');
  });
  test('meta line skips missing parts', () => {
    expect(metaLine({ year: 2022, runtimeMin: 114, genre: 'Drama', ageRating: '12', rating: 7.6 })).toBe('2022 · 1 h 54 min · Drama · 12 · ★ 7.6');
    expect(metaLine({ year: 2022 })).toBe('2022');
    expect(metaLine({ rating: 8 })).toBe('★ 8.0');
    expect(metaLine({})).toBe('');
    expect(metaLine({ year: 2022, rating: 0 })).toBe('2022');
    expect(metaLine({ year: 2022, rating: NaN })).toBe('2022');
  });
  test('progress bar width', () => {
    expect(barWidth(0.5, 188)).toBe(94);
    expect(barWidth(undefined, 188)).toBe(0);
    expect(barWidth(2, 188)).toBe(188);
    expect(barWidth(-1, 188)).toBe(0);
    expect(barWidth(NaN, 188)).toBe(0);
    expect(barWidth(1, 188)).toBe(188);
  });
});

describe('posterFace', () => {
  test('a tile not here yet is a skeleton', () => {
    expect(posterFace({ pending: true, image: 'http://x/p.jpg', loaded: false, failed: false })).toBe('skeleton');
  });

  test('a poster still loading is a skeleton; once loaded, the image', () => {
    expect(posterFace({ pending: false, image: 'http://x/p.jpg', loaded: false, failed: false })).toBe('skeleton');
    expect(posterFace({ pending: false, image: 'http://x/p.jpg', loaded: true, failed: false })).toBe('image');
  });

  test('no poster, or one that failed: the title on a coloured card', () => {
    expect(posterFace({ pending: false, image: undefined, loaded: false, failed: false })).toBe('card');
    expect(posterFace({ pending: false, image: 'http://x/p.jpg', loaded: false, failed: true })).toBe('card');
  });
});
