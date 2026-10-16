import { describe, expect, test } from 'vitest';
import { KIND_COPY } from './kindCopy.ts';

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
