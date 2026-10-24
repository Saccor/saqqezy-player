import { describe, expect, test } from 'vitest';
import { VodCatalog } from '../src/vod/catalog.ts';
import { applyVodOps, detectVodRegions, emptyVodLayout, vodCategoryView, type VodRegionView } from '../src/vod/layout.ts';
import type { VodItem, VodList } from '../src/vod/types.ts';

const it = (n: number, title: string, categoryId: string): VodItem => ({ id: `s:m${n}`, kind: 'movie', title, categoryId });
const list: VodList = {
  items: [it(1, 'Synthetic Film', '1'), it(2, 'Example Story', '2'), it(3, 'Another Tale', '3'), it(4, 'Plain Title', '4'), it(5, 'Last One', '5')],
  categories: [
    { id: '1', kind: 'movie', name: 'SE | Action', count: 1 },
    { id: '2', kind: 'movie', name: 'SE | Drama', count: 1 },
    { id: '3', kind: 'movie', name: 'DK | Action', count: 1 },
    { id: '4', kind: 'movie', name: 'DK | Drama', count: 1 },
    { id: '5', kind: 'movie', name: 'Classics', count: 1 },
  ],
};
const detected = detectVodRegions(list);
const r = (mode: VodRegionView['mode'], codes: string[], fold = true): VodRegionView => ({ detected, mode, codes, fold });
const folded = (v: ReturnType<typeof vodCategoryView>) => v.order.map((id) => (v.foldOf.has(id) ? `${id}@${v.foldOf.get(id)}` : id));

describe('vodCategoryView: your countries first, the rest folded', () => {
  test('no picks: countries fold, ties by label (Denmark before Sweden); yours is empty', () => {
    const v = vodCategoryView(list.categories, emptyVodLayout(), r('off', []));
    expect(folded(v)).toEqual(['3@DK', '4@DK', '1@SE', '2@SE', '5']);
    expect(v.yours).toBe(0);
  });

  test('picks rank by pick order; folding the rest; nothing chosen is folded', () => {
    const v = vodCategoryView(list.categories, emptyVodLayout(), r('first', ['DK', 'SE']));
    expect(folded(v)).toEqual(['3', '4', '1', '2', '5']);
    expect(v.yours).toBe(4);
    const se = vodCategoryView(list.categories, emptyVodLayout(), r('first', ['SE']));
    expect(folded(se)).toEqual(['1', '2', '3@DK', '4@DK', '5']);
    expect(se.yours).toBe(2);
  });

  test('a hand-moved category comes first and is never folded', () => {
    const l = applyVodOps(emptyVodLayout(), 'movie', [{ op: 'setCategoryOrder', ids: ['4'] }]).layout;
    const v = vodCategoryView(list.categories, l, r('first', ['SE']));
    expect(folded(v)).toEqual(['4', '1', '2', '3@DK', '5']);
    expect(v.yours).toBe(3);
  });

  test('only, fold off, or a single country: no fold', () => {
    expect(vodCategoryView(list.categories, emptyVodLayout(), r('only', ['SE'])).foldOf.size).toBe(0);
    expect(vodCategoryView(list.categories, emptyVodLayout(), r('first', ['SE'], false)).order).toEqual(['1', '2', '3', '4', '5']);
    const l = applyVodOps(emptyVodLayout(), 'movie', [{ op: 'hideCategories', ids: ['3', '4'] }]).layout;
    expect(vodCategoryView(list.categories, l, r('off', [])).foldOf.size).toBe(0);
    expect(vodCategoryView(list.categories, emptyVodLayout()).foldOf.size).toBe(0);
  });

  test('the catalogue exposes its view and lists categories in that order', () => {
    const v = vodCategoryView(list.categories, emptyVodLayout(), r('first', ['SE']));
    const c = new VodCatalog('movie', list).withView(v);
    expect(c.categoryView).toBe(v);
    expect(c.categories().map((x) => x.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(new VodCatalog('movie', list).categoryView).toBeUndefined();
  });
});
