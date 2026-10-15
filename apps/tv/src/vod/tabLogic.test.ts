import { describe, expect, test } from 'vitest';
import { TABS, TABS_W, TAB_GAP, TAB_W, stepTab, tabAt, tabNavigation } from './tabLogic.ts';

describe('tabLogic', () => {
  test('tabs and width', () => {
    expect(TABS).toEqual(['live', 'movies']);
    expect(TABS_W).toBe(2 * TAB_W + TAB_GAP);
  });
  test('stepping clamps at the ends', () => {
    expect(stepTab('live', 1)).toBe('movies');
    expect(stepTab('movies', 1)).toBe('movies');
    expect(stepTab('live', -1)).toBe('live');
  });
  test('hit test', () => {
    expect(tabAt(0)).toBe('live');
    expect(tabAt(TAB_W - 1)).toBe('live');
    expect(tabAt(TAB_W + 2)).toBeUndefined();
    expect(tabAt(TAB_W + TAB_GAP)).toBe('movies');
    expect(tabAt(-1)).toBeUndefined();
    expect(tabAt(TABS_W + 1)).toBeUndefined();
  });
  test('navigation: Live TV is the screen below', () => {
    expect(tabNavigation('live', 'live')).toEqual({ action: 'none' });
    expect(tabNavigation('live', 'movies')).toEqual({ action: 'push', kind: 'movie' });
    expect(tabNavigation('movies', 'live')).toEqual({ action: 'back' });
    expect(tabNavigation('movies', 'movies')).toEqual({ action: 'none' });
  });
});
