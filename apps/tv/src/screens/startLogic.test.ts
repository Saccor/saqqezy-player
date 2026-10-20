import { describe, expect, test } from 'vitest';
import type { StartRow, VodTile } from '@iptv/app-api';
import { cellId, channelMenuItems, channelsLabel, eventWhen, focusAfterLoad, gridMove, locateStart, moveStart, rowKind, startRowSlots, toPosterRow } from './startLogic.ts';

const vod = (n: number) => ({ type: 'vod', tile: { id: `v${n}`, kind: 'movie', title: `F${n}` } as VodTile }) as const;
const chan = (n: number) => ({ type: 'channel', channel: { id: `c${n}`, number: n, name: `Channel ${n}`, group: 'G', favourite: false } }) as const;
const rows: StartRow[] = [
  { id: 'continue', title: 'Continue watching', cells: [vod(1), vod(2), vod(3)] },
  { id: 'live', title: 'Live now', cells: [chan(1), chan(2)] },
  { id: 'newMovies', title: 'Recently added movies', cells: [vod(4), { type: 'viewAll', target: 'movie', total: 40 }] },
];

describe('startLogic', () => {
  test('row kinds and cell ids', () => {
    expect(rows.map(rowKind)).toEqual(['poster', 'wide', 'poster']);
    expect(cellId(rows[1]!.cells[0]!)).toBe('c:c1');
    expect(cellId(rows[2]!.cells[1]!)).toBe('all:movie');
  });
  test('moves: clamp in a row, top edge, remembered column per row', () => {
    const cols = new Map<string, number>();
    expect(moveStart(rows, { row: 0, col: 0 }, 'up', cols)).toEqual({ edge: 'top' });
    expect(moveStart(rows, { row: 0, col: 2 }, 'right', cols)).toEqual({ focus: { row: 0, col: 2 } });
    expect(moveStart(rows, { row: 0, col: 2 }, 'down', cols)).toEqual({ focus: { row: 1, col: 1 } });
    expect(moveStart(rows, { row: 1, col: 1 }, 'up', cols)).toEqual({ focus: { row: 0, col: 2 } });
    expect(moveStart(rows, { row: 2, col: 0 }, 'down', cols)).toEqual({ focus: { row: 2, col: 0 } });
  });
  test('locate by row id and cell id after rows change', () => {
    const fewer = rows.slice(1);
    expect(locateStart(fewer, { row: 1, col: 1, rowId: 'live', cellId: 'c:c2' })).toEqual({ row: 0, col: 1 });
    expect(locateStart(fewer, { row: 5, col: 9, rowId: 'gone' })).toEqual({ row: 1, col: 1 });
    expect(locateStart([], { row: 0, col: 0 })).toEqual({ row: 0, col: 0 });
  });
  test('event time labels', () => {
    const now = new Date(2026, 9, 19, 18, 10).getTime();
    expect(eventWhen({ start: now - 60_000, stop: now + 60_000 }, now)).toBe('Live');
    expect(eventWhen({ start: new Date(2026, 9, 19, 20, 0).getTime(), stop: now + 9e6 }, now)).toBe('20:00');
    expect(eventWhen({ start: new Date(2026, 9, 20, 1, 30).getTime(), stop: now + 9e7 }, now)).toBe('Tomorrow 01:30');
    // Started yesterday, not live any more: no "Tomorrow".
    expect(eventWhen({ start: new Date(2026, 9, 18, 22, 0).getTime(), stop: new Date(2026, 9, 18, 23, 0).getTime() }, now)).toBe('22:00');
    expect(channelsLabel(1)).toBe('1 channel');
    expect(channelsLabel(4)).toBe('4 channels');
  });
  test('poster row model for PosterRow', () => {
    const m = toPosterRow(rows[2]!);
    expect(m).toMatchObject({ id: 'newMovies', total: 40, loaded: true });
    expect(m.items.map((t) => t.id)).toEqual(['v4']);
  });
  test('gridMove: 5 columns, clamps, top edge', () => {
    expect(gridMove(12, 5, 0, 'up')).toBe('top');
    expect(gridMove(12, 5, 0, 'right')).toBe(1);
    expect(gridMove(12, 5, 4, 'right')).toBe(4);
    expect(gridMove(12, 5, 3, 'down')).toBe(8);
    expect(gridMove(12, 5, 8, 'down')).toBe(11);
    expect(gridMove(12, 5, 11, 'down')).toBe(11);
    expect(gridMove(12, 5, 7, 'up')).toBe(2);
    expect(gridMove(12, 5, 5, 'left')).toBe(5);
  });
});

describe('focusAfterLoad', () => {
  test('focuses the rows when they first appear and the user wants them', () => {
    expect(focusAfterLoad({ hadRows: false }, { hasRows: true }, 'rows', false)).toBe('rows');
  });
  test('leaves focus alone otherwise', () => {
    expect(focusAfterLoad({ hadRows: false }, { hasRows: true }, 'tabs', false)).toBeUndefined();
    expect(focusAfterLoad({ hadRows: false }, { hasRows: true }, 'rows', true)).toBeUndefined();
    expect(focusAfterLoad({ hadRows: true }, { hasRows: true }, 'rows', false)).toBeUndefined();
    expect(focusAfterLoad({ hadRows: false }, { hasRows: false }, 'rows', false)).toBeUndefined();
  });
});

describe('channelMenuItems', () => {
  test('a long press offers the favourite change behind a menu, with Cancel last', () => {
    expect(channelMenuItems(false)).toEqual([{ id: 'fav', label: 'Add to favourites' }, { id: 'cancel', label: 'Cancel' }]);
    expect(channelMenuItems(true)).toEqual([{ id: 'fav', label: 'Remove from favourites' }, { id: 'cancel', label: 'Cancel' }]);
  });
});

describe('startRowSlots', () => {
  // Poster rows 326 high (label + tile), wide rows 203, rows 36 apart, the first at y 290 (Start's 1080p layout).
  const P = 326;
  const W = 203;
  const slots = (heights: number[], focus: number, mode: 'peek' | 'whole', bottom = 1080) =>
    startRowSlots(heights, focus, { top: 290, gap: 36, bottom, peek: 64 }, mode).map((s) => [s.index, s.y]);

  test('two poster rows in full, then a peek of the third (its title and a strip of tiles)', () => {
    expect(slots([P, P, P, P], 0, 'peek')).toEqual([[0, 290], [1, 652], [2, 1014]]);
  });

  test('the focused row stays on top; wide rows let more rows in', () => {
    expect(slots([P, W, W, P, P], 1, 'peek')).toEqual([[1, 290], [2, 529], [3, 768]]);
    expect(slots([W, W, W, W], 0, 'peek')).toEqual([[0, 290], [1, 529], [2, 768], [3, 1007]]);
  });

  test('a row that would show less than the peek is left out; the last row has nothing below', () => {
    expect(slots([P, P, P], 0, 'peek', 1077)).toEqual([[0, 290], [1, 652]]);
    expect(slots([P, P], 1, 'peek')).toEqual([[1, 290]]);
  });

  test('whole: only rows that fit entirely above the bottom (pointer mode keeps the button row free)', () => {
    expect(slots([P, P, P], 0, 'whole', 978)).toEqual([[0, 290], [1, 652]]);
    expect(slots([P, P, P], 0, 'whole', 977)).toEqual([[0, 290]]);
  });

  test('the focused row is always there, whatever its height; no rows, no slots', () => {
    expect(slots([2000], 0, 'whole', 978)).toEqual([[0, 290]]);
    expect(slots([], 0, 'peek')).toEqual([]);
  });
});
