import { describe, expect, test } from 'vitest';
import { buildVodList, emptyVodList, seasonsOf } from '../src/vod/list.ts';
import { VOD_UNCATEGORIZED, type Episode, type VodItem } from '../src/vod/types.ts';

const item = (n: number, categoryId: string): VodItem => ({ id: `s:m${n}`, kind: 'movie', title: `Synthetic Film ${n}`, categoryId });
const cat = (id: string, name: string) => ({ id, kind: 'movie' as const, name, count: 0 });
const ep = (season: number, episode: number, id = `e${season}${episode}`): Episode => ({ id, season, episode, title: `Ep ${episode}` });

describe('buildVodList', () => {
  test('counts per category, drops empty ones, keeps source order', () => {
    const list = buildVodList('movie', [item(1, '2'), item(2, '1'), item(3, '2')], [cat('1', 'Drama'), cat('2', 'Comedy'), cat('3', 'Empty')]);
    expect(list.categories).toEqual([
      { id: '1', kind: 'movie', name: 'Drama', count: 1 },
      { id: '2', kind: 'movie', name: 'Comedy', count: 2 },
    ]);
    expect(list.episodes).toBeUndefined();
    expect(list.truncated).toBeUndefined();
  });

  test('unknown category ids move to an Uncategorized category at the end', () => {
    const list = buildVodList('movie', [item(1, '9'), item(2, '1')], [cat('1', 'Drama')]);
    expect(list.items[0]!.categoryId).toBe(VOD_UNCATEGORIZED);
    expect(list.categories.at(-1)).toEqual({ id: VOD_UNCATEGORIZED, kind: 'movie', name: 'Uncategorized', count: 1 });
  });

  test('duplicate category ids are de-duplicated, first wins', () => {
    const list = buildVodList('movie', [item(1, '1'), item(2, '1')], [cat('1', 'Drama'), cat('1', 'Dupe')]);
    expect(list.categories).toEqual([{ id: '1', kind: 'movie', name: 'Drama', count: 2 }]);
  });

  test('extras are kept', () => {
    const list = buildVodList('series', [], [], { episodes: { x: [] }, truncated: true });
    expect(list.episodes).toEqual({ x: [] });
    expect(list.truncated).toBe(true);
  });

  test('emptyVodList', () => {
    expect(emptyVodList()).toEqual({ items: [], categories: [] });
  });
});

describe('seasonsOf', () => {
  test('groups by season, sorts seasons and episodes, names seasons', () => {
    const seasons = seasonsOf([ep(2, 1), ep(1, 2), ep(1, 1)], new Map([[2, 'Second']]));
    expect(seasons.map((s) => [s.number, s.name, s.episodes.map((e) => e.episode)])).toEqual([
      [1, 'Season 1', [1, 2]],
      [2, 'Second', [1]],
    ]);
  });
  test('season 0 is last and named Specials unless named', () => {
    const seasons = seasonsOf([ep(0, 1), ep(2, 1), ep(1, 1)]);
    expect(seasons.map((s) => [s.number, s.name])).toEqual([[1, 'Season 1'], [2, 'Season 2'], [0, 'Specials']]);
    expect(seasonsOf([ep(0, 1)], new Map([[0, 'Extras']]))[0]!.name).toBe('Extras');
  });
  test('equal episode numbers keep input order', () => {
    const seasons = seasonsOf([ep(1, 1, 'a'), ep(1, 1, 'b')]);
    expect(seasons[0]!.episodes.map((e) => e.id)).toEqual(['a', 'b']);
  });
});
