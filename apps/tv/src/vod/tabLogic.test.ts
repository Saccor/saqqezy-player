import { describe, expect, test } from 'vitest';
import { TABS, TAB_LABELS, kindOfTab, tabNavigation, tabOfKind, tabParams } from './tabLogic.ts';

describe('tabLogic', () => {
  test('tabs and labels', () => {
    expect(TABS).toEqual(['start', 'live', 'movies', 'series']);
    expect(TABS.map((t) => TAB_LABELS[t])).toEqual(['Start', 'Live TV', 'Movies', 'Series']);
  });
  test('navigation: Live TV is the screen below; Start, Movies and Series replace each other', () => {
    expect(tabNavigation('live', 'live')).toEqual({ action: 'none' });
    expect(tabNavigation('live', 'start')).toEqual({ action: 'push', to: { screen: 'start' } });
    expect(tabNavigation('live', 'movies')).toEqual({ action: 'push', to: { screen: 'vod', kind: 'movie' } });
    expect(tabNavigation('start', 'series')).toEqual({ action: 'replace', to: { screen: 'vod', kind: 'series' } });
    expect(tabNavigation('movies', 'start')).toEqual({ action: 'replace', to: { screen: 'start' } });
    expect(tabNavigation('start', 'live')).toEqual({ action: 'back' });
    expect(tabNavigation('series', 'live')).toEqual({ action: 'back' });
    expect(tabParams({ screen: 'vod', kind: 'movie' })).toEqual({ kind: 'movie', focus: 'rail' });
    expect(tabParams({ screen: 'start' })).toEqual({ focus: 'rail' });
  });
  test('tabs and kinds', () => {
    expect(tabOfKind('movie')).toBe('movies');
    expect(tabOfKind('series')).toBe('series');
    expect(kindOfTab('movies')).toBe('movie');
    expect(kindOfTab('series')).toBe('series');
    expect(kindOfTab('live')).toBeUndefined();
    expect(kindOfTab('start')).toBeUndefined();
  });
});
