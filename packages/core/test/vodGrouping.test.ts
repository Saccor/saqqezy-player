import { describe, expect, test } from 'vitest';
import { groupVod } from '../src/vod/grouping.ts';
import type { VodCategory, VodItem, VodKind, VodList } from '../src/vod/types.ts';

let n = 0;
function item(title: string, extra: Partial<VodItem> = {}, kind: VodKind = 'movie'): VodItem {
  n++;
  return { id: `src:m${n}`, kind, title, categoryId: 'c1', ...extra };
}
function list(items: VodItem[], categories: VodCategory[] = [{ id: 'c1', kind: 'movie', name: 'Movies', count: items.length }]): VodList {
  return { items, categories };
}
const keys = (l: VodList, splits?: ReadonlySet<string>) => groupVod(l, splits).groups.map((g) => g.key);

describe('groupVod', () => {
  test('language and quality versions of one title make one group', () => {
    const l = list([
      item('EN - Synthetic Film (2021) HD'),
      item('|SE| Synthetic Film 2021 FHD'),
      item('[DK] Synthetic Film (2021)'),
      item('EN - Synthetic Film (2021) 4K', { poster: 'p.jpg' }),
      item('Synthetic Film (2021) [MULTI-SUB]'),
    ]);
    const g = groupVod(l);
    expect(g.groups).toHaveLength(1);
    const [only] = g.groups;
    expect(only).toMatchObject({ key: 'y:synthetic film|2021', members: [0, 1, 2, 3, 4], lead: 3, display: 'Synthetic Film', year: 2021, quality: 0, langs: ['en', 'sv', 'da'] });
    expect([...g.groupOf]).toEqual([0, 0, 0, 0, 0]);
    expect(g.memberLang).toEqual(['en', 'sv', 'da', 'en', undefined]);
    expect([...g.memberQuality]).toEqual([2, 1, 4, 0, 4]);
  });

  test('a different year stays apart (remakes)', () => {
    expect(keys(list([item('Synthetic Film (2021)'), item('Synthetic Film (1998)')]))).toEqual(['y:synthetic film|2021', 'y:synthetic film|1998']);
  });

  test('sequel numbers stay apart; "2" and "II" match', () => {
    const g = groupVod(list([item('Synthetic Film'), item('Synthetic Film 2'), item('EN - Synthetic Film II')]));
    expect(g.groups.map((x) => x.members)).toEqual([[0], [1, 2]]);
  });

  test('a short title never merges with a longer one', () => {
    expect(keys(list([item('Visitor (1979)'), item('Visitors (1979)')]))).toHaveLength(2);
  });

  test('a year-less version joins the only dated group of its title', () => {
    const g = groupVod(list([item('Synthetic Film (2021) 4K'), item('SE: Synthetic Film')]));
    expect(g.groups.map((x) => x.members)).toEqual([[0, 1]]);
  });

  test('year-less versions stay on their own when the title has two years', () => {
    const g = groupVod(list([item('Synthetic Film (2021)'), item('Synthetic Film (1998)'), item('Synthetic Film'), item('EN - Synthetic Film')]));
    expect(g.groups.map((x) => [x.key, x.members])).toEqual([
      ['y:synthetic film|2021', [0]], ['y:synthetic film|1998', [1]], ['n:synthetic film', [2, 3]],
    ]);
  });

  test('a TMDB id groups whatever the title says', () => {
    const g = groupVod(list([item('Synthetic Film', { tmdbId: 11 }), item('Synthetisk Film', { tmdbId: 11 }), item('Synthetic Film')]));
    expect(g.groups.map((x) => [x.key, x.members])).toEqual([['t:11', [0, 1]], ['n:synthetic film', [2]]]);
  });

  test('a split key shows each version on its own', () => {
    const items = [item('EN - Synthetic Film (2021)'), item('SE - Synthetic Film (2021)')];
    const g = groupVod(list(items), new Set(['y:synthetic film|2021']));
    expect(g.groups.map((x) => x.key)).toEqual([`i:${items[0]!.id}`, `i:${items[1]!.id}`]);
    expect(g.groups.map((x) => x.display)).toEqual(['Synthetic Film', 'Synthetic Film']);
    expect(g.groups.map((x) => x.splitFrom)).toEqual(['y:synthetic film|2021', 'y:synthetic film|2021']);
    expect(groupVod(list(items)).groups[0]!.splitFrom).toBeUndefined();
  });

  test('Bug B: provider categories by default; a combined title is listed in each of its versions categories', () => {
    const cats: VodCategory[] = [
      { id: '1', kind: 'movie', name: 'SE | Action', count: 2 },
      { id: '2', kind: 'movie', name: 'EN | Action', count: 1 },
      { id: '4', kind: 'movie', name: 'Drama', count: 1 },
    ];
    const g = groupVod(list([
      item('Synthetic Film (2021)', { categoryId: '1' }),
      item('Example Story (2020)', { categoryId: '1' }),
      item('Synthetic Film (2021)', { categoryId: '2' }),
      item('Example Story (2020)', { categoryId: '4' }),
    ], cats));
    expect(g.categories).toEqual([
      { id: '1', kind: 'movie', name: 'SE | Action', count: 2 },
      { id: '2', kind: 'movie', name: 'EN | Action', count: 1 },
      { id: '4', kind: 'movie', name: 'Drama', count: 1 },
    ]);
    expect(g.groups.map((x) => x.categoryIds)).toEqual([['1', '2'], ['1', '4']]);
    expect(g.groups).toHaveLength(2);
  });

  test('provider categories: an unknown category id keeps its id', () => {
    const g = groupVod(list([item('Synthetic Film', { categoryId: 'gone' })], []));
    expect(g.groups[0]!.categoryIds).toEqual(['gone']);
    expect(g.categories).toEqual([{ id: 'gone', kind: 'movie', name: 'gone', count: 1 }]);
  });

  test('categories merge by name without language or quality (opt-in)', () => {
    const cats: VodCategory[] = [
      { id: '1', kind: 'movie', name: 'SE | Action', count: 2 },
      { id: '2', kind: 'movie', name: 'EN | Action', count: 1 },
      { id: '3', kind: 'movie', name: 'Action 4K', count: 1 },
      { id: '4', kind: 'movie', name: 'Drama', count: 1 },
    ];
    const g = groupVod(list([
      item('Synthetic Film (2021)', { categoryId: '1' }),
      item('Example Story (2020)', { categoryId: '1' }),
      item('Synthetic Film (2021)', { categoryId: '2' }),
      item('Synthetic Film (2021) 4K', { categoryId: '3' }),
      item('Example Story (2020)', { categoryId: '4' }),
    ], cats), undefined, { mergeCategories: true });
    expect(g.categories).toEqual([
      { id: 'c:action', kind: 'movie', name: 'Action', count: 2 },
      { id: 'c:drama', kind: 'movie', name: 'Drama', count: 1 },
    ]);
    expect(g.groups.map((x) => x.categoryIds)).toEqual([['c:action'], ['c:action', 'c:drama']]);
  });

  test('the category language is used when the title has none', () => {
    const cats: VodCategory[] = [{ id: '1', kind: 'movie', name: 'SE | Action', count: 1 }];
    expect(groupVod(list([item('Synthetic Film', { categoryId: '1' })], cats)).groups[0]!.langs).toEqual(['sv']);
  });

  test('an unknown category id still gets a group category (merged)', () => {
    const g = groupVod(list([item('Synthetic Film', { categoryId: 'gone' })], []), undefined, { mergeCategories: true });
    expect(g.groups[0]!.categoryIds).toEqual(['c:gone']);
    expect(g.categories).toEqual([{ id: 'c:gone', kind: 'movie', name: 'gone', count: 1 }]);
  });

  test('series group the same way', () => {
    const g = groupVod({ items: [item('EN - Example Story', {}, 'series'), item('SE - Example Story', {}, 'series')], categories: [] });
    expect(g.groups).toHaveLength(1);
  });
});
