import { describe, expect, test } from 'vitest';
import { VOD_ALL } from '@iptv/core';
import { catalogueCategories, categoryRows, pickedSort, sortRows } from './categoryPicker.ts';

const cats = [
  { id: 'vod:continue', name: 'Continue watching', count: 3 },
  { id: 'c0', name: 'SE | Action', count: 5 },
  { id: 'vod:recent', name: 'Recently added', count: 200 },
  { id: VOD_ALL, name: 'All movies', count: 1200 },
  { id: 'c3', name: 'BE | Action', count: 4, fold: 'BE' },
  { id: 'c1', name: 'Action', count: 1234 },
  { id: 'c2', name: 'Empty', count: 0 },
];

describe('categoryPicker', () => {
  test('catalogue categories: yours, All, folded countries and the rest, without the browse rows and empty ones', () => {
    expect(catalogueCategories(cats).map((c) => c.id)).toEqual(['c0', VOD_ALL, 'c3', 'c1']);
    expect(catalogueCategories(cats)[2]).toMatchObject({ fold: 'BE' });
    expect(catalogueCategories([{ id: VOD_ALL, name: 'All', count: 0 }])).toEqual([]);
    expect(catalogueCategories([{ id: 'c1', name: 'Action', count: 3 }])).toEqual([]);
  });
  test('rows carry the count and check the current one', () => {
    expect(categoryRows([cats[3]!, cats[5]!], 'c1')).toEqual([
      { kind: 'list', id: VOD_ALL, label: 'All movies · 1,200', checked: false },
      { kind: 'list', id: 'c1', label: 'Action · 1,234', checked: true },
    ]);
  });
  test('sort rows round-trip', () => {
    const rows = sortRows(['added', 'title'], 'title');
    expect(rows).toEqual([
      { kind: 'list', id: 'sort:added', label: 'Sort: Recently added', checked: false },
      { kind: 'list', id: 'sort:title', label: 'Sort: A–Z', checked: true },
    ]);
    expect(pickedSort(rows[0]!)).toBe('added');
    expect(pickedSort({ kind: 'list', id: 'c1', label: 'Action', checked: false })).toBeUndefined();
  });
});
