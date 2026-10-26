import { describe, expect, test } from 'vitest';
import { KIND_COPY, vodStatusLine } from './kindCopy.ts';

describe('vodStatusLine', () => {
  test('a running first load shows the count so far, grouped', () => {
    expect(vodStatusLine({ progress: 12_400, partial: false, truncated: false })).toBe('Loading… 12,400 so far');
    expect(vodStatusLine({ progress: 1, truncated: true })).toBe('Loading… 1 so far');
    expect(vodStatusLine({ progress: 1_234_567, truncated: false })).toBe('Loading… 1,234,567 so far');
  });
  test('then partial, then the cap, else nothing', () => {
    expect(vodStatusLine({ partial: true, truncated: true })).toBe("Couldn't load some categories.");
    expect(vodStatusLine({ truncated: true })).toBe('Showing the first 200,000 titles.');
    expect(vodStatusLine({ truncated: false })).toBe('');
    expect(vodStatusLine(undefined)).toBe('');
  });
});

describe('kindCopy', () => {
  test('movies', () => {
    expect(KIND_COPY.movie).toEqual({
      empty: 'This source has no movies.',
      loadError: "Couldn't load movies.",
      loading: 'Loading movies from your source…',
      detailRoute: 'movieDetail',
      categoriesTitle: 'Movie categories',
    });
  });
  test('series', () => {
    expect(KIND_COPY.series).toEqual({
      empty: 'This source has no series.',
      loadError: "Couldn't load series.",
      loading: 'Loading series from your source…',
      detailRoute: 'seriesDetail',
      categoriesTitle: 'Series categories',
    });
  });
});
