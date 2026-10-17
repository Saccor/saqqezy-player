import { describe, expect, test } from 'vitest';
import { KIND_COPY, vodStatusLine } from './kindCopy.ts';

describe('vodStatusLine', () => {
  test('a running first load shows the count so far, grouped', () => {
    expect(vodStatusLine('movie', { progress: 12_400, partial: false, truncated: false })).toBe('Still loading… 12,400 movies so far');
    expect(vodStatusLine('series', { progress: 1, truncated: true })).toBe('Still loading… 1 series so far');
    expect(vodStatusLine('movie', { progress: 1_234_567, truncated: false })).toBe('Still loading… 1,234,567 movies so far');
  });
  test('then partial, then the cap, else nothing', () => {
    expect(vodStatusLine('movie', { partial: true, truncated: true })).toBe('Some categories could not be loaded.');
    expect(vodStatusLine('movie', { truncated: true })).toBe('Showing the first 200,000 titles.');
    expect(vodStatusLine('movie', { truncated: false })).toBe('');
    expect(vodStatusLine('movie', undefined)).toBe('');
  });
});

describe('kindCopy', () => {
  test('movies', () => {
    expect(KIND_COPY.movie).toEqual({
      empty: 'This source has no movies.',
      loadError: 'Movies could not be loaded.',
      loading: 'Loading movies from your source…',
      detailRoute: 'movieDetail',
    });
  });
  test('series', () => {
    expect(KIND_COPY.series).toEqual({
      empty: 'This source has no series.',
      loadError: 'Series could not be loaded.',
      loading: 'Loading series from your source…',
      detailRoute: 'seriesDetail',
    });
  });
});
