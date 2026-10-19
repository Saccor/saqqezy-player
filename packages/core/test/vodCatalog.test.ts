import { describe, expect, test } from 'vitest';
import { searchKey } from '../src/text/searchKey.ts';
import { VodCatalog } from '../src/vod/catalog.ts';
import { groupVod } from '../src/vod/grouping.ts';
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
    const names = ['Film', 'film', 'FILM', 'Fílm', 'Film A', 'Zed Film', 'Xfilm', 'Élan Film', 'Elan Film', 'Other'];
    const items = Array.from({ length: 120 }, (_, n) => it(n, names[(n * 7) % names.length]!));
    const big = new VodCatalog('movie', { items, categories: [] });
    // Independent reference: every hit, the documented comparator (position, title key, list index), one full sort.
    const reference = (q: string) => {
      const hits = items.flatMap((x, i) => {
        const key = searchKey(x.title);
        const pos = key.indexOf(searchKey(q));
        return pos >= 0 ? [{ i, pos, key }] : [];
      });
      return [...hits].sort((a, b) => a.pos - b.pos || (a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i));
    };
    for (const q of ['film', 'FILM', 'lm', 'e']) {
      const ref = reference(q);
      expect(ref.length).toBeGreaterThan(30);
      for (const k of [1, 2, 3, 7, 11, 12, 13, 29, ref.length, ref.length + 5]) {
        expect(big.search(q, k).map((r) => r.id)).toEqual(ref.slice(0, k).map((h) => items[h.i]!.id));
      }
    }
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

describe('VodCatalog grouped', () => {
  const gl: VodList = {
    items: [
      it(1, 'EN - Synthetic Film (2021) HD', { added: 100, rating: 6, categoryId: 'a' }),
      it(2, 'SE - Synthetic Film (2021) 4K', { added: 400, rating: 8, categoryId: 'b', poster: 'p2.jpg' }),
      it(3, 'Example Story (2020)', { added: 200, categoryId: 'a' }),
      it(4, 'EN - Other Tale (2019)', { added: 300, categoryId: 'c' }),
    ],
    categories: [
      { id: 'a', kind: 'movie', name: 'EN | Action', count: 2 },
      { id: 'b', kind: 'movie', name: 'SE | Action', count: 1 },
      { id: 'c', kind: 'movie', name: 'Drama', count: 1 },
    ],
  };
  const g = new VodCatalog('movie', gl).withGroups(groupVod(gl));

  test('one row per title, with the lead id, display title, newest added and best rating', () => {
    expect(g.grouped).toBe(true);
    expect(g.size).toBe(3);
    const rows = g.slice(VOD_ALL, 'added', 0, 10).rows;
    expect(rows.map((r) => [r.id, r.title, r.added, r.rating])).toEqual([
      ['s:m2', 'Synthetic Film', 400, 8], ['s:m4', 'Other Tale', 300, undefined], ['s:m3', 'Example Story', 200, undefined],
    ]);
    expect(rows[0]!.poster).toBe('p2.jpg');
  });

  test('merged categories; a group is in each of its categories', () => {
    expect(g.categories()).toEqual([
      { id: 'c:action', kind: 'movie', name: 'Action', count: 2 },
      { id: 'c:drama', kind: 'movie', name: 'Drama', count: 1 },
    ]);
    expect(titles(g.slice('c:action', 'title', 0, 10).rows)).toEqual(['Example Story', 'Synthetic Film']);
    expect(g.slice('a', 'title', 0, 10).total).toBe(0);
  });

  test('byId finds every version; groupOf and rowOf resolve any member', () => {
    expect(g.byId('s:m1')?.title).toBe('EN - Synthetic Film (2021) HD');
    expect(g.rowOf('s:m1')?.id).toBe('s:m2');
    expect(g.groupOf('s:m1')?.key).toBe('y:synthetic film|2021');
    expect(g.members('s:m2').map((m) => [m.item.id, m.lang, m.quality])).toEqual([['s:m1', 'en', 2], ['s:m2', 'sv', 0]]);
    expect(g.groupOf('missing')).toBeUndefined();
  });

  test('search finds a title once', () => {
    expect(g.search('synthetic', 10).map((r) => r.id)).toEqual(['s:m2']);
    expect(g.searchIndex().size).toBe(3);
  });

  test('withGroups(undefined) is the plain catalogue', () => {
    const plain = g.withGroups(undefined);
    expect(plain.grouped).toBe(false);
    expect(plain.size).toBe(4);
    expect(plain.rowOf('s:m1')?.id).toBe('s:m1');
    expect(plain.members('s:m1').map((m) => m.item.id)).toEqual(['s:m1']);
  });
});
