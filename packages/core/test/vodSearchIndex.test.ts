import { describe, expect, test } from 'vitest';
import { VodCatalog } from '../src/vod/catalog.ts';
import { buildVodSearchIndex, searchVodIndex, vodIndexEntry, vodSearchIndexBytes } from '../src/vod/searchIndex.ts';
import type { VodItem, VodList } from '../src/vod/types.ts';

const it = (n: number, title: string, extra: Partial<VodItem> = {}): VodItem => ({ id: `src1:m${n}`, kind: 'movie', title, categoryId: '1', ...extra });
const items: VodItem[] = [
  it(1, 'Bravo', { year: 2001, poster: 'http://img.example.test/p/b.jpg' }),
  it(2, 'alpha', { categoryId: '2', poster: 'http://img.example.test/p/a.jpg' }),
  it(3, 'Élan', { year: 1999 }),
  it(4, 'Charlie: The Return', { categoryId: '3', poster: 'http://other.example.test/x/c.png' }),
];
const list: VodList = { items, categories: [] };
const ids = (ix: ReturnType<typeof buildVodSearchIndex>, q: string, cap: number) => searchVodIndex(ix, q, cap).map((i) => vodIndexEntry(ix, i).id);

describe('VodSearchIndex', () => {
  const ix = buildVodSearchIndex('movie', items);

  test('entries read back id, title, category and year; no poster (rows are text-only); a missing year stays missing', () => {
    expect(ix.size).toBe(4);
    expect(ix.kind).toBe('movie');
    expect(vodIndexEntry(ix, 0)).toEqual({ id: 'src1:m1', title: 'Bravo', categoryId: '1', year: 2001 });
    expect(vodIndexEntry(ix, 2)).toEqual({ id: 'src1:m3', title: 'Élan', categoryId: '1', year: 1999 });
    expect(vodIndexEntry(ix, 3)).toEqual({ id: 'src1:m4', title: 'Charlie: The Return', categoryId: '3' });
  });

  test('searchKey matching: accent- and case-insensitive, punctuation as spaces', () => {
    expect(ids(ix, 'ELAN', 10)).toEqual(['src1:m3']);
    expect(ids(ix, 'charlie the', 10)).toEqual(['src1:m4']);
    expect(ids(ix, '  ', 10)).toEqual([]);
    expect(ids(ix, 'zzz', 10)).toEqual([]);
  });

  test('ranking: match position (prefix first), then title key, then list order; capped', () => {
    expect(ids(ix, 'a', 10)).toEqual(['src1:m2', 'src1:m1', 'src1:m4', 'src1:m3']);
    expect(ids(ix, 'ar', 10)).toEqual(['src1:m4']);
    expect(ids(ix, 'a', 2)).toEqual(['src1:m2', 'src1:m1']);
    expect(searchVodIndex(ix, 'a', 0)).toEqual([]);
    expect(searchVodIndex(ix, 'a', -1)).toEqual([]);
  });

  test('an empty catalogue', () => {
    const empty = buildVodSearchIndex('series', []);
    expect(empty.size).toBe(0);
    expect(searchVodIndex(empty, 'a', 20)).toEqual([]);
  });

  test('ids without a shared prefix and many categories still read back exactly', () => {
    const mixed = Array.from({ length: 600 }, (_, n) => it(n, `Title ${n}`, {
      id: n % 2 ? `a:${n}` : `bb:${n}`, categoryId: `c${n}`, year: n % 5 ? 1900 + n : undefined,
    }));
    const big = buildVodSearchIndex('movie', mixed);
    for (let n = 0; n < mixed.length; n++) {
      const e = vodIndexEntry(big, n);
      expect(e.id).toBe(mixed[n]!.id);
      expect(e.categoryId).toBe(mixed[n]!.categoryId);
      expect(e.year).toBe(mixed[n]!.year);
    }
  });

  test('top-k matches VodCatalog.search on the same catalogue, for every query and cap', () => {
    const many: VodItem[] = Array.from({ length: 400 }, (_, n) => it(n, `${['Red', 'Blue', 'Green'][n % 3]} Film ${(n * 37) % 101} ${n % 2 ? 'Part' : 'Rapture'}`));
    const catalog = new VodCatalog('movie', { items: many, categories: [] });
    const big = catalog.searchIndex();
    for (const q of ['a', 'film 1', 'part', 'ap', 're', 'e', 'green film 9', 'nothing']) {
      for (const k of [1, 5, 20, 1000]) {
        expect(ids(big, q, k)).toEqual(catalog.search(q, k).map((r) => r.id));
      }
    }
  });

  test('wide titles (Cyrillic, CJK, emoji) across chunk boundaries rank exactly as VodCatalog.search', () => {
    const words = ['Зимний вечер', 'Синтетика', '夜の街', '合成映画', 'Ночь 🌙 Film', 'Film 🎬 Night', 'Été Film', 'film'];
    const many: VodItem[] = Array.from({ length: 300 }, (_, n) => it(n, `${words[n % words.length]} ${(n * 37) % 61}`));
    const catalog = new VodCatalog('movie', { items: many, categories: [] });
    for (const [chunk, min] of [[1, 1], [7, 1], [7, 3], [64, 4], [1024, 64]] as const) {
      const ix = buildVodSearchIndex('movie', many, undefined, chunk, min);
      for (let n = 0; n < many.length; n += 13) expect(vodIndexEntry(ix, n)).toMatchObject({ id: many[n]!.id, title: many[n]!.title });
      for (const q of ['film', 'ночь', 'НОЧЬ', '街', '合成', 'синт', 'ete', '1', 'night', 'зим']) {
        for (const k of [1, 5, 20, 1000]) expect(ids(ix, q, k)).toEqual(catalog.search(q, k).map((r) => r.id));
      }
    }
  });

  test('a block of wide titles gets chunks of its own (cut where the text switches, once a chunk holds the minimum)', () => {
    const items = Array.from({ length: 3000 }, (_, n) => it(n, n >= 1000 && n < 1500 ? `Синтетика ${n}` : `Synthetic ${n}`));
    const ix = buildVodSearchIndex('movie', items);
    const bounds = ix.chunks.map((c) => [c.start, c.start + c.keyAt.length - 1]);
    expect(bounds).toEqual([[0, 1000], [1000, 1500], [1500, 2524], [2524, 3000]]);
    for (const n of [0, 999, 1000, 1499, 1500, 2999]) expect(vodIndexEntry(ix, n).id).toBe(items[n]!.id);
  });

  test('a wide title widens only its own chunk', () => {
    const narrow = Array.from({ length: 4096 }, (_, n) => it(n, `Synthetic Title ${n}`));
    const oneWide = narrow.map((x, n) => (n === 5 ? { ...x, title: 'Синтетика 5' } : x));
    const base = vodSearchIndexBytes(buildVodSearchIndex('movie', narrow, undefined, 1024));
    const wide = vodSearchIndexBytes(buildVodSearchIndex('movie', oneWide, undefined, 1024));
    // One chunk of four doubles its strings (titles and keys); unchunked, every string would.
    expect(wide - base).toBeLessThan(base / 4);
    expect(wide).toBeGreaterThan(base);
  });

  test('VodCatalog.searchIndex builds from the catalogue kind; the byte estimate counts the packed data', () => {
    const fromCatalog = new VodCatalog('movie', list).searchIndex();
    expect(fromCatalog.kind).toBe('movie');
    expect(ids(fromCatalog, 'bravo', 5)).toEqual(['src1:m1']);
    expect(vodSearchIndexBytes(fromCatalog)).toBeGreaterThan(0);
    // The index builds its keys transiently: a resident catalogue does not keep a copy because of Search.
    const fresh = new VodCatalog('movie', list);
    fresh.searchIndex();
    expect((fresh as unknown as { keys?: string[] }).keys).toBeUndefined();
  });
});
