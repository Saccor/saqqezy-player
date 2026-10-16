import { describe, expect, test } from 'vitest';
import { VodCatalog } from '../src/vod/catalog.ts';
import { VOD_ALL, type VodItem, type VodList } from '../src/vod/types.ts';

const it = (n: number, title: string, extra: Partial<VodItem> = {}): VodItem => ({ id: `s:m${n}`, kind: 'movie', title, categoryId: '1', ...extra });
const list: VodList = {
  items: [
    it(1, 'Bravo', { added: 100, rating: 7 }),
    it(2, 'alpha', { added: 300, categoryId: '2' }),
    it(3, 'Élan', { added: 200, rating: 9 }),
    it(4, 'Charlie', { rating: 7 }),
  ],
  categories: [{ id: '1', kind: 'movie', name: 'Drama', count: 3 }, { id: '2', kind: 'movie', name: 'Comedy', count: 1 }],
  episodes: { 's:s9': [{ id: 'e1', season: 1, episode: 1, title: 'Pilot' }] },
};
const c = new VodCatalog('movie', list);
const titles = (rows: VodItem[]) => rows.map((r) => r.title);

describe('VodCatalog', () => {
  test('basics', () => {
    expect(c.size).toBe(4);
    expect(c.truncated).toBe(false);
    expect(c.hasAddedDates).toBe(true);
    expect(c.categories().map((x) => x.name)).toEqual(['Drama', 'Comedy']);
    expect(c.byId('s:m3')?.title).toBe('Élan');
    expect(c.episodes('s:s9')?.[0]?.title).toBe('Pilot');
  });

  test('sorts: added (newest first, undated last), title (accent/case-insensitive), rating (unrated last, ties by title)', () => {
    expect(titles(c.slice(VOD_ALL, 'added', 0, 10).rows)).toEqual(['alpha', 'Élan', 'Bravo', 'Charlie']);
    expect(titles(c.slice(VOD_ALL, 'title', 0, 10).rows)).toEqual(['alpha', 'Bravo', 'Charlie', 'Élan']);
    expect(titles(c.slice(VOD_ALL, 'rating', 0, 10).rows)).toEqual(['Élan', 'Bravo', 'Charlie', 'alpha']);
  });

  test('category slices, offsets and totals', () => {
    expect(c.slice('1', 'title', 1, 1)).toEqual({ total: 3, rows: [list.items[3]] });
    expect(c.slice('2', 'title', 0, 10).total).toBe(1);
    expect(c.slice('missing', 'title', 0, 10)).toEqual({ total: 0, rows: [] });
    expect(c.slice(VOD_ALL, 'title', -5, 1).rows).toHaveLength(1);
  });

  test('recentlyAdded and search', () => {
    expect(titles(c.recentlyAdded(2))).toEqual(['alpha', 'Élan']);
    expect(titles(c.search('ELAN', 10))).toEqual(['Élan']);
    expect(titles(c.search('a', 10))).toEqual(['alpha', 'Bravo', 'Charlie', 'Élan']);
    expect(titles(c.search('ar', 10))).toEqual(['Charlie']);
    expect(c.search('  ', 10)).toEqual([]);
    expect(c.search('a', 2)).toHaveLength(2);
  });

  test('search: a negative or zero cap returns nothing; top-k matches the full ranking', () => {
    expect(c.search('a', -1)).toEqual([]);
    expect(c.search('a', 0)).toEqual([]);
    const items = Array.from({ length: 300 }, (_, n) => it(n, `${n % 7 === 0 ? 'x' : ''}Film ${(n * 37) % 300} a`));
    const big = new VodCatalog('movie', { items, categories: [] });
    const all = big.search('film', 1000);
    expect(all).toHaveLength(300);
    expect(big.search('film', 25).map((r) => r.id)).toEqual(all.slice(0, 25).map((r) => r.id));
  });

  test('categories() returns a copy', () => {
    const cats = c.categories();
    cats.pop();
    expect(c.categories()).toHaveLength(2);
  });

  test('no added dates', () => {
    expect(new VodCatalog('movie', { items: [it(1, 'A')], categories: [] }).hasAddedDates).toBe(false);
  });

  test('category slices keep list order within equal keys and do not leak other categories', () => {
    const items: VodItem[] = [
      it(1, 'Same', { categoryId: 'a' }), it(2, 'Same', { categoryId: 'b' }), it(3, 'Same', { categoryId: 'a' }),
    ];
    const cat = new VodCatalog('movie', { items, categories: [] });
    expect(cat.slice('a', 'title', 0, 10).rows.map((r) => r.id)).toEqual(['s:m1', 's:m3']);
    expect(cat.slice('b', 'added', 0, 10).rows.map((r) => r.id)).toEqual(['s:m2']);
    expect(cat.slice('c', 'title', 0, 10)).toEqual({ total: 0, rows: [] });
  });
});
