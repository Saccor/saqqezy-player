import { describe, expect, test } from 'vitest';
import { VOD_ALL } from '@iptv/core';
import { catalogueCategories, categoryRows, pickedSort, sortRows } from './categoryPicker.ts';

const cats = [
  { id: 'continue', name: 'Continue watching', count: 3 },
  { id: VOD_ALL, name: 'All movies', count: 1200 },
  { id: 'c1', name: 'Action', count: 1234 },
  { id: 'c2', name: 'Empty', count: 0 },
];

describe('categoryPicker', () => {
  test('catalogue categories start at All and skip empty ones', () => {
    expect(catalogueCategories(cats).map((c) => c.id)).toEqual([VOD_ALL, 'c1']);
    expect(catalogueCategories([{ id: VOD_ALL, name: 'All', count: 0 }])).toEqual([]);
  });
  test('rows carry the count and check the current one', () => {
    expect(categoryRows(catalogueCategories(cats), 'c1')).toEqual([
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
