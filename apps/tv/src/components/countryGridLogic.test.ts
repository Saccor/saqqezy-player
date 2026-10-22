import { describe, expect, it } from 'vitest';
import type { CountryChoice } from '@iptv/app-api';
import { REGIONS_MAX } from '@iptv/core';
import {
  CHIP, CHIP_BOXES, cellAt, chipArt, chipLabel, clampFocus, firstFocus, gridColumns, gridRows, gridWidth, keyAt, moveGrid, pickNumber, resultLine,
  rowTops, scrollFor, togglePick, type GridRow,
} from './countryGridLogic.ts';

const LABELS: Record<string, string> = {
  SE: 'Sweden', BE: 'Belgium', DE: 'Germany', FR: 'France', DK: 'Denmark', 'lang:en': 'English', 'lang:es': 'Spanish',
};
const c = (key: string, live: number, extra: Partial<CountryChoice> = {}): CountryChoice =>
  ({ key, label: LABELS[key] ?? key, isLanguage: key.startsWith('lang:'), live, ...extra });
/** The worker's order: this TV's country (SE) first, then most folders. */
const CHOICES = [c('SE', 24), c('BE', 31), c('DE', 28), c('FR', 22), c('lang:en', 12), c('lang:es', 4), c('DK', 3)];
const ROWS: GridRow[] = gridRows(CHOICES, 'most', 4, 'SE');

describe('grid rows', () => {
  it('a sort row, the countries in rows of four, then a Languages heading and the languages', () => {
    expect(ROWS).toEqual([
      { kind: 'sort', toggle: false },
      { kind: 'chips', keys: ['SE', 'BE', 'DE', 'FR'] },
      { kind: 'chips', keys: ['DK'] },
      { kind: 'heading' },
      { kind: 'chips', keys: ['lang:en', 'lang:es'] },
    ]);
  });
  it('A–Z keeps this TV first; three columns at large text; the toggle only past 24 choices', () => {
    expect(gridRows(CHOICES, 'az', 4, 'SE').filter((r) => r.kind === 'chips')).toEqual([
      { kind: 'chips', keys: ['SE', 'BE', 'DK', 'FR'] }, { kind: 'chips', keys: ['DE'] }, { kind: 'chips', keys: ['lang:en', 'lang:es'] },
    ]);
    expect(gridColumns()).toBe(4);
    expect(gridColumns(1.25)).toBe(3);
    expect(gridWidth(4)).toBe(1112);
    expect(gridRows(CHOICES, 'most', 3)[1]).toEqual({ kind: 'chips', keys: ['SE', 'BE', 'DE'] });
    const many = Array.from({ length: 25 }, (_, i) => c(`C${i}`, 30 - i));
    expect(gridRows(many, 'most', 4)[0]).toEqual({ kind: 'sort', toggle: true });
    expect(gridRows(many.slice(0, 24), 'most', 4)[0]).toEqual({ kind: 'sort', toggle: false });
  });
});

describe('focus', () => {
  it('Up/Down move between rows (headings skipped, column clamped), Left/Right within a row, no sideways wrap', () => {
    expect(moveGrid(ROWS, { row: 1, col: 3 }, 'down')).toEqual({ focus: { row: 2, col: 0 } });
    expect(moveGrid(ROWS, { row: 2, col: 0 }, 'down')).toEqual({ focus: { row: 4, col: 0 } });
    expect(moveGrid(ROWS, { row: 4, col: 1 }, 'up')).toEqual({ focus: { row: 2, col: 0 } });
    expect(moveGrid(ROWS, { row: 4, col: 1 }, 'down')).toEqual({ edge: 'down' });
    expect(moveGrid(ROWS, { row: 1, col: 2 }, 'up')).toEqual({ edge: 'up' });
    expect(moveGrid(ROWS, { row: 1, col: 0 }, 'left')).toEqual({ edge: 'left' });
    expect(moveGrid(ROWS, { row: 1, col: 2 }, 'left')).toEqual({ focus: { row: 1, col: 1 } });
    expect(moveGrid(ROWS, { row: 1, col: 3 }, 'right')).toEqual({ focus: { row: 1, col: 3 } });
    expect(moveGrid(ROWS, { row: 2, col: 0 }, 'right')).toEqual({ focus: { row: 2, col: 0 } });
    const toggled: GridRow[] = [{ kind: 'sort', toggle: true }, ...ROWS.slice(1)];
    expect(moveGrid(toggled, { row: 1, col: 2 }, 'up')).toEqual({ focus: { row: 0, col: 0 } });
  });
  it('first focus on a key (this TV) else the first chip; clamped after the rows change', () => {
    expect(firstFocus(ROWS, 'DK')).toEqual({ row: 2, col: 0 });
    expect(firstFocus(ROWS)).toEqual({ row: 1, col: 0 });
    expect(firstFocus(ROWS, 'XX')).toEqual({ row: 1, col: 0 });
    expect(clampFocus(ROWS, { row: 3, col: 0 })).toEqual({ row: 1, col: 0 });
    expect(clampFocus(ROWS, { row: 2, col: 3 })).toEqual({ row: 2, col: 0 });
    expect(keyAt(ROWS, { row: 4, col: 1 })).toBe('lang:es');
    expect(keyAt(ROWS, { row: 0, col: 0 })).toBeUndefined();
  });
  it('scrolls the focused row into view (a heading comes along), from the top on the first row', () => {
    expect(rowTops(ROWS)).toEqual([0, 64, 248, 432, 488]);
    expect(scrollFor(ROWS, 4, 0, 400)).toBe(272);
    expect(scrollFor(ROWS, 1, 272, 400)).toBe(0);
    expect(scrollFor(ROWS, 2, 0, 400)).toBe(32);
    expect(scrollFor(ROWS, 2, 32, 400)).toBe(32);
  });
  it('pointer: the chip under a point, gaps and the label-only sort row give nothing', () => {
    expect(cellAt(ROWS, 0, { x: 10, y: 70 })).toEqual({ row: 1, col: 0 });
    expect(cellAt(ROWS, 0, { x: 290, y: 70 })).toEqual({ row: 1, col: 1 });
    expect(cellAt(ROWS, 0, { x: 270, y: 70 })).toBeUndefined();
    expect(cellAt(ROWS, 0, { x: 10, y: 234 })).toBeUndefined();
    expect(cellAt(ROWS, 0, { x: 10, y: 10 })).toBeUndefined();
    expect(cellAt(ROWS, 272, { x: 10, y: 221 })).toEqual({ row: 4, col: 0 });
  });
});

describe('picks', () => {
  it('OK appends or removes a key; the eleventh pick changes nothing', () => {
    expect(togglePick(['SE'], 'BE')).toEqual({ codes: ['SE', 'BE'], capped: false });
    expect(togglePick(['SE', 'BE'], 'SE')).toEqual({ codes: ['BE'], capped: false });
    const ten = ['SE', 'NO', 'DK', 'FI', 'IS', 'DE', 'AT', 'CH', 'FR', 'BE'];
    expect(ten).toHaveLength(REGIONS_MAX);
    expect(togglePick(ten, 'NL')).toEqual({ codes: ten, capped: true });
    expect(togglePick(ten, 'SE').codes).toHaveLength(9);
  });
  it('pick numbers follow the pick order', () => {
    expect(pickNumber(['SE', 'BE'], 'BE')).toBe(2);
    expect(pickNumber(['SE', 'BE'], 'DE')).toBeUndefined();
  });
  it('screen-reader label, flag or text badge, result line', () => {
    expect(chipLabel(c('SE', 24), ['SE'], 0, 12)).toBe('Sweden, 24 folders, picked, number 1, 1 of 12');
    expect(chipLabel(c('BE', 31), ['SE'], 1, 12)).toBe('Belgium, 31 folders, 2 of 12');
    expect(chipLabel(c('SE', 20, { movies: 3, series: 1 }), [], 0, 1)).toBe('Sweden, 24 folders, 1 of 1');
    expect(chipArt('SE', () => 'se.png')).toEqual({ src: 'se.png' });
    expect(chipArt('TW', () => undefined)).toEqual({ badge: 'TW' });
    expect(chipArt('lang:en', () => 'never.png')).toEqual({ badge: 'EN' });
    const on = { regions: { codes: ['SE'], mode: 'first' as const }, stale: false };
    expect(resultLine({ ...on, counts: { live: 24, movies: 12, series: 9 } })).toBe('Live TV: 24 folders first · Movies: 12 · Series: 9');
    expect(resultLine({ ...on, counts: { live: 1 } })).toBe('Live TV: 1 folder first');
    expect(resultLine({ ...on, regions: { codes: ['SE'], mode: 'off' }, counts: { live: 0 } })).toBe('');
    expect(resultLine({ ...on, stale: true, counts: { live: 0 } })).toBe('');
  });
});

describe('chip layout', () => {
  const boxes = Object.entries(CHIP_BOXES);
  const hit = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  it('no part overlaps another', () => {
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      expect(hit(boxes[i]![1], boxes[j]![1]), `${boxes[i]![0]} vs ${boxes[j]![0]}`).toBe(false);
    }
  });
  it('a normal chip (count line at full width, no badge) overlaps nothing; the flag is centred and clear of the pick pill', () => {
    const wide = { ...CHIP_BOXES.count, w: CHIP_BOXES.name.w };
    for (const name of ['flag', 'pill', 'name'] as const) expect(hit(wide, CHIP_BOXES[name]), `count vs ${name}`).toBe(false);
    expect(CHIP_BOXES.flag.x + CHIP_BOXES.flag.w / 2).toBe(CHIP.w / 2);
    expect(CHIP_BOXES.pill.x).toBeGreaterThan(CHIP_BOXES.flag.x + CHIP_BOXES.flag.w);
  });
  it('every part stays inside the chip, clear of the 4 px picked border', () => {
    for (const [name, b] of boxes) {
      expect(b.x, name).toBeGreaterThanOrEqual(4);
      expect(b.y, name).toBeGreaterThanOrEqual(4);
      expect(b.x + b.w, name).toBeLessThanOrEqual(CHIP.w - 4);
      expect(b.y + b.h, name).toBeLessThanOrEqual(CHIP.h - 4);
    }
  });
});
