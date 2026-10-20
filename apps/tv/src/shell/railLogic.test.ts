import { describe, expect, test } from 'vitest';
import { STROKE_ICON_KINDS } from '../vod/icons.ts';
import { RAIL_ITEMS, railIcon, railItemAt, railNavigation, railY, stepRail } from './railLogic.ts';

describe('railLogic', () => {
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
  test('every rail icon is a stroke icon', () => {
    for (const id of RAIL_ITEMS) expect(STROKE_ICON_KINDS).toContain(railIcon(id));
  });
});
