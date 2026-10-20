import { describe, expect, test } from 'vitest';
import { VodCatalog } from '../src/vod/catalog.ts';
import { groupVod } from '../src/vod/grouping.ts';
import {
  applyVodOps, detectVodRegions, emptyVodLayout, isVodLayoutOp, normalizeVodLayout, vodCategoryView,
} from '../src/vod/layout.ts';
import { VOD_ALL, type VodItem, type VodList } from '../src/vod/types.ts';

const it = (n: number, title: string, categoryId: string): VodItem => ({ id: `s:m${n}`, kind: 'movie', title, categoryId });
const list: VodList = {
  items: [
    it(1, 'Synthetic Film (2021)', '1'),
    it(2, 'Example Story (2020)', '2'),
    it(3, 'Synthetic Film (2021)', '3'),
    it(4, 'Another Tale', '4'),
    it(5, 'Plain Title', '5'),
  ],
  categories: [
    { id: '1', kind: 'movie', name: 'SE | Action', count: 1 },
    { id: '2', kind: 'movie', name: 'SE | Drama', count: 1 },
    { id: '3', kind: 'movie', name: 'DK | Action', count: 1 },
    { id: '4', kind: 'movie', name: 'DK | Drama', count: 1 },
    { id: '5', kind: 'movie', name: 'Classics', count: 1 },
  ],
};
const titles = (rows: VodItem[]) => rows.map((r) => r.title);

describe('provider sort', () => {
  test("'provider' keeps the list order", () => {
    const c = new VodCatalog('movie', { ...list, items: [...list.items].reverse() });
    expect(titles(c.slice(VOD_ALL, 'provider', 0, 10).rows)).toEqual(['Plain Title', 'Another Tale', 'Synthetic Film (2021)', 'Example Story (2020)', 'Synthetic Film (2021)']);
  });
});

describe('VodLayout', () => {
  test('ops: hide, show, unshow, order; clock keys per kind', () => {
    let r = applyVodOps(emptyVodLayout(), 'movie', [{ op: 'hideCategories', ids: ['3'] }, { op: 'setCategoryOrder', ids: ['5', '1'] }]);
    expect(r.layout).toMatchObject({ version: 1, hiddenCategories: ['3'], categoryOrder: ['5', '1'] });
    expect(r.touched.sort()).toEqual(['ch:movie|3', 'cq:movie']);
    r = applyVodOps(r.layout, 'movie', [{ op: 'showCategories', ids: ['3', '4'] }]);
    expect(r.layout.hiddenCategories).toEqual([]);
    expect(r.layout.shownCategories).toEqual(['3', '4']);
    r = applyVodOps(r.layout, 'movie', [{ op: 'unshowCategories', ids: ['4'] }, { op: 'unhideCategories', ids: ['9'] }]);
    expect(r.layout.shownCategories).toEqual(['3']);
    expect(applyVodOps(r.layout, 'movie', [{ op: 'bogus' } as never]).rejected).toHaveLength(1);
    expect(isVodLayoutOp({ op: 'hideCategories', ids: ['1'] })).toBe(true);
    expect(isVodLayoutOp({ op: 'hideCategories', ids: 'x' })).toBe(false);
  });

  test('normalize repairs', () => {
    expect(normalizeVodLayout({ hiddenCategories: ['1', '1', 3], categoryOrder: 'x' })).toEqual({ ...emptyVodLayout(), hiddenCategories: ['1'] });
    expect(normalizeVodLayout(null)).toEqual(emptyVodLayout());
  });
});

describe('vodCategoryView', () => {
  const detected = detectVodRegions(list);

  test('detection reads category names', () => {
    expect(detected['1']).toMatchObject({ countries: ['SE'] });
    expect(detected['5']).toBeUndefined();
  });

  test('off: provider order, user hidden only, user order first', () => {
    const l = applyVodOps(emptyVodLayout(), 'movie', [{ op: 'hideCategories', ids: ['2'] }, { op: 'setCategoryOrder', ids: ['5'] }]).layout;
    const v = vodCategoryView(list.categories, l, { detected, codes: ['SE'], mode: 'off' });
    expect(v.order).toEqual(['5', '1', '3', '4']);
    expect([...v.hidden]).toEqual(['2']);
  });

  test('only: other countries hidden by rule, unknown stays, shown beats the rule; first orders chosen first', () => {
    const l = applyVodOps(emptyVodLayout(), 'movie', [{ op: 'showCategories', ids: ['4'] }]).layout;
    const only = vodCategoryView(list.categories, l, { detected, codes: ['SE'], mode: 'only' });
    expect(only.order).toEqual(['1', '2', '4', '5']);
    expect([...only.hidden].sort()).toEqual(['3']);
    expect(only.regionHidden.has('3')).toBe(true);
    const first = vodCategoryView(list.categories, emptyVodLayout(), { detected, codes: ['DK'], mode: 'first' });
    expect(first.order).toEqual(['3', '4', '1', '2', '5']);
    const stale = vodCategoryView(list.categories, emptyVodLayout(), { detected, codes: ['PL'], mode: 'only' });
    expect(stale.state).toEqual({ mode: 'off', requested: 'only', stale: true });
  });

  test('a catalogue view lists visible categories in view order and drops titles only in hidden ones', () => {
    const groups = groupVod(list);
    const view = vodCategoryView(groups.categories, emptyVodLayout(), { detected, codes: ['SE'], mode: 'only' });
    const c = new VodCatalog('movie', list).withGroups(groups).withView(view);
    expect(c.categories().map((x) => x.id)).toEqual(['1', '2', '5']);
    // "Synthetic Film" has a SE version: kept; "Another Tale" is only in DK | Drama: gone from All and search.
    expect(titles(c.slice(VOD_ALL, 'provider', 0, 10).rows)).toEqual(['Synthetic Film', 'Example Story', 'Plain Title']);
    expect(c.search('another', 5)).toEqual([]);
    expect(c.slice('3', 'provider', 0, 10).total).toBe(0);
    expect(c.size).toBe(3);
  });
});
