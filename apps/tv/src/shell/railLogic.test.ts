import { describe, expect, test } from 'vitest';
import { STROKE_ICON_KINDS } from '../vod/icons.ts';
import { belowTab, onRailClose, RAIL_CLOSE, RAIL_ITEMS, railFromNested, railIcon, railItemAt, railNavigation, railY, stepRail } from './railLogic.ts';

describe('railLogic', () => {
  test('the close button sits in the open panel top-right corner, clear of the items', () => {
    expect(RAIL_CLOSE.x + RAIL_CLOSE.size).toBe(296);
    expect(onRailClose(RAIL_CLOSE.x + 1, RAIL_CLOSE.y + 1)).toBe(true);
    expect(onRailClose(RAIL_CLOSE.x - 1, RAIL_CLOSE.y + 1)).toBe(false);
    expect(onRailClose(RAIL_CLOSE.x + 1, RAIL_CLOSE.y + RAIL_CLOSE.size)).toBe(false);
    expect(RAIL_CLOSE.y + RAIL_CLOSE.size).toBeLessThan(railY('start') - 15);
  });
  test('items stack from y 260, 78 apart, with Settings at the bottom', () => {
    expect(RAIL_ITEMS).toEqual(['start', 'live', 'movies', 'series', 'search', 'settings']);
    expect(railY('start')).toBe(260);
    expect(railY('live')).toBe(338);
    expect(railY('search')).toBe(572);
    expect(railY('settings')).toBe(922);
  });
  test('hit testing covers each 64 px row around its icon', () => {
    expect(railItemAt(250)).toBe('start');
    expect(railItemAt(300)).toBe('start');
    expect(railItemAt(330)).toBe('live');
    expect(railItemAt(100)).toBeUndefined();
    expect(railItemAt(700)).toBeUndefined();
    expect(railItemAt(930)).toBe('settings');
  });
  test('steps clamp at both ends', () => {
    expect(stepRail('start', -1)).toBe('start');
    expect(stepRail('start', 1)).toBe('live');
    expect(stepRail('search', 1)).toBe('settings');
    expect(stepRail('settings', 1)).toBe('settings');
  });
  test('navigation: tabs as before, Search and Settings pushed', () => {
    expect(railNavigation('movies', 'search')).toEqual({ action: 'pushScreen', screen: 'search' });
    expect(railNavigation('live', 'settings')).toEqual({ action: 'pushScreen', screen: 'settings' });
    expect(railNavigation('start', 'movies')).toEqual({ action: 'replace', to: { screen: 'vod', kind: 'movie' } });
    expect(railNavigation('movies', 'live')).toEqual({ action: 'back' });
    expect(railNavigation('live', 'start')).toEqual({ action: 'push', to: { screen: 'start' } });
    expect(railNavigation('series', 'series')).toEqual({ action: 'none' });
  });
  test('a nested screen (the library grid) knows the tab of the screen below it', () => {
    expect(belowTab('vod', 'series', 'movie')).toBe('series');
    expect(belowTab('vod', undefined, 'movie')).toBe('movies');
    expect(belowTab('start', undefined, 'series')).toBe('start');
    expect(belowTab('home', undefined, 'movie')).toBe('live');
    expect(belowTab(undefined, undefined, 'series')).toBe('series');
  });
  test('from a nested screen: Search and Settings push; tabs pop it first, then move as the screen below would', () => {
    expect(railFromNested('movies', 'series')).toEqual([{ action: 'pop' }, { action: 'replace', to: { screen: 'vod', kind: 'series' } }]);
    expect(railFromNested('movies', 'live')).toEqual([{ action: 'pop' }, { action: 'back' }]);
    expect(railFromNested('movies', 'start')).toEqual([{ action: 'pop' }, { action: 'replace', to: { screen: 'start' } }]);
    expect(railFromNested('movies', 'movies')).toEqual([{ action: 'pop' }]);
    expect(railFromNested('movies', 'search')).toEqual([{ action: 'pushScreen', screen: 'search' }]);
    expect(railFromNested('start', 'movies')).toEqual([{ action: 'pop' }, { action: 'replace', to: { screen: 'vod', kind: 'movie' } }]);
    expect(railFromNested('start', 'live')).toEqual([{ action: 'pop' }, { action: 'back' }]);
    expect(railFromNested('start', 'settings')).toEqual([{ action: 'pushScreen', screen: 'settings' }]);
  });
  test('every rail icon is a stroke icon', () => {
    for (const id of RAIL_ITEMS) expect(STROKE_ICON_KINDS).toContain(railIcon(id));
  });
});
