import { describe, expect, test } from 'vitest';
import type { VodCategoryView } from '@iptv/app-api';
import {
  areaAbove, areaBelow, browseChips, browseSlots, chipLayout, chipMove, chipScroll, chipWidth, effectiveLine, greenOpensGrid, locateChip,
} from './browseNavLogic.ts';

const cats: VodCategoryView[] = [
  { id: 'vod:continue', name: 'Continue watching', count: 2 },
  { id: 'vod:favourites', name: 'Favourites', count: 0 },
  { id: 'vod:recent', name: 'Recently added', count: 120 },
  { id: 'all', name: 'All movies', count: 12400 },
  { id: '10', name: 'Drama', count: 245 },
  { id: '11', name: 'Empty genre', count: 0 },
  { id: '12', name: 'Documentary', count: 31 },
];

describe('browseChips', () => {
  test('the grid rail from its All entry on (the rows above it are rows here), in order, with counts; empty ones left out', () => {
    expect(browseChips(cats)).toEqual([
      { id: 'all', label: 'All movies · 12,400' },
      { id: '10', label: 'Drama · 245' },
      { id: '12', label: 'Documentary · 31' },
    ]);
  });

  test('no All entry (no catalogue yet) or nothing in it: no chips', () => {
    expect(browseChips(cats.slice(0, 3))).toEqual([]);
    expect(browseChips([{ id: 'all', name: 'All series', count: 0 }])).toEqual([]);
    expect(browseChips([])).toEqual([]);
  });
});

describe('chip layout', () => {
  test('a chip is as wide as its label (estimated), between a minimum and a maximum', () => {
    expect(chipWidth('Drama · 245')).toBeGreaterThanOrEqual(160);
    expect(chipWidth('All movies · 12,400')).toBeGreaterThan(chipWidth('Drama · 245'));
    expect(chipWidth('x'.repeat(200))).toBe(chipWidth('x'.repeat(300)));
  });

  test('chips sit side by side, a gap apart', () => {
    const l = chipLayout(['aaaa', 'bbbbbbbb', 'c'], 16);
    expect(l.xs[0]).toBe(0);
    expect(l.xs[1]).toBe(l.ws[0]! + 16);
    expect(l.xs[2]).toBe(l.xs[1]! + l.ws[1]! + 16);
  });

  test('scroll keeps the focused chip in view, moving as little as possible', () => {
    const xs = [0, 300, 600, 900, 1200];
    const ws = [280, 280, 280, 280, 280];
    expect(chipScroll(xs, ws, 0, 0, 1000)).toBe(0);
    expect(chipScroll(xs, ws, 2, 0, 1000)).toBe(0);
    // Chip 3 ends at 1180: scrolled so its right edge is the view's.
    expect(chipScroll(xs, ws, 3, 0, 1000)).toBe(180);
    // Back left: unchanged while the chip is in view, else its left edge.
    expect(chipScroll(xs, ws, 2, 180, 1000)).toBe(180);
    expect(chipScroll(xs, ws, 0, 180, 1000)).toBe(0);
    expect(chipScroll([], [], 0, 50, 1000)).toBe(0);
  });

  test('a remembered chip is found by id, else the index clamped', () => {
    const chips = browseChips(cats);
    expect(locateChip(chips, '12', 0)).toBe(2);
    expect(locateChip(chips, 'gone', 7)).toBe(2);
    expect(locateChip([], 'x', 3)).toBe(0);
  });
});

describe('chipMove', () => {
  test('left and right stay within the chips; up and down leave the row', () => {
    expect(chipMove(3, 0, 'left')).toEqual({ chip: 0 });
    expect(chipMove(3, 0, 'right')).toEqual({ chip: 1 });
    expect(chipMove(3, 2, 'right')).toEqual({ chip: 2 });
    expect(chipMove(3, 1, 'up')).toEqual({ edge: 'up' });
    expect(chipMove(3, 1, 'down')).toEqual({ edge: 'down' });
  });
});

describe('lines and areas', () => {
  test('the chips line counts only while there are chips', () => {
    expect(effectiveLine('chips', true)).toBe('chips');
    expect(effectiveLine('chips', false)).toBe('rows');
    expect(effectiveLine('rows', true)).toBe('rows');
  });

  test('Up: rows to the chips, chips to the hero (when a title shows there), then the tabs', () => {
    expect(areaAbove('rows', { chips: true, heroTile: true })).toBe('chips');
    expect(areaAbove('rows', { chips: false, heroTile: true })).toBe('hero');
    expect(areaAbove('rows', { chips: false, heroTile: false })).toBe('tabs');
    expect(areaAbove('chips', { chips: true, heroTile: true })).toBe('hero');
    expect(areaAbove('chips', { chips: true, heroTile: false })).toBe('tabs');
    expect(areaAbove('hero', { chips: true, heroTile: true })).toBe('tabs');
  });

  test('Down: tabs to the hero, the hero to the line on top (chips or rows), chips to the rows', () => {
    const ctx = { chips: true, heroTile: true, rows: true, line: 'chips' as const };
    expect(areaBelow('tabs', ctx)).toBe('hero');
    expect(areaBelow('tabs', { ...ctx, heroTile: false })).toBe('chips');
    expect(areaBelow('hero', ctx)).toBe('chips');
    expect(areaBelow('hero', { ...ctx, line: 'rows' })).toBe('rows');
    expect(areaBelow('hero', { ...ctx, chips: false })).toBe('rows');
    expect(areaBelow('chips', ctx)).toBe('rows');
    expect(areaBelow('chips', { ...ctx, rows: false })).toBe('chips');
  });
});

describe('browseSlots', () => {
  // 1080p: chips line 108 (title + chips), poster rows 326, 36 apart from y 290.
  const frame = { top: 290, gap: 36, bottom: 1080, peek: 64 };
  const C = 108;
  const P = 326;

  test('on the chips: the chips on top, then the poster rows below', () => {
    expect(browseSlots({ chipsH: C, rowH: P, chips: true, rowCount: 4, line: 'chips', row: 0 }, frame, 'peek'))
      .toEqual({ chipsY: 290, rows: [{ index: 0, y: 434 }, { index: 1, y: 796 }] });
  });

  test('on a row: that row on top (the chips scroll away), two in full and a third peeking in', () => {
    expect(browseSlots({ chipsH: C, rowH: P, chips: true, rowCount: 4, line: 'rows', row: 0 }, frame, 'peek'))
      .toEqual({ rows: [{ index: 0, y: 290 }, { index: 1, y: 652 }, { index: 2, y: 1014 }] });
    expect(browseSlots({ chipsH: C, rowH: P, chips: false, rowCount: 4, line: 'rows', row: 3 }, frame, 'peek'))
      .toEqual({ rows: [{ index: 3, y: 290 }] });
  });

  test('pointer mode: only whole rows above the button row', () => {
    expect(browseSlots({ chipsH: C, rowH: P, chips: true, rowCount: 4, line: 'rows', row: 0 }, { ...frame, bottom: 978 }, 'whole'))
      .toEqual({ rows: [{ index: 0, y: 290 }, { index: 1, y: 652 }] });
    expect(browseSlots({ chipsH: C, rowH: P, chips: true, rowCount: 4, line: 'chips', row: 2 }, { ...frame, bottom: 978 }, 'whole'))
      .toEqual({ chipsY: 290, rows: [{ index: 0, y: 434 }] });
  });

  test('no rows and no chips: nothing', () => {
    expect(browseSlots({ chipsH: C, rowH: P, chips: false, rowCount: 0, line: 'rows', row: 0 }, frame, 'peek')).toEqual({ rows: [] });
  });
});

describe('greenOpensGrid', () => {
  test('Green opens the All grid only while the catalogue is ready, never on loading, empty or failed', () => {
    expect(greenOpensGrid('ready')).toBe(true);
    for (const s of ['loading', 'empty', 'error', undefined]) expect(greenOpensGrid(s)).toBe(false);
  });
});
