import { describe, expect, it } from 'vitest';
import type { FoldEntry, FoldView } from '../../components/foldPickerLogic.ts';
import { GROUP_SEARCH_ROW_ID, groupMatches, isGroupSearchRow, withGroupSearch } from './groupSearch.ts';

const entries: FoldEntry[] = [
  { id: 'g1', name: 'All channels', count: 900 },
  { id: 'g2', name: 'SE | Sport', count: 40 },
  { id: 'g3', name: 'Nyheter Sverige', count: 12 },
  { id: 'g4', name: 'DE | Sport HD', count: 30, fold: 'de' },
  { id: 'g5', name: 'Café Musik', count: 5, fold: 'de' },
];
const label = (e: FoldEntry) => `${e.name} · ${e.count}`;
const view: FoldView = {
  title: 'Groups', key: 'top', initial: 1,
  rows: [
    { kind: 'list', id: 'g1', label: 'All channels · 900', checked: false },
    { kind: 'list', id: 'g2', label: 'SE | Sport · 40', checked: true },
  ],
};

describe('groupMatches', () => {
  it('every word of the query, any case and accents, across folded countries too', () => {
    expect(groupMatches(entries, 'sport').map((e) => e.id)).toEqual(['g2', 'g4']);
    expect(groupMatches(entries, 'SPORT hd').map((e) => e.id)).toEqual(['g4']);
    expect(groupMatches(entries, 'cafe').map((e) => e.id)).toEqual(['g5']);
    expect(groupMatches(entries, '  ')).toEqual([]);
  });
});

describe('withGroupSearch', () => {
  it('no query: the search row on top of the level, the focus kept on the same row', () => {
    const v = withGroupSearch(view, entries, '', { label, currentId: 'g2' });
    expect(v.rows[0]).toMatchObject({ kind: 'list', id: GROUP_SEARCH_ROW_ID, label: 'Search folders' });
    expect(v.rows.slice(1)).toEqual(view.rows);
    expect(v.initial).toBe(2);
    expect(v.key).toBe('top');
  });

  it('a query: the search row with the count, then the matching folders, the first one focused', () => {
    const v = withGroupSearch(view, entries, 'sport', { label, currentId: 'g2' });
    expect(v.rows[0]).toMatchObject({ id: GROUP_SEARCH_ROW_ID, label: '"sport" · 2 found' });
    expect(v.rows.slice(1)).toEqual([
      { kind: 'list', id: 'g2', label: 'SE | Sport · 40', checked: true },
      { kind: 'list', id: 'g4', label: 'DE | Sport HD · 30', checked: false },
    ]);
    expect(v.initial).toBe(1);
    expect(v.key).toBe('search:sport');
  });

  it('nothing matches: a note under the search row, which keeps the focus', () => {
    const v = withGroupSearch(view, entries, 'xyz', { label });
    expect(v.rows).toEqual([
      { kind: 'list', id: GROUP_SEARCH_ROW_ID, label: '"xyz" · 0 found', checked: false },
      { kind: 'heading', label: 'No folders match' },
    ]);
    expect(v.initial).toBe(0);
  });

  it('isGroupSearchRow knows the row', () => {
    expect(isGroupSearchRow({ kind: 'list', id: GROUP_SEARCH_ROW_ID, label: '', checked: false })).toBe(true);
    expect(isGroupSearchRow(view.rows[0]!)).toBe(false);
  });
});
