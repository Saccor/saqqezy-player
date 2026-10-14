import { describe, expect, test } from 'vitest';
import { TitleIndexBuilder, isTitleIndexData, queryTitles } from '../src/search/titleIndex.ts';

const MIN = 60_000;
const H = 60 * MIN;
const NOW = 100 * H;

function build(rows: [title: string, key: string, startH: number, stopH: number][], max?: number) {
  const b = new TitleIndexBuilder(max);
  for (const [t, k, s, e] of rows) b.add(t, k, s * H, e * H);
  return { b, data: b.build() };
}

describe('TitleIndexBuilder + queryTitles', () => {
  test('dedupes titles by searchKey and keeps the first spelling', () => {
    const { data } = build([['Night News', 'a', 101, 102], ['night-news', 'b', 103, 104]]);
    const m = queryTitles(data, 'night news', NOW, 10);
    expect(m).toHaveLength(1);
    expect(m[0]!.display).toBe('Night News');
    expect(m[0]!.airings).toEqual([
      { epgKey: 'a', start: 101 * H, stop: 102 * H },
      { epgKey: 'b', start: 103 * H, stop: 104 * H },
    ]);
  });

  test('interleaved, repeated raw spellings of one key give one title, all airings, first spelling as display', () => {
    const { data } = build([
      ['Night News', 'a', 101, 102],
      ['night-news', 'b', 103, 104],
      ['Night News', 'a', 105, 106],
      ['night-news', 'a', 107, 108],
      ['Other Show', 'b', 101, 102],
      ['NIGHT NEWS', 'b', 109, 110],
      ['night-news', 'b', 111, 112],
    ]);
    expect(data.offsets.length).toBe(2);
    const m = queryTitles(data, 'night news', NOW, 10);
    expect(m).toHaveLength(1);
    expect(m[0]!.display).toBe('Night News');
    expect(m[0]!.airings.map((x) => [x.epgKey, x.start / H])).toEqual([
      ['a', 101], ['b', 103], ['a', 105], ['a', 107], ['b', 109], ['b', 111],
    ]);
  });

  test('ranks: title prefix (0) before word start (1) before substring (2)', () => {
    const { data } = build([['Bakery Hour', 'a', 101, 102], ['The Bake Off', 'a', 101, 102], ['Kebab Corner', 'a', 101, 102]]);
    const m = queryTitles(data, 'bak', NOW, 10);
    expect(m.map((x) => [x.display, x.rank])).toEqual([['Bakery Hour', 0], ['The Bake Off', 1]]);
    expect(queryTitles(data, 'bab', NOW, 10).map((x) => [x.display, x.rank])).toEqual([['Kebab Corner', 2]]);
  });

  test('a title is reported once, at its best rank', () => {
    const { data } = build([['Xnews News', 'a', 101, 102]]);
    expect(queryTitles(data, 'news', NOW, 10).map((x) => x.rank)).toEqual([1]);
  });

  test('ended airings are dropped; a title with none left is skipped', () => {
    const { data } = build([['Old Show', 'a', 90, 91], ['Old Show', 'a', 99, 101], ['Older Show', 'a', 80, 81]]);
    const m = queryTitles(data, 'old', NOW, 10);
    expect(m.map((x) => x.display)).toEqual(['Old Show']);
    expect(m[0]!.airings).toEqual([{ epgKey: 'a', start: 99 * H, stop: 101 * H }]);
  });

  test('airings sorted by start within a title; same rank sorted by earliest airing', () => {
    const { data } = build([['Show B', 'k', 110, 111], ['Show A', 'k', 105, 106], ['Show B', 'k', 102, 103]]);
    const m = queryTitles(data, 'show', NOW, 10);
    expect(m.map((x) => x.display)).toEqual(['Show B', 'Show A']);
    expect(m[0]!.airings.map((a) => a.start)).toEqual([102 * H, 110 * H]);
  });

  test('limit caps titles; empty or punctuation-only query returns nothing', () => {
    const { data } = build(Array.from({ length: 30 }, (_, i) => [`Title ${i}`, 'k', 101, 102] as [string, string, number, number]));
    expect(queryTitles(data, 'title', NOW, 5)).toHaveLength(5);
    expect(queryTitles(data, '  ', NOW, 5)).toEqual([]);
    expect(queryTitles(data, '--', NOW, 5)).toEqual([]);
  });

  test('airing cap: titles still indexed, extra airings dropped, truncated set', () => {
    const { b, data } = build([['One', 'k', 101, 102], ['Two', 'k', 101, 102], ['Two', 'k', 103, 104]], 2);
    expect(b.truncated).toBe(true);
    expect(queryTitles(data, 'two', NOW, 10)[0]!.airings).toHaveLength(1);
  });

  test('survives structuredClone and passes the shape check', () => {
    const { data } = build([['Clone Me', 'k', 101, 102]]);
    const copy = structuredClone(data);
    expect(isTitleIndexData(copy)).toBe(true);
    expect(queryTitles(copy, 'clone', NOW, 10)[0]!.display).toBe('Clone Me');
  });

  test('shape check rejects wrong version, types or lengths', () => {
    const { data } = build([['Shape', 'k', 101, 102]]);
    expect(isTitleIndexData(null)).toBe(false);
    expect(isTitleIndexData({ ...data, v: 2 })).toBe(false);
    expect(isTitleIndexData({ ...data, offsets: [0] })).toBe(false);
    expect(isTitleIndexData({ ...data, display: [] })).toBe(false);
    expect(isTitleIndexData({ ...data, airKey: new Uint32Array(0) })).toBe(false);
  });

  test('empty builder builds a valid empty index', () => {
    const data = new TitleIndexBuilder().build();
    expect(isTitleIndexData(data)).toBe(true);
    expect(queryTitles(data, 'x', NOW, 10)).toEqual([]);
  });

  test('a title first seen after the airing cap has no airings and is absent', () => {
    const { b, data } = build([['One', 'k', 101, 102], ['Two', 'k', 101, 102], ['Three', 'k', 101, 102]], 2);
    expect(b.truncated).toBe(true);
    expect(queryTitles(data, 'three', NOW, 10)).toEqual([]);
    expect(queryTitles(data, 'one', NOW, 10)).toHaveLength(1);
  });

  test('a later-starting airing that has ended does not hide an earlier, longer live one', () => {
    const { data } = build([['Long Show', 'k', 95, 110], ['Long Show', 'k', 98, 99]]);
    const m = queryTitles(data, 'long', NOW, 10);
    expect(m).toHaveLength(1);
    expect(m[0]!.airings).toEqual([{ epgKey: 'k', start: 95 * H, stop: 110 * H }]);
  });

  test('many rank-1 and rank-2 candidates: the earliest-starting ones win, in order', () => {
    const n = 500;
    const starts = Array.from({ length: n }, (_, i) => (101 * 60 + ((i * 197) % n)) * MIN); // shuffled, distinct
    const expected = [...starts].sort((a, b) => a - b).slice(0, 5);
    for (const [name, rank] of [[(i: number) => `Zed Item ${i}`, 1], [(i: number) => `Zeditem${i}`, 2]] as const) {
      const b = new TitleIndexBuilder();
      starts.forEach((s, i) => b.add(name(i), 'k', s, s + H));
      const m = queryTitles(b.build(), 'item', NOW, 5);
      expect(m.map((x) => x.rank)).toEqual([rank, rank, rank, rank, rank]);
      expect(m.map((x) => x.airings[0]!.start)).toEqual(expected);
    }
  });
});
