import { describe, expect, test } from 'vitest';
import { DEV_TRENDING_URL, TMDB_ATTRIBUTION_TEXT, TRENDING_ATTRIBUTION_TEXT, aboutAttribution, trendingBaseUrl } from './trendingConfig.ts';

describe('trendingBaseUrl', () => {
  test('the build value wins; dev falls back to the fake provider; production without it has no trending', () => {
    expect(trendingBaseUrl({ VITE_TRENDING_URL: ' https://feed.example.test/trending/ ', DEV: false })).toBe('https://feed.example.test/trending');
    expect(trendingBaseUrl({ VITE_TRENDING_URL: 'https://feed.example.test/trending', DEV: true })).toBe('https://feed.example.test/trending');
    expect(trendingBaseUrl({ DEV: true })).toBe(DEV_TRENDING_URL);
    expect(DEV_TRENDING_URL).toBe('http://127.0.0.1:8899/__trending');
    expect(trendingBaseUrl({ DEV: false })).toBeUndefined();
    expect(trendingBaseUrl({ VITE_TRENDING_URL: '  ', DEV: false })).toBeUndefined();
  });

  test('only http(s) URLs', () => {
    expect(trendingBaseUrl({ VITE_TRENDING_URL: 'ftp://x/trending', DEV: false })).toBeUndefined();
    expect(trendingBaseUrl({ VITE_TRENDING_URL: 'not a url', DEV: true })).toBeUndefined();
  });
});

describe('aboutAttribution', () => {
  test('the data sources when trending is on; the TMDB line only with the build flag', () => {
    expect(aboutAttribution({ DEV: false })).toEqual([]);
    expect(aboutAttribution({ DEV: true })).toEqual([TRENDING_ATTRIBUTION_TEXT]);
    expect(aboutAttribution({ VITE_TRENDING_URL: 'https://feed.example.test/trending', VITE_TMDB_ATTRIBUTION: '1', DEV: false }))
      .toEqual([TRENDING_ATTRIBUTION_TEXT, TMDB_ATTRIBUTION_TEXT]);
    expect(aboutAttribution({ VITE_TMDB_ATTRIBUTION: '1', DEV: false })).toEqual([]);
    expect(aboutAttribution({ VITE_TMDB_ATTRIBUTION: '0', DEV: true })).toEqual([TRENDING_ATTRIBUTION_TEXT]);
  });

  test('the copy names data sources only: no links, no platform names', () => {
    expect(TRENDING_ATTRIBUTION_TEXT).toBe('Popularity: Wikimedia pageview statistics. Identifiers and titles: Wikidata. Both CC0.');
    expect(TMDB_ATTRIBUTION_TEXT).toBe('This product uses the TMDB API but is not endorsed or certified by TMDB.');
    for (const t of [TRENDING_ATTRIBUTION_TEXT, TMDB_ATTRIBUTION_TEXT]) expect(t).not.toMatch(/https?:|www\./);
  });
});
