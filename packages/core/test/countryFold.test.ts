import { describe, expect, test } from 'vitest';
import { codeIndexOf, foldActive, foldSummary, pickRank, splitFold } from '../src/index/countryFold.ts';

describe('country fold helpers', () => {
  test('pickRank: the lowest index in codes of any key; Infinity when none match', () => {
    const idx = codeIndexOf(['DK', 'SE', 'DK']);
    expect([...idx]).toEqual([['DK', 0], ['SE', 1]]);
    expect(pickRank(['SE'], idx)).toBe(1);
    expect(pickRank(['SE', 'NO', 'DK'], idx)).toBe(0);
    expect(pickRank(['BE'], idx)).toBe(Infinity);
    expect(pickRank([], idx)).toBe(Infinity);
  });

  test('foldActive: on, not only, and at least two distinct keys', () => {
    expect(foldActive(true, 'off', 2)).toBe(true);
    expect(foldActive(true, 'first', 5)).toBe(true);
    expect(foldActive(true, 'only', 5)).toBe(false);
    expect(foldActive(true, 'first', 1)).toBe(false);
    expect(foldActive(false, 'first', 5)).toBe(false);
  });

  test('splitFold: under the first key, most folders first, ties by label, provider order inside; no key is rest', () => {
    const items = [
      { id: 'a', keys: ['SE'] }, { id: 'b', keys: ['BE'] }, { id: 'c', keys: [] as string[] }, { id: 'd', keys: ['SE', 'NO'] },
      { id: 'e', keys: ['lang:en'] }, { id: 'f', keys: ['DK'] }, { id: 'g', keys: ['BE'] }, { id: 'h', keys: ['BE'] },
    ];
    const s = splitFold(items, (x) => x.keys);
    expect(s.country.map((c) => `${c.item.id}@${c.key}`)).toEqual(['b@BE', 'g@BE', 'h@BE', 'a@SE', 'd@SE', 'f@DK', 'e@lang:en']);
    expect(s.rest.map((x) => x.id)).toEqual(['c']);
  });

  test('foldSummary: one entry per fold key in country order, with folder and item counts; language keys say so', () => {
    expect(foldSummary([
      { count: 3, fold: 'BE' }, { count: 9 }, { count: 2, fold: 'lang:en' }, { count: 1, fold: 'BE' }, { count: 5, fold: 'DK' },
    ])).toEqual([
      { key: 'BE', label: 'Belgium', isLanguage: false, folders: 2, items: 4 },
      { key: 'DK', label: 'Denmark', isLanguage: false, folders: 1, items: 5 },
      { key: 'lang:en', label: 'English', isLanguage: true, folders: 1, items: 2 },
    ]);
    expect(foldSummary([])).toEqual([]);
  });

  test('foldSummary over 2,000 entries stays under 5 ms', () => {
    const codes = ['SE', 'DK', 'BE', 'DE', 'FR', 'NL', 'PL', 'ES'];
    const entries = Array.from({ length: 2000 }, (_, i) => ({ count: 20, ...(i % 10 ? { fold: codes[i % codes.length]! } : {}) }));
    foldSummary(entries);
    const t0 = performance.now();
    const out = foldSummary(entries);
    expect(performance.now() - t0).toBeLessThan(5);
    expect(out).toHaveLength(codes.length);
  });
});
