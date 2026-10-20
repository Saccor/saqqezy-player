import { describe, expect, test } from 'vitest';
import { groupVod } from '../src/vod/grouping.ts';
import {
  buildTrendingIndex, matchTrending, parseTrendingFeed, type TrendingCandidate, type TrendingFeed, type TrendingFeedItem,
} from '../src/vod/trending.ts';
import type { VodItem } from '../src/vod/types.ts';

const feed = (items: Omit<TrendingFeedItem, 'rank'>[], kind: 'movie' | 'series' = 'movie'): TrendingFeed =>
  ({ v: 1, kind, lang: 'en', at: '2026-10-20T00:00:00.000Z', items: items.map((it, i) => ({ rank: i + 1, ...it })) });
const movie = (n: number, title: string, extra: Partial<VodItem> = {}): VodItem =>
  ({ id: `s:m${n}`, kind: 'movie', title, categoryId: '1', ...extra });
/** The catalogue's titles as VOD grouping builds them. */
const groupsOf = (items: VodItem[]) => groupVod({ items, categories: [] }).groups;
const match = (f: TrendingFeed, groups: readonly TrendingCandidate[], kind: 'movie' | 'series' = 'movie', cap?: number) =>
  matchTrending(f, kind, buildTrendingIndex(groups), cap).map((g) => groups[g]!.display);

describe('matchTrending', () => {
  test('a tmdb id finds the title the panel tagged, whatever it is called', () => {
    const groups = groupsOf([movie(1, 'EN - Totally Different Name 4K', { tmdbId: 501 }), movie(2, 'Other (2020)')]);
    expect(match(feed([{ wd: 'Q1', tmdb: 501, year: 2026, titles: ['Synthetic Film'] }]), groups)).toEqual(['Totally Different Name']);
  });

  test('title and year, allowing one year either way; never two years off', () => {
    const groups = groupsOf([movie(1, 'Synthetic Film (2024)'), movie(2, 'Synthetic Story (2021)'), movie(3, 'Synthetic Tale (2018)')]);
    const f = feed([
      { wd: 'Q1', year: 2025, titles: ['Synthetic Film'] },
      { wd: 'Q2', year: 2021, titles: ['synthetic story!'] },
      { wd: 'Q3', year: 2020, titles: ['Synthetic Tale'] },
    ]);
    expect(match(f, groups)).toEqual(['Synthetic Film', 'Synthetic Story']);
  });

  test('aliases and other-language labels match too', () => {
    const groups = groupsOf([movie(1, '|SE| Syntetisk film (2025) FHD')]);
    expect(match(feed([{ wd: 'Q1', year: 2025, titles: ['Synthetic Film', 'Syntetisk film'] }]), groups)).toEqual(['Syntetisk film']);
  });

  test('a title the panel tagged with a tmdb id is still found by title and year when the feed has no id', () => {
    const groups = groupsOf([movie(1, 'Synthetic Film (2025)', { tmdbId: 777 })]);
    expect(groups[0]!.key).toBe('t:777');
    expect(match(feed([{ wd: 'Q1', year: 2025, titles: ['Synthetic Film'] }]), groups)).toEqual(['Synthetic Film']);
  });

  test('name only: an undated catalogue title matches only an unambiguous feed item', () => {
    const groups = groupsOf([movie(1, 'Synthetic Quiet'), movie(2, 'Synthetic Loud')]);
    const f = feed([
      { wd: 'Q1', year: 2025, titles: ['Synthetic Quiet'] },
      // Two different names: ambiguous, so its names are not used without a year.
      { wd: 'Q2', year: 2025, titles: ['Synthetic Loud', 'Synthetic Noise'] },
    ]);
    expect(match(f, groups)).toEqual(['Synthetic Quiet']);
  });

  test('a feed item without a year finds a dated title only when that name has one dated title', () => {
    const one = groupsOf([movie(1, 'Synthetic Film (2024)')]);
    expect(match(feed([{ wd: 'Q1', titles: ['Synthetic Film'] }]), one)).toEqual(['Synthetic Film']);
    const remakes = groupsOf([movie(1, 'Synthetic Film (1984)'), movie(2, 'Synthetic Film (2024)')]);
    expect(match(feed([{ wd: 'Q1', titles: ['Synthetic Film'] }]), remakes)).toEqual([]);
  });

  test('a dated feed item never takes a dated title of another year by name', () => {
    const groups = groupsOf([movie(1, 'Synthetic Film (1984)')]);
    expect(match(feed([{ wd: 'Q1', year: 2021, titles: ['Synthetic Film'] }]), groups)).toEqual([]);
  });

  test('movies and series never mix', () => {
    const groups = groupsOf([movie(1, 'Synthetic Film (2025)')]);
    const f = feed([{ wd: 'Q1', year: 2025, titles: ['Synthetic Film'] }]);
    expect(match(f, groups, 'series')).toEqual([]);
    expect(match({ ...f, kind: 'series' }, groups, 'movie')).toEqual([]);
  });

  test('versions of a title are one group: one tile; a group shows once, at its best rank', () => {
    const groups = groupsOf([
      movie(1, 'EN - Synthetic Film (2025) 4K'), movie(2, '|SE| Synthetic Film (2025) HD'), movie(3, 'Synthetic Other (2025)'),
    ]);
    expect(groups).toHaveLength(2);
    const f = feed([
      { wd: 'Q1', year: 2025, titles: ['Synthetic Film'] },
      { wd: 'Q2', year: 2025, titles: ['Synthetic Other'] },
      { wd: 'Q3', year: 2025, titles: ['Synthetic Film'] },
    ]);
    expect(match(f, groups)).toEqual(['Synthetic Film', 'Synthetic Other']);
  });

  test('versions split by the panel (one with a tmdb id, one without) collapse to the first group', () => {
    const groups = groupsOf([movie(1, 'Synthetic Film (2025)', { tmdbId: 9 }), movie(2, 'Synthetic Film (2025) FHD')]);
    expect(groups).toHaveLength(2);
    const got = matchTrending(feed([{ wd: 'Q1', tmdb: 9, year: 2025, titles: ['Synthetic Film'] }]), 'movie', buildTrendingIndex(groups));
    expect(got).toEqual([0]);
  });

  test('a title shown separately ("Show separately") is found by its natural key', () => {
    const items = [movie(1, 'Synthetic Film (2025) 4K'), movie(2, 'Synthetic Film (2025) HD')];
    const groups = groupVod({ items, categories: [] }, new Set(['y:synthetic film|2025'])).groups;
    expect(groups.map((g) => g.key)).toEqual(['i:s:m1', 'i:s:m2']);
    expect(match(feed([{ wd: 'Q1', year: 2025, titles: ['Synthetic Film'] }]), groups)).toEqual(['Synthetic Film']);
  });

  test('order follows the feed rank, capped; titles not in the library never appear', () => {
    const items = Array.from({ length: 30 }, (_, i) => movie(i, `Synthetic ${i} (2025)`));
    const groups = groupsOf(items);
    const f = feed([
      { wd: 'Qx', year: 2025, titles: ['Synthetic Absent Film'] },
      ...Array.from({ length: 30 }, (_, i) => ({ wd: `Q${i}`, year: 2025, titles: [`Synthetic ${29 - i}`] })),
    ]);
    const got = match(f, groups);
    expect(got).toHaveLength(20);
    expect(got.slice(0, 3)).toEqual(['Synthetic 29', 'Synthetic 28', 'Synthetic 27']);
    expect(match(f, groups, 'movie', 5)).toHaveLength(5);
  });

  test('an empty catalogue or feed matches nothing', () => {
    expect(match(feed([]), groupsOf([movie(1, 'A (2020)')]))).toEqual([]);
    expect(match(feed([{ wd: 'Q1', titles: ['A'] }]), [])).toEqual([]);
  });
});

describe('parseTrendingFeed', () => {
  const good = { v: 1, kind: 'movie', lang: 'sv', at: '2026-10-20T00:00:00Z', items: [{ rank: 1, wd: 'Q1', tmdb: 5, imdb: 'tt1', year: 2025, titles: ['A'] }] };

  test('accepts v1 and keeps known fields', () => {
    expect(parseTrendingFeed(good, 'movie')).toEqual(good);
  });

  test('rejects another version, kind or shape', () => {
    expect(parseTrendingFeed({ ...good, v: 2 }, 'movie')).toBeUndefined();
    expect(parseTrendingFeed(good, 'series')).toBeUndefined();
    expect(parseTrendingFeed({ ...good, items: 'x' }, 'movie')).toBeUndefined();
    expect(parseTrendingFeed(null, 'movie')).toBeUndefined();
  });

  test('drops bad items and bad fields, sorts by rank, caps at 150', () => {
    const items: unknown[] = [
      { rank: 2, wd: 'Q2', titles: ['B', 7, ''], tmdb: -1, year: 'x', extra: true },
      { rank: 1, wd: 'Q1', titles: [] },
      { wd: 'Q3', titles: ['C'] },
      'junk',
      ...Array.from({ length: 200 }, (_, i) => ({ rank: 10 + i, wd: `Q${10 + i}`, titles: [`T${i}`] })),
    ];
    const f = parseTrendingFeed({ ...good, items }, 'movie')!;
    expect(f.items).toHaveLength(150);
    expect(f.items[0]).toEqual({ rank: 2, wd: 'Q2', titles: ['B'] });
    expect(f.items[1]!.wd).toBe('Q10');
  });
});
