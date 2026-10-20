import { describe, expect, test } from 'vitest';
import { TABS, TABS_W, TAB_GAP, TAB_LABELS, TAB_W, kindOfTab, stepTab, tabAt, tabNavigation, tabOfKind, tabParams } from './tabLogic.ts';

describe('tabLogic', () => {
  test('tabs, labels and width', () => {
    expect(TABS).toEqual(['start', 'live', 'movies', 'series']);
    expect(TABS.map((t) => TAB_LABELS[t])).toEqual(['Start', 'Live TV', 'Movies', 'Series']);
    expect(TABS_W).toBe(4 * TAB_W + 3 * TAB_GAP);
  });
  test('stepping clamps at the ends', () => {
    expect(stepTab('live', -1)).toBe('start');
    expect(stepTab('start', -1)).toBe('start');
    expect(stepTab('live', 1)).toBe('movies');
    expect(stepTab('series', 1)).toBe('series');
  });
  test('hit test', () => {
    expect(tabAt(0)).toBe('start');
    expect(tabAt(TAB_W + TAB_GAP)).toBe('live');
    expect(tabAt(TAB_W + 2)).toBeUndefined();
    expect(tabAt(3 * (TAB_W + TAB_GAP))).toBe('series');
    expect(tabAt(TABS_W)).toBeUndefined();
    expect(tabAt(-1)).toBeUndefined();
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
