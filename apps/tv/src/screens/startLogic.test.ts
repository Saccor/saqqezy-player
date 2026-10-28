import { describe, expect, test } from 'vitest';
import type { StartRow, VodTile } from '@iptv/app-api';
import {
  cellId, channelMenuItems, channelsLabel, eventMenuItems, eventMenuPatch, activeMatchChip, matchChipActions, MATCHES_COPY, eventWhen, focusAfterLoad, locateStart, moveStart, rowKind, toPosterRow, START_POSTER, START_ROW_Y, focusLabel, labelWidth,
  COMP_ALL, COMP_MORE, compChipId, compKeyOf, competitionChipActions, competitionMenuItems, competitionPatch, matchesSummary,
} from './startLogic.ts';
import { gridLayout } from '../vod/gridLogic.ts';
import { LAYOUT } from '../shell/theme.ts';

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
});

describe('See all: category chips (design note §3.7–3.8)', () => {
  test("All, then the guide's own category texts; none without categories", () => {
    const a = matchChipActions([{ id: 'fotboll', label: 'Fotboll' }, { id: 'ishockey', label: 'Ishockey' }]);
    expect(a.map((x) => [x.id, x.label])).toEqual([['all', 'All'], ['fotboll', 'Fotboll'], ['ishockey', 'Ishockey']]);
    expect(a.every((x) => x.width >= 120)).toBe(true);
    expect(a[1]!.width).toBeGreaterThan(a[0]!.width);
    expect(matchChipActions([])).toEqual([]);
  });
  test('long guide texts: each chip is capped and the bar never passes the width it gets (1080p title line)', () => {
    const long = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, label: `Synthetic Category Number ${i} With A Long Name` }));
    const max = 1168;
    const a = matchChipActions(long, max);
    expect(a).toHaveLength(7);
    const total = a.reduce((s, x) => s + x.width, 0) + 16 * (a.length - 1);
    expect(total).toBeLessThanOrEqual(max);
    expect(a.every((x) => x.width >= 120)).toBe(true);
    expect(a[0]!.width).toBe(120);
    const one = matchChipActions([{ id: 'c', label: 'A'.repeat(60) }]);
    expect(one[1]!.width).toBeLessThanOrEqual(320);
  });
  test('the active chip: a stored category among the chips, else All', () => {
    const chips = [{ id: 'fotboll', label: 'Fotboll' }, { id: 'ishockey', label: 'Ishockey' }];
    expect(activeMatchChip(chips, ['ishockey'])).toBe('ishockey');
    expect(activeMatchChip(chips, ['handboll', 'fotboll'])).toBe('fotboll');
    expect(activeMatchChip(chips, ['handboll'])).toBe('all');
    expect(activeMatchChip(chips, [])).toBe('all');
  });
  test('neutral copy', () => {
    expect({ title: MATCHES_COPY.title, empty: MATCHES_COPY.empty, allSports: MATCHES_COPY.allSports, more: MATCHES_COPY.more })
      .toEqual({ title: 'Matches', empty: 'No matches in your guide right now.', allSports: 'All sports', more: 'More…' });
  });
});

describe('Start dense layout (spec 2026-10-22 §1)', () => {
  test('rows start just under the safe top; posters are the compact grid size', () => {
    expect(START_ROW_Y).toBe(LAYOUT.safeY + 26);
    const g = gridLayout('compact');
    expect(START_POSTER).toEqual({ w: g.cellW, h: g.cellH });
  });
  test('the focused poster: title, year and rating, then its status; other cells say nothing', () => {
    const tile = { id: 'm1', kind: 'movie', title: 'Synthetic Film 001', categoryId: 'c', year: 2001, rating: 5.7, watched: false, favourite: false, progress: 0.4 } as const;
    expect(focusLabel({ type: 'vod', tile })).toBe('Synthetic Film 001 · 2001 · ★ 5.7 · 40% watched');
    expect(focusLabel({ type: 'viewAll', target: 'sports', total: 3 })).toBe('');
    expect(focusLabel(undefined)).toBe('');
  });
  test('labelWidth grows with the title', () => {
    expect(labelWidth('Continue watching')).toBeGreaterThan(labelWidth('On now'));
    expect(labelWidth('')).toBe(0);
  });
});

describe('View all chips (spec 2026-10-22 §3.2–3.3)', () => {
  const prefs = { followedTeams: [], pinnedCompetitions: ['test cup'], hiddenCompetitions: [] };
  test('competition chips: All <sport>, the guide texts (★ when pinned), then More… when there are more', () => {
    const a = competitionChipActions('Football', [{ id: 'test cup', label: 'Test Cup', pinned: true }, { id: 'northern cup', label: 'Northern Cup' }], true);
    expect(a.map((c) => [c.id, c.label])).toEqual([
      [COMP_ALL, 'All Football'], [compChipId('test cup'), '★ Test Cup'], [compChipId('northern cup'), 'Northern Cup'], [COMP_MORE, 'More…'],
    ]);
    expect(competitionChipActions('Football', [], false)).toEqual([]);
  });
  test('chip ids round-trip; All and More are not competitions (even one named "more")', () => {
    expect(compKeyOf(compChipId('more'))).toBe('more');
    expect(compKeyOf(COMP_MORE)).toBeUndefined();
    expect(compKeyOf(COMP_ALL)).toBeUndefined();
  });
  test('competition menu: put first or not, hide, cancel; the patch matches the match menu', () => {
    expect(competitionMenuItems('Test Cup', 'test cup', prefs).map((i) => i.label)).toEqual(["Don't put Test Cup first", 'Hide Test Cup', 'Cancel']);
    expect(competitionMenuItems('Northern Cup', 'northern cup', prefs)[0]!.label).toBe('Put Northern Cup first');
    expect(competitionPatch('pin', 'northern cup', prefs)).toEqual({ pinnedCompetitions: ['test cup', 'northern cup'] });
    expect(competitionPatch('pin', 'test cup', prefs)).toEqual({ pinnedCompetitions: [] });
    expect(competitionPatch('hide', 'test cup', prefs)).toEqual({ hiddenCompetitions: ['test cup'], pinnedCompetitions: [] });
  });
  test('summary', () => {
    expect(matchesSummary('Football', 23)).toBe('Football · 23 matches');
    expect(matchesSummary('All sports', 1)).toBe('All sports · 1 match');
  });
});
