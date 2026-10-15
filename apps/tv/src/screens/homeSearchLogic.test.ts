// apps/tv/src/screens/homeSearchLogic.test.ts
import type { ChannelRow } from '@iptv/app-api';
import { describe, expect, it } from 'vitest';
import { COMPACT_LAYOUT } from '../components/keyboardLogic.ts';
import {
  BAR_PLACEHOLDER, BROWSE, HOME_GROUP_W, SEARCH_GROUP_ID, SEARCH_MAX_LENGTH, capQuery, exitFocusTarget, resultsFocusLost, SEARCH_GROUP_NAME, SEARCH_HINT, applyQuery, exitSearch,
  groupChoice, groupColumn, isSearching, leaveTo, listMode, okAction, previewAllowed, restoreOnMount, rowChannelId,
  userNavigated, routeKey, typedQuery, typingKey, HOME_POINTER_LABELS, KEYBOARD_BUTTON_LABEL, rowPointerAction,
  type BrowsePosition, type NavContext,
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
    // Ok again while that row's preview is still being fetched: fullscreen, not a restarted request.
    expect(okAction(channelRow(3), 's:2', 's:3')).toBe('fullscreen');
    expect(okAction(onNowRow(3), undefined, 's:3')).toBe('fullscreen');
    expect(okAction(channelRow(1), 's:2', 's:3')).toBe('preview');
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

const ctx = (over: Partial<NavContext> = {}): NavContext =>
  ({ searching: false, keyboardOpen: false, hasResults: false, hasChannels: true, atEdge: false, ...over });
const toBar = { kind: 'focus', place: 'bar' };
const toList = { kind: 'focus', place: 'list' };
const STAY = { kind: 'stay' };
const PASS = { kind: 'pass' };

describe('routeKey', () => {
  it('Up from the first channel row, the first result or the first group goes to the bar', () => {
    expect(routeKey('list', 'up', ctx({ atEdge: true }))).toEqual(toBar);
    expect(routeKey('list', 'up', ctx({ atEdge: true, searching: true, hasResults: true }))).toEqual(toBar);
    expect(routeKey('groups', 'up', ctx({ atEdge: true }))).toEqual(toBar);
    expect(routeKey('groups', 'up', ctx({ atEdge: true, searching: true }))).toEqual(toBar);
  });

  it('Up elsewhere in the list or the groups keeps its usual move', () => {
    expect(routeKey('list', 'up', ctx())).toEqual(PASS);
    expect(routeKey('groups', 'up', ctx())).toEqual(PASS);
    expect(routeKey('list', 'down', ctx({ searching: true, hasResults: true }))).toEqual(PASS);
  });

  it('bar: Down goes to the results while searching, else to the channel list', () => {
    expect(routeKey('bar', 'down', ctx({ searching: true, hasResults: true }))).toEqual(toList);
    expect(routeKey('bar', 'down', ctx({ searching: true, hasResults: false }))).toEqual(STAY);
    expect(routeKey('bar', 'down', ctx())).toEqual(toList);
    expect(routeKey('bar', 'down', ctx({ hasChannels: false }))).toEqual(STAY);
  });

  it('bar: Left goes to the groups, or to the keyboard while it is open', () => {
    expect(routeKey('bar', 'left', ctx())).toEqual({ kind: 'focus', place: 'groups' });
    expect(routeKey('bar', 'left', ctx({ searching: true, keyboardOpen: true }))).toEqual({ kind: 'focus', place: 'keyboard' });
  });

  it('bar: Back ends search mode; with no query it is Home Back as today', () => {
    expect(routeKey('bar', 'back', ctx({ searching: true }))).toEqual({ kind: 'exit', focus: 'list' });
    expect(routeKey('bar', 'back', ctx())).toEqual(PASS);
  });

  it('list: Left goes to the open keyboard, never to the groups hidden under it (also while browsing)', () => {
    expect(routeKey('list', 'left', ctx({ keyboardOpen: true }))).toEqual({ kind: 'focus', place: 'keyboard' });
    expect(routeKey('list', 'left', ctx({ keyboardOpen: true, searching: true, hasResults: true })))
      .toEqual({ kind: 'focus', place: 'keyboard' });
    expect(routeKey('list', 'left', ctx())).toEqual(PASS);
  });

  it('bar: Up while searching and Right stay', () => {
    expect(routeKey('bar', 'up', ctx({ searching: true }))).toEqual(STAY);
    expect(routeKey('bar', 'right', ctx({ searching: true }))).toEqual(STAY);
  });

  it('Up from the search bar reaches the tab bar (not while searching); Down from the tabs returns to the bar', () => {
    const c = { searching: false, keyboardOpen: false, hasResults: false, hasChannels: true, atEdge: false };
    expect(routeKey('bar', 'up', c)).toEqual({ kind: 'focus', place: 'tabs' });
    expect(routeKey('bar', 'up', { ...c, searching: true })).toEqual({ kind: 'stay' });
    expect(routeKey('tabs', 'down', c)).toEqual({ kind: 'focus', place: 'bar' });
    expect(routeKey('tabs', 'left', c)).toEqual({ kind: 'pass' });
    expect(routeKey('tabs', 'up', c)).toEqual({ kind: 'pass' });
    expect(routeKey('tabs', 'right', c)).toEqual({ kind: 'pass' });
    expect(routeKey('tabs', 'back', c)).toEqual({ kind: 'pass' });
  });

  it('Up from the bar stays put while the compact keyboard is open, even with an empty bar', () => {
    const c = { searching: false, keyboardOpen: true, hasResults: false, hasChannels: true, atEdge: false };
    expect(routeKey('bar', 'up', c)).toEqual({ kind: 'stay' });
  });

  it('results: Left goes to the keyboard when it is open, else to the groups', () => {
    expect(routeKey('list', 'left', ctx({ searching: true, keyboardOpen: true }))).toEqual({ kind: 'focus', place: 'keyboard' });
    expect(routeKey('list', 'left', ctx({ searching: true }))).toEqual({ kind: 'focus', place: 'groups' });
    expect(routeKey('list', 'left', ctx())).toEqual(PASS);
  });

  it('results: Back ends search mode once the keyboard is closed', () => {
    expect(routeKey('list', 'back', ctx({ searching: true }))).toEqual({ kind: 'exit', focus: 'list' });
    expect(routeKey('list', 'back', ctx({ searching: true, keyboardOpen: true }))).toEqual(PASS);
    expect(routeKey('list', 'back', ctx())).toEqual(PASS);
  });

  it('groups: Back while searching goes to the results, or ends search when there are none', () => {
    expect(routeKey('groups', 'back', ctx({ searching: true, hasResults: true }))).toEqual(toList);
    expect(routeKey('groups', 'back', ctx({ searching: true }))).toEqual({ kind: 'exit', focus: 'list' });
    expect(routeKey('groups', 'back', ctx())).toEqual(PASS);
  });

  it('keyboard: Right at the edge goes to the results (when any), Up at the top row to the bar', () => {
    expect(routeKey('keyboard', 'right', ctx({ searching: true, hasResults: true, atEdge: true }))).toEqual(toList);
    expect(routeKey('keyboard', 'right', ctx({ atEdge: true }))).toEqual(STAY);
    expect(routeKey('keyboard', 'right', ctx({ hasResults: true }))).toEqual(PASS);
    expect(routeKey('keyboard', 'up', ctx({ atEdge: true }))).toEqual(toBar);
    expect(routeKey('keyboard', 'up', ctx())).toEqual(PASS);
  });

  it('keyboard: Done goes to the results, or to the bar when there are none', () => {
    expect(routeKey('keyboard', 'done', ctx({ searching: true, hasResults: true }))).toEqual(toList);
    expect(routeKey('keyboard', 'done', ctx({ searching: true }))).toEqual(toBar);
    expect(routeKey('keyboard', 'done', ctx())).toEqual(toBar);
  });
});

describe('typingKey (hardware keys on Home)', () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
    ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });
  const away = { overlayOpen: false, barFocused: false, query: '' };
  const inBar = { overlayOpen: false, barFocused: true, query: 'ab' };

  it('letters start a query from anywhere on Home, m and i included', () => {
    for (const k of ['a', 'Z', 'm', 'i', 'å']) expect(typingKey(key(k), away)).toEqual({ kind: 'char', ch: k });
  });

  it('digits, space and symbols type only while the bar has focus (digits keep their remote meaning)', () => {
    for (const k of ['5', ' ', '-', '@']) {
      expect(typingKey(key(k), away)).toBeUndefined();
      expect(typingKey(key(k), inBar)).toEqual({ kind: 'char', ch: k });
    }
  });

  it('Backspace always belongs to the focused bar (a held key never runs on into Back); elsewhere it stays Back', () => {
    expect(typingKey(key('Backspace'), inBar)).toEqual({ kind: 'backspace' });
    expect(typingKey(key('Backspace'), { ...inBar, query: '' })).toEqual({ kind: 'backspace' });
    expect(typedQuery('', { kind: 'backspace' })).toBe('');
    expect(typingKey(key('Backspace'), { ...away, query: 'ab' })).toBeUndefined();
    expect(typingKey(key('Escape'), { ...inBar, query: '' })).toBeUndefined();
  });

  it('nothing types while an overlay is open', () => {
    expect(typingKey(key('a'), { ...away, overlayOpen: true })).toBeUndefined();
    expect(typingKey(key('5'), { ...inBar, overlayOpen: true })).toBeUndefined();
    expect(typingKey(key('Backspace'), { ...inBar, overlayOpen: true })).toBeUndefined();
  });

  it('navigation keys and shortcuts are never typed', () => {
    for (const k of ['ArrowUp', 'Enter', 'Escape', 'F3']) expect(typingKey(key(k), inBar)).toBeUndefined();
    expect(typingKey(key('v', { ctrlKey: true }), inBar)).toBeUndefined();
  });

  it('typedQuery appends a character or deletes the last one', () => {
    expect(typedQuery('ab', { kind: 'char', ch: 'c' })).toBe('abc');
    expect(typedQuery('ab', { kind: 'backspace' })).toBe('a');
    expect(typedQuery('', { kind: 'backspace' })).toBe('');
  });
});

describe('query length cap', () => {
  it('every input path keeps the query within SEARCH_MAX_LENGTH', () => {
    expect(SEARCH_MAX_LENGTH).toBe(100);
    const full = 'a'.repeat(SEARCH_MAX_LENGTH);
    expect(capQuery(full + 'bcd')).toBe(full);
    expect(capQuery('abc')).toBe('abc');
    expect(typedQuery(full, { kind: 'char', ch: 'z' })).toBe(full);
    expect(typedQuery(full, { kind: 'backspace' })).toBe('a'.repeat(SEARCH_MAX_LENGTH - 1));
  });
});

describe('focus after leaving search mode', () => {
  it('the list takes focus only when the restored group has channels; otherwise the groups', () => {
    expect(exitFocusTarget('list', 5)).toBe('list');
    expect(exitFocusTarget('list', 0)).toBe('groups');
    expect(exitFocusTarget('bar', 0)).toBe('bar');
    expect(exitFocusTarget('groups', 0)).toBe('groups');
    expect(exitFocusTarget('keyboard', 0)).toBe('keyboard');
  });
});

describe('results losing their rows', () => {
  const base = { area: 'list' as const, searching: true, hasResults: false, keyboardOpen: false };
  it('focus on empty results moves to the keyboard when it is open, else to the bar', () => {
    expect(resultsFocusLost(base)).toBe('bar');
    expect(resultsFocusLost({ ...base, keyboardOpen: true })).toBe('keyboard');
  });
  it('nothing moves while results remain, focus is elsewhere, or search mode is off', () => {
    expect(resultsFocusLost({ ...base, hasResults: true })).toBeUndefined();
    expect(resultsFocusLost({ ...base, area: 'bar' })).toBeUndefined();
    expect(resultsFocusLost({ ...base, searching: false })).toBeUndefined();
  });
});

describe('pointer on Home rows', () => {
  it('hover never acts: no preview, no fullscreen', () => {
    expect(rowPointerAction('hover', channelRow(1), undefined)).toBe('none');
    expect(rowPointerAction('hover', channelRow(1), 's:1')).toBe('none');
    expect(rowPointerAction('hover', laterRow(1), undefined)).toBe('none');
  });

  it('a click plays a channel that is not playing in the small video, and the playing one fullscreen', () => {
    expect(rowPointerAction('click', channelRow(1), 's:2')).toBe('preview');
    expect(rowPointerAction('click', onNowRow(1), undefined)).toBe('preview');
    expect(rowPointerAction('click', channelRow(1), 's:1')).toBe('fullscreen');
    expect(rowPointerAction('click', channelRow(1), 's:2', 's:1')).toBe('fullscreen'); // its preview is still loading
  });

  it('a double click goes fullscreen on any channel row', () => {
    expect(rowPointerAction('doubleClick', channelRow(1), 's:2')).toBe('fullscreen');
    expect(rowPointerAction('doubleClick', onNowRow(3), undefined)).toBe('fullscreen');
  });

  it('a coming-up row opens the Guide; headers do nothing', () => {
    expect(rowPointerAction('click', laterRow(1), 's:1')).toBe('guide');
    expect(rowPointerAction('doubleClick', laterRow(1), undefined)).toBe('guide');
    expect(rowPointerAction('click', { kind: 'header', label: 'Channels' }, undefined)).toBe('none');
    expect(rowPointerAction('click', undefined, undefined)).toBe('none');
  });

  it('uses the spec copy', () => {
    expect(HOME_POINTER_LABELS).toEqual({ search: '⌕ Search', guide: '▦ Guide', settings: '⚙ Settings' });
    expect(KEYBOARD_BUTTON_LABEL).toBe('⌨');
  });
});
