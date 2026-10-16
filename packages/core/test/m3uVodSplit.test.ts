import { describe, expect, test } from 'vitest';
import { classifyEntry, splitM3uVod } from '../src/m3u/vodSplit.ts';
import { m3uEntriesToChannels } from '../src/m3u/toChannels.ts';
import type { M3uEntry } from '../src/m3u/parse.ts';
import { VOD_UNCATEGORIZED } from '../src/vod/types.ts';

const e = (name: string, url: string, extra: Partial<M3uEntry> = {}): M3uEntry => ({ name, url, ...extra });

describe('classifyEntry', () => {
  test('by the first path segment', () => {
    expect(classifyEntry('http://h.test/movie/u/p/1.mkv')).toBe('movie');
    expect(classifyEntry('http://h.test/MOVIE/u/p/1.mkv')).toBe('movie');
    expect(classifyEntry('http://h.test/series/u/p/1.mp4')).toBe('episode');
    expect(classifyEntry('http://h.test/live/u/p/1.ts')).toBe('live');
    expect(classifyEntry('http://h.test/u/p/1')).toBe('live');
    expect(classifyEntry('http://h.test/live/movie/1.ts')).toBe('live');
    expect(classifyEntry('not a url')).toBe('live');
  });
});

describe('splitM3uVod', () => {
  const entries: M3uEntry[] = [
    e('Channel 001', 'http://h.test/live/u/p/1.ts', { tvgChno: 1, groupTitle: 'News' }),
    e('Synthetic Film 001 (2021)', 'http://h.test/movie/u/p/11.mkv', { groupTitle: 'Drama', tvgLogo: 'http://img.test/11.jpg' }),
    e('Synthetic Film 002', 'http://h.test/movie/u/p/12.mp4'),
    e('Synthetic Film 001 (2021)', 'http://h.test/movie/u/p/11.mkv', { groupTitle: 'Drama' }),
    e('Synthetic Show S01E02', 'http://h.test/series/u/p/102.mp4', { groupTitle: 'Shows' }),
    e('Synthetic Show S01E01 - Pilot', 'http://h.test/series/u/p/101.mp4', { groupTitle: 'Shows', tvgLogo: 'http://img.test/101.jpg' }),
    e('synthetic show S02E01', 'http://h.test/series/u/p/201.mp4', { groupTitle: 'Shows' }),
    e('Unmarked Special', 'http://h.test/series/u/p/900.mp4'),
    e('Channel 002', 'http://h.test/live/u/p/2.ts', { groupTitle: 'News' }),
  ];
  const r = splitM3uVod('src', entries);

  test('live entries pass through untouched and in order', () => {
    expect(r.live.map((x) => x.name)).toEqual(['Channel 001', 'Channel 002']);
    expect(m3uEntriesToChannels('src', r.live).map((c) => c.number)).toEqual([1, 2]);
  });

  test('movies: de-duplicated by URL, year split, logo as poster, categories by group', () => {
    expect(r.movies.items.map((m) => ({ title: m.title, year: m.year, poster: m.poster, categoryId: m.categoryId, url: m.url }))).toEqual([
      { title: 'Synthetic Film 001', year: 2021, poster: 'http://img.test/11.jpg', categoryId: 'g:Drama', url: 'http://h.test/movie/u/p/11.mkv' },
      { title: 'Synthetic Film 002', year: undefined, poster: undefined, categoryId: VOD_UNCATEGORIZED, url: 'http://h.test/movie/u/p/12.mp4' },
    ]);
    expect(r.movies.categories.map((c) => [c.name, c.count])).toEqual([['Drama', 1], ['Uncategorized', 1]]);
    expect(r.movies.items[0]!.id).toMatch(/^src:v[0-9a-f]{8}$/);
  });

  test('an unmarked episode numbers after the highest marked one in its show', () => {
    const rr = splitM3uVod('src', [
      e('Show S01E01', 'http://h.test/series/u/p/1.mp4'),
      e('Show S01E02', 'http://h.test/series/u/p/2.mp4'),
      e('Show', 'http://h.test/series/u/p/3.mp4'),
      e('show', 'http://h.test/series/u/p/4.mp4'),
    ]);
    const eps = rr.series.episodes![rr.series.items[0]!.id]!;
    expect(eps.map((x) => [x.season, x.episode])).toEqual([[1, 1], [1, 2], [1, 3], [1, 4]]);
  });

  test('series: grouped case-insensitively by show, episodes ordered, unmarked is its own series', () => {
    expect(r.series.items.map((s) => s.title)).toEqual(['Synthetic Show', 'Unmarked Special']);
    const show = r.series.items[0]!;
    expect(show.poster).toBe('http://img.test/101.jpg');
    const eps = r.series.episodes![show.id]!;
    expect(eps.map((x) => [x.season, x.episode, x.title])).toEqual([
      [1, 1, 'Pilot'], [1, 2, 'Synthetic Show S01E02'], [2, 1, 'synthetic show S02E01'],
    ]);
    const special = r.series.episodes![r.series.items[1]!.id]!;
    expect(special.map((x) => [x.season, x.episode, x.title])).toEqual([[1, 1, 'Unmarked Special']]);
  });
});
