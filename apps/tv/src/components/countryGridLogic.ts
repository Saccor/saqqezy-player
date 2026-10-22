import type { CountryChoice, CountryChoices } from '@iptv/app-api';
import { REGIONS_MAX } from '@iptv/core';
import { COUNTRIES_COPY } from '../copy.ts';

/**
 * Your countries' flag grid (spec 2026-10-22-your-countries-flags §Country grid): rows, focus moves, picks, labels and
 * the result line. Pure: no Solid, no Lightning. The grid draws `gridRows` and moves with `moveGrid`.
 */

export type GridSort = 'most' | 'az';
/** The "A–Z" toggle exists with more choices than this. */
export const AZ_TOGGLE_AFTER = 24;
/** One chip at 1080p (spec: at least 240 × 140), and the gap between chips. */
export const CHIP = { w: 260, h: 164, gap: 24 } as const;
export interface Box { x: number; y: number; w: number; h: number }
/**
 * Where each part sits inside a chip. None overlap and all stay inside the chip with a margin for the picked border:
 * the flag centred at the top, the pick pill top right (right of the flag), the name across the middle, then the count
 * with the "This TV" badge at the right end of the same line.
 */
export const CHIP_BOXES: Record<'flag' | 'pill' | 'device' | 'name' | 'count', Box> = {
  flag: { x: 82, y: 12, w: 96, h: 72 },
  pill: { x: CHIP.w - 72, y: 8, w: 64, h: 36 },
  device: { x: CHIP.w - 112, y: 124, w: 100, h: 34 },
  name: { x: 12, y: 86, w: CHIP.w - 24, h: 38 },
  count: { x: 12, y: 124, w: CHIP.w - 24 - 112, h: 34 },
};

/** Each row's height in the grid's scroll space (a chip row: the chip plus 20 px). */
export const ROW_PITCH = { sort: 64, heading: 56, chips: CHIP.h + 20 } as const;
export const gridWidth = (columns: number): number => columns * CHIP.w + (columns - 1) * CHIP.gap;
/** 4 chips a row; 3 at text scale 125 % or more. */
export const gridColumns = (textScale = 1): 3 | 4 => (textScale >= 1.25 ? 3 : 4);

export type GridRow = { kind: 'sort'; toggle: boolean } | { kind: 'heading' } | { kind: 'chips'; keys: string[] };
export interface GridFocus { row: number; col: number }
export type GridEdge = 'up' | 'down' | 'left';
export type GridMove = { focus: GridFocus } | { edge: GridEdge };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Countries, then languages. `most` keeps the worker's order (this TV first, most folders first). */
export function orderChoices(choices: readonly CountryChoice[], sort: GridSort, deviceCountry?: string): { countries: CountryChoice[]; languages: CountryChoice[] } {
  const countries = choices.filter((c) => !c.isLanguage);
  const languages = choices.filter((c) => c.isLanguage);
  if (sort === 'az') {
    countries.sort((a, b) => (a.key === deviceCountry ? -1 : b.key === deviceCountry ? 1 : 0) || cmp(a.label, b.label));
    languages.sort((a, b) => cmp(a.label, b.label));
  }
  return { countries, languages };
}

/** The sort row, the countries in rows of `columns`, then a "Languages" heading and the language chips. */
export function gridRows(choices: readonly CountryChoice[], sort: GridSort, columns: number, deviceCountry?: string): GridRow[] {
  const { countries, languages } = orderChoices(choices, sort, deviceCountry);
  const rows: GridRow[] = [{ kind: 'sort', toggle: choices.length > AZ_TOGGLE_AFTER }];
  const chunk = (list: readonly CountryChoice[]) => {
    for (let i = 0; i < list.length; i += columns) rows.push({ kind: 'chips', keys: list.slice(i, i + columns).map((c) => c.key) });
  };
  chunk(countries);
  if (languages.length) {
    rows.push({ kind: 'heading' });
    chunk(languages);
  }
  return rows;
}

export const rowSelectable = (r: GridRow | undefined): boolean => r !== undefined && (r.kind === 'chips' || (r.kind === 'sort' && r.toggle));
const cellsIn = (r: GridRow): number => (r.kind === 'chips' ? r.keys.length : 1);

/** The chip of `key` (this TV's country), else the first chip, else the first selectable row. */
export function firstFocus(rows: readonly GridRow[], key?: string): GridFocus {
  if (key !== undefined) {
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!;
      if (row.kind !== 'chips') continue;
      const col = row.keys.indexOf(key);
      if (col >= 0) return { row: r, col };
    }
  }
  const first = rows.findIndex((x) => x.kind === 'chips');
  if (first >= 0) return { row: first, col: 0 };
  return { row: Math.max(0, rows.findIndex(rowSelectable)), col: 0 };
}

/** A focus kept valid after the rows changed (a sort toggle, new choices). */
export function clampFocus(rows: readonly GridRow[], f: GridFocus): GridFocus {
  const row = rows[f.row];
  if (!row || !rowSelectable(row)) return firstFocus(rows);
  return { row: f.row, col: Math.min(f.col, cellsIn(row) - 1) };
}

/** Up/Down: the next selectable row (column clamped); Left/Right within the row. No wrap out sideways. */
export function moveGrid(rows: readonly GridRow[], f: GridFocus, dir: 'up' | 'down' | 'left' | 'right'): GridMove {
  if (dir === 'left') return f.col > 0 ? { focus: { row: f.row, col: f.col - 1 } } : { edge: 'left' };
  if (dir === 'right') {
    const row = rows[f.row];
    return { focus: row && f.col < cellsIn(row) - 1 ? { row: f.row, col: f.col + 1 } : f };
  }
  const d = dir === 'up' ? -1 : 1;
  for (let r = f.row + d; r >= 0 && r < rows.length; r += d) {
    const row = rows[r]!;
    if (rowSelectable(row)) return { focus: { row: r, col: Math.min(f.col, cellsIn(row) - 1) } };
  }
  return { edge: dir };
}

export function keyAt(rows: readonly GridRow[], f: GridFocus): string | undefined {
  const row = rows[f.row];
  return row?.kind === 'chips' ? row.keys[f.col] : undefined;
}

export function rowTops(rows: readonly GridRow[]): number[] {
  const out: number[] = [];
  let y = 0;
  for (const r of rows) {
    out.push(y);
    y += ROW_PITCH[r.kind];
  }
  return out;
}

/** The scroll offset that shows the focused row (a heading right above it comes along); the first chips row: 0. */
export function scrollFor(rows: readonly GridRow[], focusRow: number, top: number, viewH: number): number {
  if (!rows.slice(0, focusRow).some((r) => r.kind === 'chips')) return 0;
  const tops = rowTops(rows);
  const y = tops[focusRow] ?? 0;
  const h = ROW_PITCH[rows[focusRow]?.kind ?? 'chips'];
  const want = focusRow > 0 && rows[focusRow - 1]!.kind === 'heading' ? tops[focusRow - 1]! : y;
  if (want < top) return want;
  if (y + h > top + viewH) return Math.max(0, y + h - viewH);
  return top;
}

/** Pointer: the chip (or the sort toggle) under a point in the grid's own coordinates, `scroll` applied. */
export function cellAt(rows: readonly GridRow[], scroll: number, p: { x: number; y: number }): GridFocus | undefined {
  const tops = rowTops(rows);
  const y = p.y + scroll;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const t = tops[r]!;
    if (y < t || y >= t + ROW_PITCH[row.kind]) continue;
    if (row.kind === 'sort') return row.toggle ? { row: r, col: 0 } : undefined;
    if (row.kind !== 'chips' || y >= t + CHIP.h) return undefined;
    const col = Math.floor(p.x / (CHIP.w + CHIP.gap));
    if (col < 0 || col >= row.keys.length || p.x - col * (CHIP.w + CHIP.gap) >= CHIP.w) return undefined;
    return { row: r, col };
  }
  return undefined;
}

/** OK on a chip: picking appends the key (pick order), un-picking removes it; past `REGIONS_MAX` nothing changes. */
export function togglePick(codes: readonly string[], key: string): { codes: string[]; capped: boolean } {
  if (codes.includes(key)) return { codes: codes.filter((c) => c !== key), capped: false };
  if (codes.length >= REGIONS_MAX) return { codes: [...codes], capped: true };
  return { codes: [...codes, key], capped: false };
}

/** 1, 2, 3… in pick order; undefined when not picked. */
export function pickNumber(codes: readonly string[], key: string): number | undefined {
  const i = codes.indexOf(key);
  return i < 0 ? undefined : i + 1;
}

/** Folders across Live TV, Movies and Series (the chip's count). */
export const choiceFolders = (c: CountryChoice): number => c.live + (c.movies ?? 0) + (c.series ?? 0);

/** The chip's screen-reader label: "Sweden, 24 folders, picked, number 1, 1 of 12". `index` counts from 0. */
export function chipLabel(c: CountryChoice, codes: readonly string[], index: number, total: number): string {
  const parts = [c.label, COUNTRIES_COPY.folders(choiceFolders(c))];
  const n = pickNumber(codes, c.key);
  if (n !== undefined) parts.push('picked', `number ${n}`);
  parts.push(`${index + 1} of ${total}`);
  return parts.join(', ');
}

/** A flag image, or a text badge: language keys ("EN") and countries without an image (disputed territories). */
export type ChipArt = { src: string } | { badge: string };
export function chipArt(key: string, flagOf: (key: string) => string | undefined): ChipArt {
  if (key.startsWith('lang:')) return { badge: key.slice(5).toUpperCase() };
  const src = flagOf(key);
  return src ? { src } : { badge: key };
}

/** "Live TV: 24 folders first · Movies: 12 · Series: 9"; a section not known yet is left out; '' with nothing picked. */
export function resultLine(c: Pick<CountryChoices, 'regions' | 'counts' | 'stale'>): string {
  if (c.regions.mode === 'off' || c.regions.codes.length === 0 || c.stale) return '';
  const parts = [`Live TV: ${COUNTRIES_COPY.folders(c.counts.live)} first`];
  if (c.counts.movies !== undefined) parts.push(`Movies: ${c.counts.movies}`);
  if (c.counts.series !== undefined) parts.push(`Series: ${c.counts.series}`);
  return parts.join(' · ');
}
