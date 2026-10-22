import { countryLabel, foldSummary } from '@iptv/core';
import { COUNTRIES_COPY } from '../copy.ts';
import type { PickerRow } from '../screens/homeMenuLogic.ts';
import { chipArt } from './countryGridLogic.ts';

/**
 * The folder pickers of Live TV and Movies/Series with other countries folded (spec 2026-10-22-your-countries-flags):
 * a top level with one "Other countries (n) ›" row, the country list, and one country's folders. Pure: built from the
 * entries `groups()` / `categories()` returned (their `fold`), with no second worker call. Unit-tested.
 */

/** A Live TV group or a VOD category entry. */
export interface FoldEntry { id: string; name: string; count: number; fold?: string }
export type FoldLevel = { kind: 'top' } | { kind: 'countries' } | { kind: 'country'; key: string };
export const TOP_LEVEL: FoldLevel = { kind: 'top' };
/** Row ids that are not folders (`g:` groups and provider category ids never start with `fold:`). */
export const FOLD_ROW_ID = 'fold:countries';
export const CHOOSE_ROW_ID = 'fold:choose';
const COUNTRY_PREFIX = 'fold:country:';

export interface FoldViewOptions {
  /** The top level's title ("Groups", "Movie categories"). */
  title: string;
  /** Countries are picked (mode not off): "Other countries" rather than "Countries". */
  picked: boolean;
  /** The open folder: checked, and focused when nothing else is. */
  currentId?: string;
  /** The row to focus (Back from a level focuses the row that opened it). */
  focusId?: string;
  label: (e: FoldEntry) => string;
  flagOf: (key: string) => string | undefined;
  /** "Show only these" with this many countries: the "Showing n countries · Change" row; 0 or absent: none. */
  onlyCount?: number;
}

export interface FoldView { title: string; rows: PickerRow[]; initial: number; key: string }

const levelKey = (l: FoldLevel): string => (l.kind === 'country' ? `country:${l.key}` : l.kind);

/** The picker opens where the open folder is: its country's list when it is folded, else the top level. */
export function openLevel(entries: readonly FoldEntry[], currentId: string | undefined): FoldLevel {
  const fold = entries.find((e) => e.id === currentId)?.fold;
  return fold !== undefined ? { kind: 'country', key: fold } : TOP_LEVEL;
}

/** Back: a country's folders → the country list → the top level → closed (undefined). */
export function levelUp(l: FoldLevel): FoldLevel | undefined {
  if (l.kind === 'country') return { kind: 'countries' };
  if (l.kind === 'countries') return TOP_LEVEL;
  return undefined;
}

/** The row of the level above that opened `l` (focused again after Back). */
export function levelRowId(l: FoldLevel): string | undefined {
  if (l.kind === 'country') return COUNTRY_PREFIX + l.key;
  if (l.kind === 'countries') return FOLD_ROW_ID;
  return undefined;
}

function topRows(entries: readonly FoldEntry[], o: FoldViewOptions): PickerRow[] {
  const rows: PickerRow[] = [];
  const keys = new Set<string>();
  for (const e of entries) if (e.fold !== undefined) keys.add(e.fold);
  let folded = false;
  entries.forEach((e, i) => {
    if (e.fold === undefined) {
      rows.push({ kind: 'list', id: e.id, label: o.label(e), checked: e.id === o.currentId });
      return;
    }
    if (folded) return;
    folded = true;
    const checked = entries.some((x) => x.fold !== undefined && x.id === o.currentId);
    const label = o.picked ? COUNTRIES_COPY.otherCountries(keys.size) : COUNTRIES_COPY.countries(keys.size);
    rows.push({ kind: 'list', id: FOLD_ROW_ID, label, checked, more: true });
    if (entries.slice(i + 1).some((x) => x.fold === undefined)) rows.push({ kind: 'heading', label: COUNTRIES_COPY.otherHeading });
  });
  if (o.onlyCount) rows.push({ kind: 'list', id: CHOOSE_ROW_ID, label: COUNTRIES_COPY.showing(o.onlyCount), checked: false });
  return rows;
}

function countryRows(entries: readonly FoldEntry[], o: FoldViewOptions): PickerRow[] {
  const current = entries.find((e) => e.id === o.currentId)?.fold;
  const rows: PickerRow[] = foldSummary(entries).map((c) => ({
    kind: 'list', id: COUNTRY_PREFIX + c.key, label: `${c.label} · ${COUNTRIES_COPY.folders(c.folders)}`, checked: c.key === current,
    icon: chipArt(c.key, o.flagOf), more: true,
  }));
  rows.push({ kind: 'list', id: CHOOSE_ROW_ID, label: COUNTRIES_COPY.choose, checked: false });
  return rows;
}

function folderRows(entries: readonly FoldEntry[], key: string, o: FoldViewOptions): PickerRow[] {
  return entries.filter((e) => e.fold === key).map((e) => ({ kind: 'list', id: e.id, label: o.label(e), checked: e.id === o.currentId }));
}

/** The focus row: `focusId`, else the checked row, else the first selectable one. */
export function initialRow(rows: readonly PickerRow[], focusId?: string): number {
  let i = focusId !== undefined ? rows.findIndex((r) => r.kind === 'list' && r.id === focusId) : -1;
  if (i < 0) i = rows.findIndex((r) => r.kind === 'list' && r.checked);
  if (i < 0) i = rows.findIndex((r) => r.kind !== 'heading');
  return Math.max(0, i);
}

/** One level of the picker: title, rows, the row to focus, and a key that changes with the level. */
export function foldView(entries: readonly FoldEntry[], level: FoldLevel, o: FoldViewOptions): FoldView {
  const rows = level.kind === 'top' ? topRows(entries, o)
    : level.kind === 'countries' ? countryRows(entries, o)
      : folderRows(entries, level.key, o);
  const title = level.kind === 'top' ? o.title
    : level.kind === 'countries' ? (o.picked ? COUNTRIES_COPY.otherCountriesTitle : COUNTRIES_COPY.countriesTitle)
      : countryLabel(level.key);
  return { title, rows, initial: initialRow(rows, o.focusId), key: levelKey(level) };
}

export type FoldAction = { kind: 'level'; level: FoldLevel } | { kind: 'choose' } | { kind: 'open'; id: string } | { kind: 'none' };

/** OK on a row at `level`. */
export function foldPick(_level: FoldLevel, row: PickerRow): FoldAction {
  if (row.kind !== 'list') return { kind: 'none' };
  if (row.id === FOLD_ROW_ID) return { kind: 'level', level: { kind: 'countries' } };
  if (row.id === CHOOSE_ROW_ID) return { kind: 'choose' };
  if (row.id.startsWith(COUNTRY_PREFIX)) return { kind: 'level', level: { kind: 'country', key: row.id.slice(COUNTRY_PREFIX.length) } };
  return { kind: 'open', id: row.id };
}
