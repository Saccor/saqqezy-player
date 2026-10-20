import { describe, expect, test } from 'vitest';
import { rankFeed, recency } from '../src/rank.ts';
import type { DayTop, EntitySummary } from '../src/wikidata.ts';

const NOW = Date.UTC(2026, 9, 20);
const YEAR = 365.25 * 86_400_000;
const film = (wd: string, title: string, extra: Partial<EntitySummary> = {}): EntitySummary =>
  ({ wd, kind: 'movie', titles: [title], date: NOW - 30 * 86_400_000, year: 2026, ...extra });
const show = (wd: string, title: string, extra: Partial<EntitySummary> = {}): EntitySummary =>
  ({ wd, kind: 'series', titles: [title], date: NOW - 30 * 86_400_000, year: 2026, ...extra });

describe('recency', () => {
  test('unknown 0.5, new or upcoming 1, then decays, floored', () => {
    expect(recency(undefined, NOW)).toBe(0.5);
    expect(recency(NOW + YEAR, NOW)).toBe(1);
    expect(recency(NOW - 0.5 * YEAR, NOW)).toBe(1);
    expect(recency(NOW - 3 * YEAR, NOW)).toBeCloseTo(0.5);
    expect(recency(NOW - 100 * YEAR, NOW)).toBe(0.1);
  });
});

describe('rankFeed', () => {
  test('splits films and series, ranks by summed views × recency, skips non-titles and unknown articles', () => {
    const days: DayTop[] = [
      [['Film_A', 1000], ['Film_B', 900], ['Person', 5000], ['Show_A', 300], ['Unknown', 9999]],
      [['Film_A', 100], ['Film_B', 900]],
    ];
    const feeds = rankFeed({
      lang: 'sv', now: NOW, days,
      entities: {
        'Film A': film('Q900001', 'Film A'), 'Film B': film('Q900002', 'Film B'), Person: null, 'Show A': show('Q900003', 'Show A', { tmdb: 7 }),
      },
    });
    expect(feeds.movie).toMatchObject({ v: 1, kind: 'movie', lang: 'sv', at: new Date(NOW).toISOString() });
    expect(feeds.movie.items).toEqual([
      { rank: 1, wd: 'Q900002', year: 2026, titles: ['Film B'] },
      { rank: 2, wd: 'Q900001', year: 2026, titles: ['Film A'] },
    ]);
    expect(feeds.series.items).toEqual([{ rank: 1, wd: 'Q900003', tmdb: 7, year: 2026, titles: ['Show A'] }]);
  });

  test('an old title needs more views than a new one', () => {
    const feeds = rankFeed({
      lang: 'en', now: NOW, days: [[['Old', 1500], ['New', 1000]]],
      entities: { Old: film('Q1', 'Old', { date: NOW - 20 * YEAR, year: 2006 }), New: film('Q2', 'New') },
    });
    expect(feeds.movie.items.map((i) => i.wd)).toEqual(['Q2', 'Q1']);
  });

  test('two articles of one entity add up; the same tmdb id under two entities keeps the better one', () => {
    const feeds = rankFeed({
      lang: 'en', now: NOW, days: [[['A1', 400], ['A2', 400], ['B', 700], ['C', 600], ['D', 650]]],
      entities: {
        A1: film('Q1', 'A'), A2: film('Q1', 'A'), B: film('Q2', 'B'),
        C: film('Q3', 'C', { tmdb: 55 }), D: film('Q4', 'D', { tmdb: 55 }),
      },
    });
    expect(feeds.movie.items.map((i) => i.wd)).toEqual(['Q1', 'Q2', 'Q4']);
  });

  test('ties: more views first, then the id', () => {
    const feeds = rankFeed({
      lang: 'en', now: NOW, days: [[['B', 100], ['A', 100]]],
      entities: { A: film('Q2', 'A'), B: film('Q1', 'B') },
    });
    expect(feeds.movie.items.map((i) => i.wd)).toEqual(['Q1', 'Q2']);
  });

  test('caps each kind at 150', () => {
    const day: DayTop = [];
    const entities: Record<string, EntitySummary> = {};
    for (let i = 0; i < 200; i++) {
      day.push([`F${i}`, 1000 - i]);
      entities[`F${i}`] = film(`Q${900000 + i}`, `Synthetic ${i}`);
    }
    const feeds = rankFeed({ lang: 'en', now: NOW, days: [day], entities });
    expect(feeds.movie.items).toHaveLength(150);
    expect(feeds.movie.items[149]).toMatchObject({ rank: 150, wd: 'Q900149' });
  });

  test('TMDB boosts by tmdb id only; it never adds titles', () => {
    const days: DayTop[] = [[['A', 1000], ['B', 700], ['C', 600]]];
    const entities = { A: film('Q1', 'A', { tmdb: 1 }), B: film('Q2', 'B', { tmdb: 2 }), C: film('Q3', 'C', { tmdb: 3 }) };
    const without = rankFeed({ lang: 'en', now: NOW, days, entities });
    expect(without.movie.items.map((i) => i.wd)).toEqual(['Q1', 'Q2', 'Q3']);
    const boosted = rankFeed({ lang: 'en', now: NOW, days, entities, tmdb: { movie: [3, 999, 2], series: [1] } });
    // C: 600 × (1 + 3/3) = 1200; B: 700 × (1 + 1/3) ≈ 933; A: 1000 (its id is only in the series list).
    expect(boosted.movie.items.map((i) => i.wd)).toEqual(['Q3', 'Q1', 'Q2']);
    expect(boosted.movie.items).toHaveLength(3);
  });

  test('imdb ids and missing years pass through', () => {
    const feeds = rankFeed({
      lang: 'en', now: NOW, days: [[['A', 10]]],
      entities: { A: { wd: 'Q1', kind: 'movie', titles: ['A', 'A alias'], imdb: 'tt1' } },
    });
    expect(feeds.movie.items).toEqual([{ rank: 1, wd: 'Q1', imdb: 'tt1', titles: ['A', 'A alias'] }]);
  });
});
