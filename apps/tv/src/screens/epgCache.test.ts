import { describe, expect, it, vi } from 'vitest';
import { EpgCache } from './epgCache.ts';

const H = 3_600_000;
const CHUNK = 3 * H;
const B = 1000 * CHUNK; // an aligned chunk start

interface Ch { id: string }
interface Prog { title: string; start: number; stop: number }

/** `total` channels with half-hour slots everywhere; programmes overlapping [from, to) are returned. */
function fakeFetch(total: number, empty: ReadonlySet<number> = new Set()) {
  return vi.fn(async (_g: string, offset: number, count: number, from: number, to: number) => {
    const rows = [];
    for (let i = offset; i < Math.min(total, offset + count); i++) {
      const programmes: Prog[] = [];
      if (!empty.has(i)) for (let t = from; t < to; t += H / 2) programmes.push({ title: `c${i}@${t}`, start: t, stop: t + H / 2 });
      rows.push({ channel: { id: `c${i}` }, programmes });
    }
    return { total, rows };
  });
}

describe('EpgCache', () => {
  it('skips the page-0 round trip when the total is known', async () => {
    const fetch = fakeFetch(45);
    const cache = new EpgCache<Ch, Prog>(fetch, { rowsPerPage: 20, chunkMs: CHUNK });
    cache.setGroup('all', 45);
    expect(cache.total()).toBe(45);
    await cache.ensure(25, 30, B, B + CHUNK);
    expect(fetch.mock.calls).toEqual([['all', 20, 20, B, B + CHUNK]]);
  });

  it('fetches pages of 20 channels per aligned time chunk and serves rows from them', async () => {
    const fetch = fakeFetch(45);
    const cache = new EpgCache<Ch, Prog>(fetch, { rowsPerPage: 20, chunkMs: CHUNK });
    cache.setGroup('all');
    expect(cache.total()).toBeUndefined();
    await cache.ensure(0, 12, B + H, B + 4 * H);
    expect(fetch.mock.calls).toEqual([['all', 0, 20, B, B + CHUNK], ['all', 0, 20, B + CHUNK, B + 2 * CHUNK]]);
    expect(cache.total()).toBe(45);
    expect(cache.channel(3)?.id).toBe('c3');
    expect(cache.programmes(3)).toHaveLength(12);
    expect(cache.covered(3)).toEqual([{ start: B, end: B + CHUNK }, { start: B + CHUNK, end: B + 2 * CHUNK }]);
    await cache.ensure(0, 12, B, B + 6 * H);
    expect(fetch).toHaveBeenCalledTimes(2);
    await cache.ensure(15, 27, B, B + CHUNK);
    expect(fetch.mock.calls[2]).toEqual(['all', 20, 20, B, B + CHUNK]);
    expect(cache.channel(25)?.id).toBe('c25');
    expect(cache.channel(44)).toBeUndefined();
  });

  it('merges programmes that appear in two chunks once, in start order', async () => {
    const fetch = vi.fn(async (_g: string, _o: number, _c: number, from: number) => ({
      total: 1,
      rows: [{ channel: { id: 'c0' }, programmes: from === B ? [{ title: 'x', start: B + 2 * H, stop: B + 4 * H }]
        : [{ title: 'y', start: B + 4 * H, stop: B + 5 * H }, { title: 'x', start: B + 2 * H, stop: B + 4 * H }] }],
    }));
    const cache = new EpgCache<Ch, Prog>(fetch, { rowsPerPage: 20, chunkMs: CHUNK });
    cache.setGroup('g');
    await cache.ensure(0, 1, B, B + 6 * H);
    expect(cache.programmes(0).map((p) => p.title)).toEqual(['x', 'y']);
  });

  it('shares an in-flight request and keeps at most maxEntries pages (least recently used dropped)', async () => {
    const fetch = fakeFetch(200);
    const cache = new EpgCache<Ch, Prog>(fetch, { rowsPerPage: 20, chunkMs: CHUNK, maxEntries: 3 });
    cache.setGroup('all');
    await Promise.all([cache.ensure(0, 5, B, B + H), cache.ensure(0, 5, B, B + H)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await cache.ensure(20, 25, B, B + H);
    await cache.ensure(40, 45, B, B + H);
    await cache.ensure(0, 5, B, B + H); // touches page 0
    await cache.ensure(60, 65, B, B + H); // evicts page 1 (least recent)
    expect(cache.entryCount()).toBe(3);
    expect(cache.channel(25)).toBeUndefined();
    expect(cache.channel(3)?.id).toBe('c3');
    expect(cache.channel(63)?.id).toBe('c63');
  });

  it('drops everything on a group change and ignores answers for the old group', async () => {
    let release: () => void = () => undefined;
    const fetch = vi.fn((g: string, offset: number, count: number, from: number, to: number) =>
      g === 'old'
        ? new Promise<{ total: number; rows: { channel: Ch; programmes: Prog[] }[] }>((res) => {
          release = () => res({ total: 5, rows: [{ channel: { id: 'stale' }, programmes: [] }] });
        })
        : fakeFetch(3)(g, offset, count, from, to));
    const onChange = vi.fn();
    const cache = new EpgCache<Ch, Prog>(fetch, { rowsPerPage: 20, chunkMs: CHUNK, onChange });
    cache.setGroup('old');
    const pending = cache.ensure(0, 5, B, B + H);
    cache.setGroup('new');
    await cache.ensure(0, 5, B, B + H);
    release();
    await pending;
    expect(cache.group()).toBe('new');
    expect(cache.total()).toBe(3);
    expect(cache.channel(0)?.id).toBe('c0');
  });

  it('refetches a page once it is older than maxAgeMs, keeping the old data until then', async () => {
    let clock = 0;
    const fetch = fakeFetch(5);
    const cache = new EpgCache<Ch, Prog>(fetch, { rowsPerPage: 20, chunkMs: CHUNK, maxAgeMs: 600_000, now: () => clock });
    cache.setGroup('all');
    await cache.ensure(0, 5, B, B + H);
    clock = 599_999;
    await cache.ensure(0, 5, B, B + H);
    expect(fetch).toHaveBeenCalledTimes(1);
    clock = 600_000;
    const again = cache.ensure(0, 5, B, B + H);
    expect(cache.channel(0)?.id).toBe('c0');
    await again;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('invalidate() empties the cache and ignores answers still in flight', async () => {
    const fetch = fakeFetch(5, new Set([1]));
    const cache = new EpgCache<Ch, Prog>(fetch, { rowsPerPage: 20, chunkMs: CHUNK });
    cache.setGroup('all');
    await cache.ensure(0, 5, B, B + H);
    expect(cache.programmes(1)).toEqual([]);
    expect(cache.covered(1)).toEqual([{ start: B, end: B + CHUNK }]);
    const pending = cache.ensure(0, 5, B + CHUNK, B + CHUNK + H);
    cache.invalidate();
    await pending;
    expect(cache.total()).toBeUndefined();
    expect(cache.entryCount()).toBe(0);
    expect(cache.group()).toBe('all');
  });
});

describe('EpgCache stale marks', () => {
  it('staleChannels marks every cached page holding one of the ids, on screen or not; rows stay readable', async () => {
    const fetch = fakeFetch(45);
    const cache = new EpgCache<Ch, Prog>(fetch, { rowsPerPage: 20, chunkMs: CHUNK });
    cache.setGroup('all', 45);
    await cache.ensure(0, 45, B, B + CHUNK);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(cache.staleChannels(['c25', 'nope'], (c) => c.id)).toBe(1);
    expect(cache.channel(25)?.id).toBe('c25');
    await cache.ensure(0, 45, B, B + CHUNK);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[3]).toEqual(['all', 20, 20, B, B + CHUNK]);
    expect(cache.staleChannels([], (c) => c.id)).toBe(0);
  });

  it('staleAll keeps the group, its total and its rows, and refetches on the next ensure', async () => {
    const fetch = fakeFetch(45);
    const cache = new EpgCache<Ch, Prog>(fetch, { rowsPerPage: 20, chunkMs: CHUNK });
    cache.setGroup('all', 45);
    await cache.ensure(0, 12, B, B + CHUNK);
    cache.staleAll();
    expect(cache.total()).toBe(45);
    expect(cache.channel(3)?.id).toBe('c3');
    await cache.ensure(0, 12, B, B + CHUNK);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
