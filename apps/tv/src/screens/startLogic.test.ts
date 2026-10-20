import { describe, expect, test } from 'vitest';
import type { StartRow, VodTile } from '@iptv/app-api';
import {
  cellId, channelMenuItems, channelsLabel, eventMenuItems, eventMenuPatch, eventMeta, matchChipActions, MATCHES_COPY, eventWhen, focusAfterLoad, gridMove, locateStart, moveStart, rowKind, startRowSlots, toPosterRow,
} from './startLogic.ts';
import { rowSlots } from '../components/rowSlots.ts';

const vod = (n: number) => ({ type: 'vod', tile: { id: `v${n}`, kind: 'movie', title: `F${n}` } as VodTile }) as const;
const chan = (n: number) => ({ type: 'channel', channel: { id: `c${n}`, number: n, name: `Channel ${n}`, group: 'G', favourite: false } }) as const;
const rows: StartRow[] = [
  { id: 'continue', title: 'Continue watching', cells: [vod(1), vod(2), vod(3)] },
  { id: 'live', title: 'Live now', cells: [chan(1), chan(2)] },
  { id: 'newLibrary', title: 'New in your library', cells: [vod(4), { type: 'viewAll', target: 'movie', total: 40 }] },
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
    expect(eventWhen({ start: now + 25 * 60_000, stop: now + 9e6 }, now)).toBe('In 25 min');
    expect(eventWhen({ start: now + 30_000, stop: now + 9e6 }, now)).toBe('In 1 min');
    expect(channelsLabel(1)).toBe('1 channel');
    expect(channelsLabel(4)).toBe('4 channels');
  });
  test('poster row model for PosterRow', () => {
    const m = toPosterRow(rows[2]!);
    expect(m).toMatchObject({ id: 'newLibrary', total: 40, loaded: true });
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
    expect(focusAfterLoad({ hadRows: false }, { hasRows: true }, 'rail', false)).toBeUndefined();
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
  test('is the shared row slots (tests in components/rowSlots.test.ts)', () => {
    expect(startRowSlots).toBe(rowSlots);
  });
});

describe('the match long-press menu (design note live-matches-ranking §3.7–3.8)', () => {
  const ev = { key: 'p:a|b@1', title: 'Lakeshore v Pinecrest', sides: ['Lakeshore', 'Pinecrest'] as [string, string], start: 0, stop: 1, channelCount: 2, followed: false, competition: 'Test Cup' };
  const st = { followedTeams: ['Pinecrest'], pinnedCompetitions: [] as string[], hiddenCompetitions: [] as string[] };
  test('follow each side, put the competition first, hide it, cancel; From the start first when archived', () => {
    expect(eventMenuItems(ev, st, false)).toEqual([
      { id: 'follow:Lakeshore', label: 'Follow Lakeshore' }, { id: 'follow:Pinecrest', label: 'Unfollow Pinecrest' },
      { id: 'pin', label: 'Put Test Cup first' }, { id: 'hide', label: 'Hide Test Cup' }, { id: 'cancel', label: 'Cancel' },
    ]);
    expect(eventMenuItems(ev, { ...st, pinnedCompetitions: ['test cup'] }, true).map((i) => i.label))
      .toEqual(['From the start', 'Follow Lakeshore', 'Unfollow Pinecrest', "Don't put Test Cup first", 'Hide Test Cup', 'Cancel']);
    const plain = { ...ev, competition: undefined, sides: undefined };
    expect(eventMenuItems(plain, st, false)).toEqual([{ id: 'cancel', label: 'Cancel' }]);
  });
  test('choices become setting changes: folded competition keys, newest kept at the cap; hiding unpins', () => {
    expect(eventMenuPatch('follow:Lakeshore', ev, st)).toEqual({ followedTeams: ['Pinecrest', 'Lakeshore'] });
    expect(eventMenuPatch('follow:pinecrest', ev, st)).toEqual({ followedTeams: [] });
    expect(eventMenuPatch('pin', ev, st)).toEqual({ pinnedCompetitions: ['test cup'] });
    expect(eventMenuPatch('pin', ev, { ...st, pinnedCompetitions: ['test cup'] })).toEqual({ pinnedCompetitions: [] });
    const full = Array.from({ length: 20 }, (_, i) => `cup ${i}`);
    expect(eventMenuPatch('pin', ev, { ...st, pinnedCompetitions: full })!.pinnedCompetitions).toEqual([...full.slice(1), 'test cup']);
    expect(eventMenuPatch('hide', ev, { ...st, pinnedCompetitions: ['test cup'] })).toEqual({ hiddenCompetitions: ['test cup'], pinnedCompetitions: [] });
    expect(eventMenuPatch('fromStart', ev, st)).toBeUndefined();
  });
  test('strip meta: when, channels, then the competition or sub-title', () => {
    const now = 0;
    expect(eventMeta({ ...ev, start: -1, stop: 10 }, now)).toBe('Live · 2 channels · Test Cup');
    expect(eventMeta({ ...ev, competition: undefined, subTitle: 'Round 3', start: -1, stop: 10 }, now)).toBe('Live · 2 channels · Round 3');
  });
});

describe('See all: category chips (design note §3.7–3.8)', () => {
  test("All, then the guide's own category texts; none without categories", () => {
    const a = matchChipActions([{ id: 'fotboll', label: 'Fotboll' }, { id: 'ishockey', label: 'Ishockey' }]);
    expect(a.map((x) => [x.id, x.label])).toEqual([['all', 'All'], ['fotboll', 'Fotboll'], ['ishockey', 'Ishockey']]);
    expect(a.every((x) => x.width >= 120)).toBe(true);
    expect(a[1]!.width).toBeGreaterThan(a[0]!.width);
    expect(matchChipActions([])).toEqual([]);
  });
  test('neutral copy', () => {
    expect(MATCHES_COPY).toEqual({ title: 'Matches in your guide', empty: 'No matches in your guide right now.' });
  });
});
