import { describe, expect, it, vi } from 'vitest';
import { SliceCache } from './sliceCache.ts';

interface Row { id: string; now?: { stop: number } }
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

  it('keeps at most maxPages pages per group, evicting the least recently requested', async () => {
    const fetch = fakeFetch({ all: rowsOf(1000) });
    const cache = new SliceCache<Row>(fetch, 40, undefined, { maxPages: 3 });
    for (const p of [0, 1, 2, 3]) await cache.ensure('all', p * 40, p * 40 + 1);
    expect(cache.pageCount('all')).toBe(3);
    expect(cache.row('all', 0)).toBeUndefined(); // page 0 was the oldest
    expect(cache.row('all', 120)?.id).toBe('c120');
    // Re-requesting page 1 makes it recent, so page 2 goes next.
    await cache.ensure('all', 40, 41);
    await cache.ensure('all', 200, 201);
    expect(cache.row('all', 40)?.id).toBe('c40');
    expect(cache.row('all', 80)).toBeUndefined();
    // A window spanning several pages keeps all of them.
    await cache.ensure('all', 400, 520);
    expect(cache.pageCount('all')).toBe(3);
    expect(cache.row('all', 400)?.id).toBe('c400');
    expect(cache.row('all', 519)?.id).toBe('c519');
  });

  it('keeps only the current and the previous group', async () => {
    const fetch = fakeFetch({ a: rowsOf(10), b: rowsOf(10), c: rowsOf(10) });
    const cache = new SliceCache<Row>(fetch, 40);
    await cache.ensure('a', 0, 10);
    await cache.ensure('b', 0, 10);
    expect(cache.total('a')).toBe(10);
    await cache.ensure('c', 0, 10);
    expect(cache.total('a')).toBeUndefined();
    expect(cache.total('b')).toBe(10);
    expect(cache.total('c')).toBe(10);
    // Going back to b keeps c as the previous group.
    await cache.ensure('b', 0, 10);
    expect(cache.total('c')).toBe(10);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('ignores an answer for a group that was dropped while in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetch = vi.fn(async (g: string, offset: number, count: number) => {
      if (g === 'a') await gate;
      return { total: 10, rows: rowsOf(10).slice(offset, offset + count) };
    });
    const cache = new SliceCache<Row>(fetch, 40);
    const p = cache.ensure('a', 0, 10);
    await cache.ensure('b', 0, 10);
    await cache.ensure('c', 0, 10);
    release();
    await p;
    expect(cache.total('a')).toBeUndefined();
  });

  it('marks pages stale once a row now-programme has ended since the fetch, and refetches them', async () => {
    let clock = 1_000;
    let stopAt = 2_000;
    const fetch = vi.fn(async (_g: string, offset: number, count: number) => {
      const rows = rowsOf(100).map((r, i) => ({ ...r, now: { stop: i === 50 ? stopAt : 99_999 } }));
      return { total: 100, rows: rows.slice(offset, offset + count) };
    });
    const onChange = vi.fn();
    const cache = new SliceCache<Row>(fetch, 40, onChange, { now: () => clock });
    await cache.ensure('all', 0, 100);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(cache.invalidateStale('all', 0, 100)).toBe(0);
    clock = 2_000; // row 50 (page 1) rolls over
    expect(cache.invalidateStale('all', 0, 30)).toBe(0); // outside the visible window
    stopAt = 5_000;
    expect(cache.invalidateStale('all', 30, 60)).toBe(1);
    // The stale rows stay visible until the fresh page arrives.
    expect(cache.row('all', 50)?.now?.stop).toBe(2_000);
    await cache.ensure('all', 30, 60);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[3]).toEqual(['all', 40, 40]);
    expect(cache.row('all', 50)?.now?.stop).toBe(5_000);
    expect(cache.invalidateStale('all', 0, 100)).toBe(0);
  });

  it('does not refetch forever when the provider still answers with an ended programme', async () => {
    const clock = 10_000;
    const fetch = vi.fn(async () => ({ total: 1, rows: [{ id: 'a', now: { stop: 5_000 } }] }));
    const cache = new SliceCache<Row>(fetch, 40, undefined, { now: () => clock });
    await cache.ensure('all', 0, 1);
    expect(cache.invalidateStale('all', 0, 1)).toBe(0);
    await cache.ensure('all', 0, 1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
