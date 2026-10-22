import { describe, expect, test } from 'vitest';
import { packRows, unpackRows } from '../src/packedRows.ts';

const roundTrip = (rows: object[]) => unpackRows(JSON.parse(JSON.stringify(packRows(rows))));

describe('packRows / unpackRows', () => {
  test('channels round-trip, with a missing key staying missing', () => {
    const rows = [
      { id: 's1:1', sourceId: 's1', name: 'Channel 1', url: 'http://example.test/live/u/p/1.ts', group: 'News', number: 1, logo: 'http://img.example.test/logos/1.png' },
      { id: 's1:2', sourceId: 's1', name: 'Channel 2', url: 'http://example.test/live/u/p/2.ts', group: 'News', number: 2 },
    ];
    const back = roundTrip(rows);
    expect(back).toEqual(rows);
    expect('logo' in back[1]!).toBe(false);
  });

  test('VOD items round-trip; kind and sourceId-like constants are stored once', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: `s1:m${i}`, kind: 'movie', title: `Synthetic Film ${i}`, categoryId: String(i % 3), xid: i,
      poster: `https://img.example.test/p/w600/${i}.jpg`, year: 2000 + (i % 20), rating: i % 10, added: 1_700_000_000 + i, ext: 'mkv',
    }));
    const packed = packRows(rows);
    const kindCol = packed.cols[packed.keys.indexOf('kind')]!;
    expect(kindCol).toEqual({ k: 'const', value: 'movie' });
    const posterCol = packed.cols[packed.keys.indexOf('poster')]!;
    expect(posterCol.k).toBe('prefix');
    expect(roundTrip(rows)).toEqual(rows);
  });

  test('objects become one shared object per distinct value', () => {
    const cu = { mode: 'xc', days: 3 };
    const rows = [{ id: 'a', cu }, { id: 'b', cu: { mode: 'xc', days: 3 } }, { id: 'c', cu: { mode: 'default', days: 1 } }, { id: 'd' }];
    const back = roundTrip(rows);
    expect(back).toEqual(rows);
    expect(back[0]!.cu).toBe(back[1]!.cu);
    expect('cu' in back[3]!).toBe(false);
  });

  test('mixed primitives, null, booleans and arrays survive', () => {
    const rows = [
      { a: 1, b: null, c: true, d: [1, 'x'], e: 'x' },
      { a: 'one', b: 2, c: false, d: [], e: 'y:z' },
      { a: 0, c: true },
    ];
    expect(roundTrip(rows)).toEqual(rows);
  });

  test('undefined properties are dropped, as IndexedDB and JSON drop them', () => {
    const back = roundTrip([{ a: 1, b: undefined }]);
    expect(back).toEqual([{ a: 1 }]);
    expect('b' in back[0]!).toBe(false);
  });

  test('no rows', () => {
    expect(roundTrip([])).toEqual([]);
  });

  test('many distinct prefixes fall back to raw strings', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ u: `http://h${i}.example.test/${i}/x` }));
    const packed = packRows(rows);
    expect(packed.cols[0]!.k).toBe('raw');
    expect(roundTrip(rows)).toEqual(rows);
  });

  test('a shared URL prefix makes the packed JSON clearly smaller', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      id: `src1234567:m${i}`, kind: 'movie', poster: `https://img.example.test/t/p/w600_and_h900_bestv2/${i}abcdef.jpg`, title: `T${i}`,
    }));
    const plain = JSON.stringify(rows).length;
    const packed = JSON.stringify(packRows(rows)).length;
    expect(packed).toBeLessThan(plain * 0.5);
  });

  test('holes inside a prefix column round-trip and keep the prefix kind', () => {
    const rows = Array.from({ length: 20 }, (_, i) => (i % 4 === 1 ? { u: undefined, n: i } : { u: `http://a.example.test/${i % 2}/x${i}`, n: i }));
    const packed = packRows(rows);
    expect(packed.cols[packed.keys.indexOf('u')]!.k).toBe('prefix');
    expect(packed.cols[packed.keys.indexOf('u')]!.holes?.length).toBeGreaterThan(0);
    expect(roundTrip(rows)).toEqual(rows);
  });

  test('holes inside a raw column round-trip and keep the raw kind', () => {
    const rows = Array.from({ length: 40 }, (_, i) => (i % 5 === 2 ? { u: undefined } : { u: `http://h${i}.example.test/${i}/x` }));
    const packed = packRows(rows);
    expect(packed.cols[0]!.k).toBe('raw');
    expect(packed.cols[0]!.holes?.length).toBeGreaterThan(0);
    expect(roundTrip(rows)).toEqual(rows);
  });

  test('exactly limit distinct prefixes stays prefix; limit + 1 becomes raw (n = 40, limit = 16)', () => {
    const atLimit = Array.from({ length: 40 }, (_, i) => ({ u: `p${i % 16}/x${i}` }));
    const overLimit = Array.from({ length: 40 }, (_, i) => ({ u: `p${i % 17}/x${i}` }));
    expect(packRows(atLimit).cols[0]!.k).toBe('prefix');
    expect(roundTrip(atLimit)).toEqual(atLimit);
    expect(packRows(overLimit).cols[0]!.k).toBe('raw');
    expect(roundTrip(overLimit)).toEqual(overLimit);
  });

  test('an empty-string value round-trips', () => {
    const rows = [{ s: '' }, { s: 'a/b' }, { s: '' }, { s: 'c:d' }];
    expect(roundTrip(rows)).toEqual(rows);
    const onlyEmpty = [{ s: '' }, { s: '' }];
    expect(roundTrip(onlyEmpty)).toEqual(onlyEmpty);
  });

  test('a column that is null in every row round-trips', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i, n: null }));
    const packed = packRows(rows);
    expect(packed.cols[packed.keys.indexOf('n')]).toEqual({ k: 'const', value: null });
    expect(roundTrip(rows)).toEqual(rows);
  });

  test('a row with an own __proto__ key holding an object round-trips as an own key', () => {
    const rows = [JSON.parse('{"__proto__": {"x": 1}, "a": 1}') as Record<string, unknown>];
    const back = roundTrip(rows)[0]!;
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(back, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(back, '__proto__')?.value).toEqual({ x: 1 });
    expect(back.a).toBe(1);
  });
});
