import { describe, expect, test } from 'vitest';
import { TABS, TABS_W, TAB_GAP, TAB_LABELS, TAB_W, kindOfTab, stepTab, tabAt, tabNavigation, tabOfKind } from './tabLogic.ts';

describe('tabLogic', () => {
  test('tabs, labels and width', () => {
    expect(TABS).toEqual(['live', 'movies', 'series']);
    expect(TABS.map((t) => TAB_LABELS[t])).toEqual(['Live TV', 'Movies', 'Series']);
    expect(TABS_W).toBe(3 * TAB_W + 2 * TAB_GAP);
  });
  test('stepping clamps at the ends', () => {
    expect(stepTab('live', 1)).toBe('movies');
    expect(stepTab('movies', 1)).toBe('series');
    expect(stepTab('series', 1)).toBe('series');
    expect(stepTab('series', -1)).toBe('movies');
    expect(stepTab('live', -1)).toBe('live');
  });
  test('hit test', () => {
    expect(tabAt(0)).toBe('live');
    expect(tabAt(TAB_W - 1)).toBe('live');
    expect(tabAt(TAB_W + 2)).toBeUndefined();
    expect(tabAt(TAB_W + TAB_GAP)).toBe('movies');
    expect(tabAt(2 * (TAB_W + TAB_GAP))).toBe('series');
    expect(tabAt(TABS_W - 1)).toBe('series');
    expect(tabAt(2 * TAB_W + TAB_GAP + 2)).toBeUndefined();
    expect(tabAt(-1)).toBeUndefined();
    expect(tabAt(TABS_W)).toBeUndefined();
  });
  test('navigation: Live TV is the screen below, VOD tabs replace each other', () => {
    expect(tabNavigation('live', 'live')).toEqual({ action: 'none' });
    expect(tabNavigation('live', 'movies')).toEqual({ action: 'push', kind: 'movie' });
    expect(tabNavigation('live', 'series')).toEqual({ action: 'push', kind: 'series' });
    expect(tabNavigation('movies', 'series')).toEqual({ action: 'replace', kind: 'series' });
    expect(tabNavigation('series', 'movies')).toEqual({ action: 'replace', kind: 'movie' });
    expect(tabNavigation('movies', 'live')).toEqual({ action: 'back' });
    expect(tabNavigation('series', 'live')).toEqual({ action: 'back' });
    expect(tabNavigation('movies', 'movies')).toEqual({ action: 'none' });
    expect(tabNavigation('series', 'series')).toEqual({ action: 'none' });
  });
  test('tabs and kinds', () => {
    expect(tabOfKind('movie')).toBe('movies');
    expect(tabOfKind('series')).toBe('series');
    expect(kindOfTab('movies')).toBe('movie');
    expect(kindOfTab('series')).toBe('series');
    expect(kindOfTab('live')).toBeUndefined();
  });
});
