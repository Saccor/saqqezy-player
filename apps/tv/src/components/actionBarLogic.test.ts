import { describe, expect, it } from 'vitest';
import { selectedIndex } from './actionBarLogic.ts';

const list = (...ids: string[]) => ids.map((id) => ({ id }));

describe('selectedIndex', () => {
  it('keeps the selected action when the list grows around it', () => {
    // A resume point loads late: [Play, Fav] becomes [Resume (id play), Play from start, Fav].
    expect(selectedIndex(list('play', 'start', 'fav'), 'fav', 1)).toBe(2);
    expect(selectedIndex(list('play', 'start', 'fav'), 'play', 0)).toBe(0);
  });
  it('clamps the last index when the selected id is gone', () => {
    expect(selectedIndex(list('nextNow', 'cancel'), 'retry', 0)).toBe(0);
    expect(selectedIndex(list('a', 'b'), 'gone', 5)).toBe(1);
    expect(selectedIndex(list('a', 'b', 'c'), undefined, 1)).toBe(1);
  });
  it('is 0 for an empty list', () => {
    expect(selectedIndex([], 'a', 3)).toBe(0);
  });
});
