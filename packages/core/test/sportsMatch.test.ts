import { describe, expect, test } from 'vitest';
import { foldText, jaroWinkler, normSide, resolveAlias, sideMatch } from '../src/sports/match.ts';

describe('sports match', () => {
  test('foldText strips accents and case', () => {
    expect(foldText('Éastport ÅÄÖ')).toBe('eastport aao');
  });
  test('normSide drops club tokens, maps abbreviations, collapses space', () => {
    expect(normSide('  Northbridge FC ')).toBe('northbridge');
    expect(normSide('AFC Harbour City')).toBe('harbour city');
    expect(normSide('Westvale Utd')).toBe('westvale united');
    expect(normSide('St. Kingsgate')).toBe('saint kingsgate');
    expect(normSide('Lake & Shore')).toBe('lake and shore');
    expect(normSide('1. FC Pinecrest')).toBe('pinecrest');
    expect(normSide('Rivermouth-Rovers')).toBe('rivermouth rovers');
  });
  test('jaroWinkler: identical 1, disjoint 0, close names high', () => {
    expect(jaroWinkler('eastport', 'eastport')).toBe(1);
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
    expect(jaroWinkler('westvale united', 'westvale utd')).toBeGreaterThan(0.85);
    expect(jaroWinkler('northbridge', 'eastport')).toBeLessThan(0.7);
    expect(jaroWinkler('', 'a')).toBe(0);
  });
  test('sideMatch', () => {
    expect(sideMatch('eastport', 'eastport')).toBe('exact');
    expect(sideMatch('westvale united', 'westvale untied')).toBe('fuzzy');
    expect(sideMatch('northbridge', 'eastport')).toBeUndefined();
    expect(sideMatch('', '')).toBeUndefined();
    expect(sideMatch('', 'eastport')).toBeUndefined();
    expect(normSide('FC')).toBe('');
  });
  test('resolveAlias follows one step', () => {
    const aliases = new Map([['man b', 'manor bridge']]);
    expect(resolveAlias('man b', aliases)).toBe('manor bridge');
    expect(resolveAlias('other', aliases)).toBe('other');
  });
});
