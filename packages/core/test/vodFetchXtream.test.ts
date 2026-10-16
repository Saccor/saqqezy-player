import { describe, expect, test } from 'vitest';
import { fetchXtreamCatalog, VodFetchCancelled, type XtreamVodApi } from '../src/vod/fetchXtream.ts';
import { VOD_UNCATEGORIZED, type VodCategory, type VodItem } from '../src/vod/types.ts';

const cats = (n: number): VodCategory[] => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), kind: 'movie', name: `Cat ${i + 1}`, count: 0 }));
const items = (cat: string, n: number, from = 0): VodItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s:m${cat}-${from + i}`, kind: 'movie', title: `Synthetic Film ${cat}-${i}`, categoryId: cat }));

function fakeApi(categories: VodCategory[], byCat: (id?: string) => VodItem[], log: (string | undefined)[] = [], gate?: Promise<void>): XtreamVodApi & { maxActive: number } {
  let active = 0;
  const api = {
    maxActive: 0,
    categories: async () => categories,
    list: async (id?: string) => {
      log.push(id);
      active++;
      api.maxActive = Math.max(api.maxActive, active);
      await (gate ?? Promise.resolve());
      await new Promise((r) => setTimeout(r, 1));
      active--;
      return byCat(id);
    },
  };
  return api;
}

describe('fetchXtreamCatalog', () => {
  test('asks per category, at most 3 at a time, keeps category order, counts', async () => {
    const log: (string | undefined)[] = [];
    const api = fakeApi(cats(6), (id) => items(id!, Number(id)), log);
    const list = await fetchXtreamCatalog(api, 'movie');
    expect(log.sort()).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(api.maxActive).toBeLessThanOrEqual(3);
    expect(list.items.map((i) => i.categoryId)).toEqual(['1', '2', '2', '3', '3', '3', '4', '4', '4', '4', '5', '5', '5', '5', '5', '6', '6', '6', '6', '6', '6']);
    expect(list.categories.map((c) => c.count)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('passes the caller signal to every request', async () => {
    const ac = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const api: XtreamVodApi = {
      categories: async (s) => { seen.push(s); return cats(2); },
      list: async (id, s) => { seen.push(s); return items(id!, 1); },
    };
    await fetchXtreamCatalog(api, 'movie', { signal: ac.signal });
    expect(seen).toHaveLength(3);
    expect(seen.every((s) => s === ac.signal)).toBe(true);
  });

  test('a request that fails after the caller aborted reads as cancelled', async () => {
    const ac = new AbortController();
    const api: XtreamVodApi = {
      categories: async () => { ac.abort(); throw new Error('network down'); },
      list: async () => [],
    };
    await expect(fetchXtreamCatalog(api, 'movie', { signal: ac.signal })).rejects.toBeInstanceOf(VodFetchCancelled);
  });

  test('a server that ignores category_id: the first answer is the whole list', async () => {
    const log: (string | undefined)[] = [];
    const all = [...items('1', 2), ...items('2', 3)];
    const list = await fetchXtreamCatalog(fakeApi(cats(2), () => all, log), 'movie');
    expect(log).toEqual(['1']);
    expect(list.items).toHaveLength(5);
  });

  test('no categories: one unfiltered request', async () => {
    const log: (string | undefined)[] = [];
    const list = await fetchXtreamCatalog(fakeApi([], () => items('9', 2), log), 'movie');
    expect(log).toEqual([undefined]);
    expect(list.categories).toEqual([{ id: 'uncategorized', kind: 'movie', name: 'Uncategorized', count: 2 }]);
  });

  test('duplicates across categories are kept once', async () => {
    const shared = items('1', 1)[0]!;
    const list = await fetchXtreamCatalog(fakeApi(cats(2), (id) => (id === '1' ? [shared] : [{ ...shared, categoryId: '2' }])), 'movie');
    expect(list.items).toHaveLength(1);
  });

  test('cap: stops fetching and truncates', async () => {
    const log: (string | undefined)[] = [];
    const list = await fetchXtreamCatalog(fakeApi(cats(10), (id) => items(id!, 4), log), 'movie', { cap: 6, concurrency: 1 });
    expect(list.items).toHaveLength(6);
    expect(list.truncated).toBe(true);
    expect(log.length).toBeLessThan(10);
  });

  test('cancel: rejects with VodFetchCancelled', async () => {
    const ac = new AbortController();
    const api = fakeApi(cats(5), (id) => {
      ac.abort();
      return items(id!, 1);
    });
    await expect(fetchXtreamCatalog(api, 'movie', { signal: ac.signal, concurrency: 1 })).rejects.toBeInstanceOf(VodFetchCancelled);
  });

  test('progress reports the running item count', async () => {
    const seen: number[] = [];
    await fetchXtreamCatalog(fakeApi(cats(3), (id) => items(id!, 2)), 'movie', { onProgress: (n) => seen.push(n) });
    expect(seen.at(-1)).toBe(6);
  });
  test('an uncategorised item in the first answer does not make it the full list', async () => {
    const log: (string | undefined)[] = [];
    const api = fakeApi(cats(3), (id) => (id === '1' ? [...items('1', 1), { ...items('1', 1, 5)[0]!, categoryId: VOD_UNCATEGORIZED }] : items(id!, 1)), log);
    const list = await fetchXtreamCatalog(api, 'movie');
    expect(log.sort()).toEqual(['1', '2', '3']);
    expect(list.items).toHaveLength(4);
  });

  test('fail-fast: after one request rejects, other workers stop taking categories', async () => {
    const log: (string | undefined)[] = [];
    const api = fakeApi(cats(10), (id) => {
      if (id === '3') throw new Error('boom');
      return items(id!, 1);
    }, log);
    await expect(fetchXtreamCatalog(api, 'movie', { concurrency: 2 })).rejects.toThrow('boom');
    await new Promise((r) => setTimeout(r, 20));
    expect(log.length).toBeLessThanOrEqual(5);
  });

  test('cap counts unique ids: duplicates across categories do not truncate', async () => {
    const log: (string | undefined)[] = [];
    const api = fakeApi(cats(5), (id) => items('1', 2).map((it) => ({ ...it, categoryId: id! })), log);
    const list = await fetchXtreamCatalog(api, 'movie', { cap: 3, concurrency: 1 });
    expect(log).toHaveLength(5);
    expect(list.items).toHaveLength(2);
    expect(list.truncated).toBeFalsy();
  });
});
