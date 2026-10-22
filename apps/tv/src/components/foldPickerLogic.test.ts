import { describe, expect, it } from 'vitest';
import type { PickerRow } from '../screens/homeMenuLogic.ts';
import {
  CHOOSE_ROW_ID, FOLD_ROW_ID, TOP_LEVEL, foldPick, foldView, initialRow, levelRowId, levelUp, effectiveLevel, openLevel, type FoldEntry,
} from './foldPickerLogic.ts';

const g = (id: string, count: number, fold?: string): FoldEntry => ({ id, name: id.replace(/^g:/, ''), count, ...(fold ? { fold } : {}) });
/** What `groups()` returns: lists, yours, All, other countries (folded, country order), the rest. */
const ENTRIES: FoldEntry[] = [
  g('fav', 3), g('g:SE | News', 10), g('all', 120),
  g('g:BE | News', 8, 'BE'), g('g:BE | Kids', 4, 'BE'), g('g:DK | Kids', 6, 'DK'), g('g:EN | Films', 2, 'lang:en'),
  g('g:Music', 5),
];
const opts = { title: 'Groups', picked: true, label: (e: FoldEntry) => `${e.name} · ${e.count}`, flagOf: (k: string) => (k === 'BE' ? 'be.png' : undefined) };

describe('top level', () => {
  it('lists, yours, All, one fold row, then "Other folders" and the rest', () => {
    expect(foldView(ENTRIES, TOP_LEVEL, { ...opts, currentId: 'g:SE | News' })).toEqual({
      title: 'Groups', key: 'top', initial: 1,
      rows: [
        { kind: 'list', id: 'fav', label: 'fav · 3', checked: false },
        { kind: 'list', id: 'g:SE | News', label: 'SE | News · 10', checked: true },
        { kind: 'list', id: 'all', label: 'all · 120', checked: false },
        { kind: 'list', id: FOLD_ROW_ID, label: 'Other countries (3)', checked: false, more: true },
        { kind: 'heading', label: 'Other folders' },
        { kind: 'list', id: 'g:Music', label: 'Music · 5', checked: false },
      ],
    });
  });
  it('"Countries (n)" without picks; no heading without rest folders; the fold row is checked for a folded group; the only-mode line', () => {
    const rows = foldView(ENTRIES, TOP_LEVEL, { ...opts, picked: false, currentId: 'g:BE | Kids' }).rows;
    expect(rows[3]).toEqual({ kind: 'list', id: FOLD_ROW_ID, label: 'Countries (3)', checked: true, more: true });
    expect(foldView(ENTRIES.slice(0, 7), TOP_LEVEL, opts).rows.some((r) => r.kind === 'heading')).toBe(false);
    const only = foldView([g('fav', 3), g('g:SE | News', 10), g('all', 10)], TOP_LEVEL, { ...opts, onlyCount: 2 }).rows;
    expect(only.at(-1)).toEqual({ kind: 'list', id: CHOOSE_ROW_ID, label: 'Showing 2 countries · Change', checked: false });
    expect(foldView([g('all', 10)], TOP_LEVEL, opts).rows).toEqual([{ kind: 'list', id: 'all', label: 'all · 10', checked: false }]);
  });
});

describe('country list and a country\'s folders', () => {
  it('flag (or text badge), name and folder count per country, most folders first; "Choose your countries…" last', () => {
    const v = foldView(ENTRIES, { kind: 'countries' }, { ...opts, currentId: 'g:DK | Kids' });
    expect(v.title).toBe('Other countries');
    expect(v.key).toBe('countries');
    expect(v.rows).toEqual([
      { kind: 'list', id: 'fold:country:BE', label: 'Belgium · 2 folders', checked: false, icon: { src: 'be.png' }, more: true },
      { kind: 'list', id: 'fold:country:DK', label: 'Denmark · 1 folder', checked: true, icon: { badge: 'DK' }, more: true },
      { kind: 'list', id: 'fold:country:lang:en', label: 'English · 1 folder', checked: false, icon: { badge: 'EN' }, more: true },
      { kind: 'list', id: CHOOSE_ROW_ID, label: 'Choose your countries…', checked: false },
    ]);
    expect(v.initial).toBe(1);
    expect(foldView(ENTRIES, { kind: 'countries' }, { ...opts, picked: false }).title).toBe('Countries');
  });
  it('a country\'s folders in provider order, titled by its name', () => {
    const v = foldView(ENTRIES, { kind: 'country', key: 'BE' }, { ...opts, currentId: 'g:BE | Kids' });
    expect(v).toEqual({
      title: 'Belgium', key: 'country:BE', initial: 1,
      rows: [
        { kind: 'list', id: 'g:BE | News', label: 'BE | News · 8', checked: false },
        { kind: 'list', id: 'g:BE | Kids', label: 'BE | Kids · 4', checked: true },
      ],
    });
  });
});

describe('navigation', () => {
  it('opens at the open group\'s fold path; Back goes up one level and focuses the row it came from', () => {
    expect(openLevel(ENTRIES, 'g:BE | Kids')).toEqual({ kind: 'country', key: 'BE' });
    expect(openLevel(ENTRIES, 'all')).toEqual(TOP_LEVEL);
    expect(openLevel(ENTRIES, undefined)).toEqual(TOP_LEVEL);
    expect(levelUp({ kind: 'country', key: 'BE' })).toEqual({ kind: 'countries' });
    expect(levelUp({ kind: 'countries' })).toEqual(TOP_LEVEL);
    expect(levelUp(TOP_LEVEL)).toBeUndefined();
    expect(levelRowId({ kind: 'country', key: 'BE' })).toBe('fold:country:BE');
    expect(levelRowId({ kind: 'countries' })).toBe(FOLD_ROW_ID);
    expect(levelRowId(TOP_LEVEL)).toBeUndefined();
    expect(foldView(ENTRIES, { kind: 'countries' }, { ...opts, focusId: 'fold:country:lang:en' }).initial).toBe(2);
    expect(foldView(ENTRIES, TOP_LEVEL, { ...opts, focusId: FOLD_ROW_ID }).initial).toBe(3);
  });
  it('OK: the fold row opens the countries, a country its folders, a folder opens; "Choose…" goes to Settings', () => {
    const row = (id: string): PickerRow => ({ kind: 'list', id, label: id, checked: false });
    expect(foldPick(TOP_LEVEL, row(FOLD_ROW_ID))).toEqual({ kind: 'level', level: { kind: 'countries' } });
    expect(foldPick({ kind: 'countries' }, row('fold:country:lang:en'))).toEqual({ kind: 'level', level: { kind: 'country', key: 'lang:en' } });
    expect(foldPick({ kind: 'countries' }, row(CHOOSE_ROW_ID))).toEqual({ kind: 'choose' });
    expect(foldPick({ kind: 'country', key: 'BE' }, row('g:BE | News'))).toEqual({ kind: 'open', id: 'g:BE | News' });
    expect(foldPick(TOP_LEVEL, { kind: 'heading', label: 'Other folders' })).toEqual({ kind: 'none' });
    expect(initialRow([{ kind: 'heading', label: 'x' }, row('a')])).toBe(1);
  });
});

describe('effectiveLevel', () => {
  it('keeps a level that still exists', () => {
    expect(effectiveLevel(TOP_LEVEL, ENTRIES)).toEqual(TOP_LEVEL);
    expect(effectiveLevel({ kind: 'country', key: 'BE' }, ENTRIES)).toEqual({ kind: 'country', key: 'BE' });
    expect(effectiveLevel({ kind: 'countries' }, ENTRIES)).toEqual({ kind: 'countries' });
  });
  it('a country that vanished falls back to the country list, or to the top when nothing is folded', () => {
    expect(effectiveLevel({ kind: 'country', key: 'NO' }, ENTRIES)).toEqual({ kind: 'countries' });
    const flat = [g('fav', 3), g('g:Music', 5)];
    expect(effectiveLevel({ kind: 'country', key: 'BE' }, flat)).toEqual(TOP_LEVEL);
    expect(effectiveLevel({ kind: 'countries' }, flat)).toEqual(TOP_LEVEL);
  });
});
