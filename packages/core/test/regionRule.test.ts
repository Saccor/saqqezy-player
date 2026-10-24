import { describe, expect, test } from 'vitest';
import { regionRule, sureRegionKeys } from '../src/index/regionRule.ts';
import { applyOps, emptyLayout } from '../src/layout/index.ts';

const ids = ['g:SE A', 'g:DK B', 'g:Mixed', 'g:DK C'];
const keys: Record<string, string[]> = { 'g:SE A': ['SE'], 'g:DK B': ['DK'], 'g:DK C': ['DK'] };

describe('regionRule (shared by the TV index and the phone companion)', () => {
  test('only: chosen, rule-hidden, shown and overrides', () => {
    const l = applyOps(emptyLayout(), [{ op: 'showGroups', ids: ['g:DK C'] }, { op: 'setGroupRegion', id: 'g:Mixed', codes: ['DK'] }]).layout;
    const r = regionRule(ids, l, { keys, codes: ['SE'], mode: 'only' });
    expect([...r.chosen]).toEqual(['g:SE A']);
    expect([...r.ruleHidden].sort()).toEqual(['g:DK B', 'g:Mixed']);
    expect(r.keysOf.get('g:Mixed')).toEqual(['DK']);
    expect(r.state).toEqual({ mode: 'only', requested: 'only', stale: false });
  });

  test('no view, off, or stale: nothing hidden', () => {
    expect(regionRule(ids, emptyLayout(), undefined).ruleHidden.size).toBe(0);
    expect(regionRule(ids, emptyLayout(), { keys, codes: ['SE'], mode: 'off' }).chosen.size).toBe(0);
    const stale = regionRule(ids, emptyLayout(), { keys, codes: ['PL'], mode: 'only' });
    expect(stale.ruleHidden.size).toBe(0);
    expect(stale.state.stale).toBe(true);
  });

  test('rankOf: the index in codes of a group\'s best chosen key; Infinity when not chosen or the rule is off', () => {
    const k: Record<string, string[]> = { ...keys, 'g:Mixed': ['DK', 'SE'] };
    const r = regionRule(ids, emptyLayout(), { keys: k, codes: ['SE', 'DK'], mode: 'first' });
    expect(r.rankOf('g:SE A')).toBe(0);
    expect(r.rankOf('g:DK B')).toBe(1);
    expect(r.rankOf('g:Mixed')).toBe(0);
    expect(r.rankOf('g:Nope')).toBe(Infinity);
    expect(regionRule(ids, emptyLayout(), { keys: k, codes: ['SE'], mode: 'off' }).rankOf('g:SE A')).toBe(Infinity);
    expect(regionRule(ids, emptyLayout(), { keys: k, codes: ['PL'], mode: 'first' }).rankOf('g:SE A')).toBe(Infinity);
    expect(regionRule(ids, emptyLayout(), undefined).rankOf('g:SE A')).toBe(Infinity);
  });

  test('sureRegionKeys keeps sure detections only, as region keys', () => {
    expect(sureRegionKeys({
      a: { countries: ['SE'], langs: ['sv'], conf: 0.95, via: 'code' },
      b: { countries: ['FI'], langs: ['fi'], conf: 0.5, via: 'trailing' },
      c: { countries: [], langs: ['en'], conf: 0.85, via: 'code' },
    })).toEqual({ a: ['SE'], c: ['lang:en'] });
  });
});
