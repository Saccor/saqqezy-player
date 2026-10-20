import { describe, expect, it } from 'vitest';
import type { LiveSourceView } from '@iptv/app-api';
import { canFailOver, MAX_FAILOVERS, nextSource } from './failover.ts';

const s = (id: string, blocked = false): LiveSourceView => ({ id, label: id, bad: blocked, blocked });

describe('failover', () => {
  it('only stream-level failures fail over; a refusal is about the account', () => {
    expect(canFailOver('unavailable')).toBe(true);
    expect(canFailOver('gone')).toBe(true);
    expect(canFailOver('unsupported')).toBe(true);
    expect(canFailOver('refused')).toBe(false);
  });
  it('the next source: in order, not tried, not blocked', () => {
    const list = [s('a'), s('b', true), s('c'), s('d')];
    expect(nextSource(list, new Set(['a']), 0)).toBe('c');
    expect(nextSource(list, new Set(['a', 'c']), 1)).toBe('d');
    expect(nextSource(list, new Set(['a', 'c', 'd']), 1)).toBeUndefined();
  });
  it('stops after MAX_FAILOVERS', () => {
    expect(MAX_FAILOVERS).toBe(2);
    expect(nextSource([s('a'), s('b'), s('c'), s('d')], new Set(['a', 'b', 'c']), 2)).toBeUndefined();
  });
  it('no sources, no failover', () => {
    expect(nextSource(undefined, new Set(['a']), 0)).toBeUndefined();
  });
});
