import { describe, expect, it, vi } from 'vitest';
import { SliceCache } from './sliceCache.ts';

interface Row { id: string }
const rowsOf = (total: number): Row[] => Array.from({ length: total }, (_, i) => ({ id: `c${i}` }));

function fakeFetch(data: Record<string, Row[]>) {
  return vi.fn(async (g: string, offset: number, count: number) => {
    const all = data[g] ?? [];
    return { total: all.length, rows: all.slice(offset, offset + count) };
  });
}

describe('SliceCache', () => {
  it('fetches pages of 40 covering a range and caches them per group', async () => {
    const fetch = fakeFetch({ all: rowsOf(200), g1: rowsOf(10) });
    const cache = new SliceCache<Row>(fetch, 40);
    expect(cache.total('all')).toBeUndefined();
    await cache.ensure('all', 0, 10);
    await cache.ensure('all', 30, 50);
    expect(fetch.mock.calls).toEqual([['all', 0, 40], ['all', 40, 40]]);
    expect(cache.total('all')).toBe(200);
    expect(cache.row('all', 45)?.id).toBe('c45');
    await cache.ensure('all', 0, 60);
    expect(fetch).toHaveBeenCalledTimes(2);
    await cache.ensure('g1', 0, 15);
    expect(cache.row('g1', 3)?.id).toBe('c3');
    expect(cache.row('all', 3)?.id).toBe('c3');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('clips to a known total and dedupes in-flight pages', async () => {
    const fetch = fakeFetch({ all: rowsOf(20) });
    const cache = new SliceCache<Row>(fetch, 40);
    await Promise.all([cache.ensure('all', 0, 100), cache.ensure('all', 0, 100)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.total('all')).toBe(20);
    await cache.ensure('all', 0, 100);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('invalidate drops everything and ignores answers that were in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetch = vi.fn(async (_g: string, offset: number, count: number) => {
      await gate;
      return { total: 100, rows: rowsOf(100).slice(offset, offset + count) };
    });
    const onChange = vi.fn();
    const cache = new SliceCache<Row>(fetch, 40, onChange);
    const p = cache.ensure('all', 0, 10);
    cache.invalidate();
    release();
    await p;
    expect(cache.total('all')).toBeUndefined();
    expect(cache.row('all', 0)).toBeUndefined();
    expect(onChange).toHaveBeenCalledTimes(1); // the invalidate itself
  });

  it('finds a cached row index by channel id', async () => {
    const cache = new SliceCache<Row>(fakeFetch({ all: rowsOf(50) }), 40);
    await cache.ensure('all', 0, 40);
    expect(cache.indexOfId('all', 'c12')).toBe(12);
    expect(cache.indexOfId('all', 'c45')).toBe(-1);
  });

  it('reports a failed fetch without caching the page', async () => {
    let fail = true;
    const fetch = vi.fn(async () => {
      if (fail) throw new Error('boom');
      return { total: 1, rows: [{ id: 'a' }] };
    });
    const cache = new SliceCache<Row>(fetch, 40);
    await expect(cache.ensure('all', 0, 1)).rejects.toThrow('boom');
    fail = false;
    await cache.ensure('all', 0, 1);
    expect(cache.row('all', 0)?.id).toBe('a');
  });
});
