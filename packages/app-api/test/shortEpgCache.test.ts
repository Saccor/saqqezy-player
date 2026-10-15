import { describe, expect, it } from 'vitest';
import type { Programme } from '@iptv/core';
import { SHORT_EPG_EMPTY_TTL_MS, ShortEpgCache, shortEpgUntil } from '../src/shortEpgCache.ts';

const T = Date.UTC(2026, 9, 15, 20, 0);
const MIN = 60_000;
const prog = (start: number, stop: number): Programme => ({ epgId: 'syn.test', title: 'Synthetic Show', start, stop });

describe('shortEpgUntil', () => {
  it('keeps an answer until the programme on now ends', () => {
    expect(shortEpgUntil({ now: prog(T - 10 * MIN, T + 20 * MIN), next: prog(T + 20 * MIN, T + 50 * MIN) }, T)).toBe(T + 20 * MIN);
  });

  it('without a programme on now: until the next one starts, at most 15 min', () => {
    expect(shortEpgUntil({ next: prog(T + 5 * MIN, T + 30 * MIN) }, T)).toBe(T + 5 * MIN);
    expect(shortEpgUntil({ next: prog(T + 60 * MIN, T + 90 * MIN) }, T)).toBe(T + SHORT_EPG_EMPTY_TTL_MS);
  });

  it('nothing found: 15 min', () => {
    expect(SHORT_EPG_EMPTY_TTL_MS).toBe(15 * MIN);
    expect(shortEpgUntil({}, T)).toBe(T + 15 * MIN);
  });
});

describe('ShortEpgCache', () => {
  it('returns an answer until it expires, empty answers included', () => {
    const c = new ShortEpgCache();
    const p = [prog(T, T + 30 * MIN)];
    c.set('src1', 'ch1', p, T + 30 * MIN);
    c.set('src1', 'ch2', [], T + 15 * MIN);
    expect(c.get('src1', 'ch1', T + 29 * MIN)).toEqual(p);
    expect(c.get('src1', 'ch1', T + 30 * MIN)).toBeUndefined();
    expect(c.get('src1', 'ch2', T)).toEqual([]);
    expect(c.get('src1', 'ch3', T)).toBeUndefined();
    expect(c.get('src2', 'ch1', T)).toBeUndefined();
  });

  it('dropSource forgets that source only', () => {
    const c = new ShortEpgCache();
    c.set('src1', 'ch1', [], T + MIN);
    c.set('src2', 'ch1', [], T + MIN);
    c.dropSource('src1');
    expect(c.get('src1', 'ch1', T)).toBeUndefined();
    expect(c.get('src2', 'ch1', T)).toEqual([]);
  });

  it('keeps at most 500 answers per source, dropping the oldest', () => {
    const c = new ShortEpgCache();
    for (let i = 0; i <= 500; i++) c.set('src1', `ch${i}`, [], T + MIN);
    expect(c.get('src1', 'ch0', T)).toBeUndefined();
    expect(c.get('src1', 'ch1', T)).toEqual([]);
    expect(c.get('src1', 'ch500', T)).toEqual([]);
  });
});
