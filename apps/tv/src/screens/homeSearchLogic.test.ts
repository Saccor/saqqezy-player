// apps/tv/src/screens/homeSearchLogic.test.ts
import type { ChannelRow } from '@iptv/app-api';
import { describe, expect, it } from 'vitest';
import { COMPACT_LAYOUT } from '../components/keyboardLogic.ts';
import {
  BAR_PLACEHOLDER, BROWSE, HOME_GROUP_W, SEARCH_GROUP_ID, SEARCH_GROUP_NAME, SEARCH_HINT, applyQuery, exitSearch,
  groupChoice, groupColumn, isSearching, leaveTo, listMode, okAction, previewAllowed, restoreOnMount, rowChannelId,
  userNavigated, type BrowsePosition,
} from './homeSearchLogic.ts';
import { nextFocus, type SearchRow } from './searchLogic.ts';

const ch = (n: number): ChannelRow => ({ id: `s:${n}`, number: n, name: `Channel ${n}`, group: 'G', favourite: false });
const channelRow = (n: number): SearchRow => ({ kind: 'channel', channel: ch(n) });
const onNowRow = (n: number): SearchRow => ({ kind: 'onNow', hit: { channel: ch(n), title: 'Synthetic Show', start: 0, stop: 1 } });
const laterRow = (n: number): SearchRow => ({ kind: 'later', hit: { channel: ch(n), title: 'Synthetic Show', start: 10, stop: 20, more: 0 } });
const pos: BrowsePosition = { groupId: 'g:News', channelId: 's:3', top: 2 };

describe('layout and copy', () => {
  it('the compact keyboard fits the groups column with readable keys', () => {
    expect(HOME_GROUP_W).toBe(380);
    expect(COMPACT_LAYOUT.width).toBeLessThanOrEqual(HOME_GROUP_W);
    expect(COMPACT_LAYOUT.unit - COMPACT_LAYOUT.keyGap).toBeGreaterThanOrEqual(52);
    expect(COMPACT_LAYOUT.keyH).toBeGreaterThanOrEqual(52);
  });

  it('uses the spec copy', () => {
    expect(BAR_PLACEHOLDER).toBe('Search channels and programmes');
    expect(SEARCH_GROUP_NAME).toBe('Search results');
    expect(SEARCH_HINT).toBe('Ok play · Ok again: fullscreen · Back: end search');
  });
});

describe('search mode', () => {
  it('the first non-blank text enters search and saves the browse position and source', () => {
    const c = applyQuery(BROWSE, 'n', pos, 'src1');
    expect(c.kind).toBe('enter');
    expect(c.state).toEqual({ query: 'n', focus: 0, returning: false, saved: pos, sourceId: 'src1' });
    expect(isSearching(c.state)).toBe(true);
  });

  it('blank text never enters search mode', () => {
    expect(applyQuery(BROWSE, '', pos, 'src1')).toEqual({ kind: 'none', state: BROWSE });
    expect(applyQuery(BROWSE, '   ', pos, 'src1')).toEqual({ kind: 'none', state: BROWSE });
  });

  it('more typing updates the query and keeps the saved position', () => {
    const s = applyQuery(BROWSE, 'n', pos, 'src1').state;
    const c = applyQuery(leaveTo(s, 3), 'ne', { groupId: 'all', top: 0 }, 'src1');
    expect(c.kind).toBe('update');
    expect(c.state).toEqual({ query: 'ne', focus: 3, returning: false, saved: pos, sourceId: 'src1' });
  });

  it('clearing the query exits and restores the group, row and top', () => {
    const s = applyQuery(BROWSE, 'news', pos, 'src1').state;
    expect(applyQuery(s, '', undefined, 'src1')).toEqual({ kind: 'exit', state: BROWSE, restore: pos });
    expect(applyQuery(s, '  ', undefined, 'src1')).toEqual({ kind: 'exit', state: BROWSE, restore: pos });
  });

  it('exitSearch (Back, or choosing a group) restores the saved position', () => {
    const s = applyQuery(BROWSE, 'news', pos, 'src1').state;
    expect(exitSearch(s)).toEqual({ kind: 'exit', state: BROWSE, restore: pos });
    expect(exitSearch(BROWSE).restore).toBeUndefined();
    expect(exitSearch(applyQuery(BROWSE, 'x', undefined, undefined).state).restore).toBeUndefined();
  });

  it('leaveTo marks the row to restore; user navigation cancels the restore', () => {
    const s = leaveTo(applyQuery(BROWSE, 'news', pos, 'src1').state, 5);
    expect(s.focus).toBe(5);
    expect(s.returning).toBe(true);
    expect(userNavigated(s).returning).toBe(false);
    const idle = userNavigated(BROWSE);
    expect(idle).toBe(BROWSE);
  });

  it('a remembered search survives a Home visit on the same source only', () => {
    const s = applyQuery(BROWSE, 'news', pos, 'src1').state;
    expect(restoreOnMount(s, 'src1')).toBe(s);
    expect(restoreOnMount(s, 'src2')).toEqual(BROWSE);
    expect(restoreOnMount(s, undefined)).toEqual(BROWSE);
    expect(restoreOnMount(BROWSE, 'src1')).toEqual(BROWSE);
  });

  it('returning from the Player or the Guide restores the query and the row', () => {
    const back = restoreOnMount(leaveTo(applyQuery(BROWSE, 'synthetic', pos, 'src1').state, 4), 'src1');
    expect(back).toEqual({ query: 'synthetic', focus: 4, returning: true, saved: pos, sourceId: 'src1' });
    const rows: SearchRow[] = [
      { kind: 'header', label: 'Channels' }, channelRow(1), channelRow(2), { kind: 'header', label: 'On now' }, onNowRow(3), onNowRow(4),
    ];
    const d = nextFocus({ rows, returning: back.returning, memoryFocus: back.focus, prevFocus: 0, query: 'synthetic', settledQuery: '', viewRows: 9 });
    expect(d).toMatchObject({ focus: 4, focusList: true, consumeReturning: true });
    expect(exitSearch(back).restore).toEqual(pos);
  });

  it('previews run only while browsing', () => {
    expect(listMode('')).toBe('browse');
    expect(listMode('a')).toBe('search');
    expect(previewAllowed('browse')).toBe(true);
    expect(previewAllowed('search')).toBe(false);
  });
});

describe('okAction', () => {
  it('a channel row that is not playing previews; the playing one goes fullscreen', () => {
    expect(okAction(channelRow(1), 's:2')).toBe('preview');
    expect(okAction(channelRow(1), undefined)).toBe('preview');
    expect(okAction(channelRow(2), 's:2')).toBe('fullscreen');
  });

  it('on-now rows behave like channel rows', () => {
    expect(okAction(onNowRow(1), 's:2')).toBe('preview');
    expect(okAction(onNowRow(2), 's:2')).toBe('fullscreen');
  });

  it('a coming-up row opens the guide, even on the playing channel', () => {
    expect(okAction(laterRow(2), 's:2')).toBe('guide');
  });

  it('headers, notes and missing rows do nothing', () => {
    expect(okAction({ kind: 'header', label: 'Channels' }, undefined)).toBe('none');
    expect(okAction({ kind: 'note', label: 'Guide results are being prepared' }, undefined)).toBe('none');
    expect(okAction(undefined, undefined)).toBe('none');
  });

  it('rowChannelId reads the channel of any selectable row', () => {
    expect(rowChannelId(channelRow(1))).toBe('s:1');
    expect(rowChannelId(onNowRow(2))).toBe('s:2');
    expect(rowChannelId(laterRow(3))).toBe('s:3');
    expect(rowChannelId({ kind: 'header', label: 'On now' })).toBeUndefined();
  });
});

describe('groups column', () => {
  const groups = [
    { id: 'fav', name: 'Favourites', count: 0 },
    { id: 'all', name: 'All channels', count: 200 },
    { id: 'g:News', name: 'News', count: 50 },
  ];

  it('browsing: the groups as they are', () => {
    expect(groupColumn(groups, false, 7, 2)).toEqual({ rows: groups, selected: 2 });
    expect(groupChoice(1, false)).toBe(1);
  });

  it('searching: a highlighted "Search results" entry with the count on top', () => {
    const col = groupColumn(groups, true, 7, 2);
    expect(col.selected).toBe(0);
    expect(col.rows[0]).toEqual({ id: SEARCH_GROUP_ID, name: 'Search results', count: 7 });
    expect(col.rows.slice(1)).toEqual(groups);
  });

  it('searching: choosing the entry does nothing; choosing a group maps past it', () => {
    expect(groupChoice(0, true)).toBeUndefined();
    expect(groupChoice(1, true)).toBe(0);
    expect(groupChoice(3, true)).toBe(2);
  });
});
