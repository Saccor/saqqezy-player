import { describe, expect, test } from 'vitest';
import { seasonsText, seriesMetaLine, showsBackdrop } from './heroLogic.ts';

describe('heroLogic', () => {
  test('backdrop art only off TV: Tizen and webOS draw a flat background instead', () => {
    expect(showsBackdrop('tizen')).toBe(false);
    expect(showsBackdrop('webos')).toBe(false);
    expect(showsBackdrop('desktop')).toBe(true);
    expect(showsBackdrop('browser')).toBe(true);
  });
  test('season count: singular, plural, omitted at 0', () => {
    expect(seasonsText(0)).toBe('');
    expect(seasonsText(1)).toBe('1 season');
    expect(seasonsText(3)).toBe('3 seasons');
  });
  test('series meta: year, seasons, then genre, age rating and rating, leaving out what is missing', () => {
    expect(seriesMetaLine({ year: 2021, seasons: 3, genre: 'Drama', ageRating: '12', rating: 7.6 }))
      .toBe('2021 · 3 seasons · Drama · 12 · ★ 7.6');
    expect(seriesMetaLine({ year: 2021, seasons: 0, genre: 'Drama' })).toBe('2021 · Drama');
    expect(seriesMetaLine({ seasons: 1, rating: 8 })).toBe('1 season · ★ 8.0');
    expect(seriesMetaLine({ seasons: 0 })).toBe('');
  });
});
