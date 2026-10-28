import { describe, expect, test } from 'vitest';
import { lruGet, lruSet } from '../src/lru.ts';

describe('lru', () => {
  test('lruSet keeps at most max entries, dropping the least recently used', () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 25; i++) lruSet(m, `k${i}`, i, 20);
    expect(m.size).toBe(20);
    expect(m.has('k4')).toBe(false);
    expect(m.has('k5')).toBe(true);
    expect(m.get('k24')).toBe(24);
  });

  test('setting an existing key makes it the most recent', () => {
    const m = new Map<string, number>();
    lruSet(m, 'a', 1, 2);
    lruSet(m, 'b', 2, 2);
    lruSet(m, 'a', 3, 2);
    lruSet(m, 'c', 4, 2);
    expect([...m.keys()]).toEqual(['a', 'c']);
    expect(m.get('a')).toBe(3);
  });

  test('lruGet returns the kept entry and refreshes it; creates and caps when missing', () => {
    const m = new Map<string, { n: number }>();
    const a = lruGet(m, 'a', () => ({ n: 1 }), 2);
    lruGet(m, 'b', () => ({ n: 2 }), 2);
    expect(lruGet(m, 'a', () => ({ n: 9 }), 2)).toBe(a);
    lruGet(m, 'c', () => ({ n: 3 }), 2);
    expect([...m.keys()]).toEqual(['a', 'c']);
  });
});
