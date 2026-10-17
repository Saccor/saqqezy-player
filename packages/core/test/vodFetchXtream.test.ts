import { describe, expect, test } from 'vitest';
import { SourceAuthError, SourceNetworkError, SourceRefusedError } from '../src/errors.ts';
import { fetchXtreamCatalog, VodFetchCancelled, type XtreamVodApi } from '../src/vod/fetchXtream.ts';
import { VOD_FALLBACK_GAP_MS, VOD_UNCATEGORIZED, type VodCategory, type VodItem, type VodList } from '../src/vod/types.ts';

const cats = (n: number): VodCategory[] => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), kind: 'movie', name: `Cat ${i + 1}`, count: 0 }));
const items = (cat: string, n: number, from = 0): VodItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s:m${cat}-${from + i}`, kind: 'movie', title: `Synthetic Film ${cat}-${i}`, categoryId: cat }));

interface Fake extends XtreamVodApi {
  log: string[];
  maxActive: number;
}

/**
 * `full`: the batches of the full answer, or an error thrown after them (a mid-stream failure).
 * `byCat`: the per-category answers of the fallback.
 */
function fakeApi(
  categories: VodCategory[],
  full: { batches: VodItem[][]; error?: unknown },
  byCat: (id: string) => VodItem[] = () => [],
): Fake {
  let active = 0;
  const api: Fake = {
    log: [],
    maxActive: 0,
    categories: async () => { api.log.push('categories'); return categories; },
    list: async (id?: string) => {
      api.log.push(`cat:${id}`);
      active++;
      api.maxActive = Math.max(api.maxActive, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      return byCat(id!);
    },
    all: async function* () {
      api.log.push('all');
      for (const b of full.batches) {
        await new Promise((r) => setTimeout(r, 0));
        yield b;
      }
      if (full.error) throw full.error;
    },
  };
  return api;
}

/** A clock that only moves when the fetch sleeps, so pacing is checked without real waits. */
function fakeTime() {
  let t = 0;
  const starts: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    starts,
    tick: (ms: number) => { t += ms; },
  };
}

const down = () => new SourceNetworkError('The provider did not respond in time.');

describe('fetchXtreamCatalog: one full request', () => {
  test('two requests: categories, then the full list; batches joined, counted per category', async () => {
    const api = fakeApi(cats(3), { batches: [[...items('1', 2), ...items('2', 1)], items('3', 3)] });
    const list = await fetchXtreamCatalog(api, 'movie');
    expect(api.log).toEqual(['categories', 'all']);
    expect(list.items).toHaveLength(6);
    expect(list.categories.map((c) => c.count)).toEqual([2, 1, 3]);
    expect(list.partial).toBeUndefined();
  });

  test('passes the caller signal to both requests', async () => {
    const ac = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const api: XtreamVodApi = {
      categories: async (s) => { seen.push(s); return cats(1); },
      list: async () => [],
      all: async function* (s) { seen.push(s); yield items('1', 1); },
    };
    await fetchXtreamCatalog(api, 'movie', { signal: ac.signal });
    expect(seen).toEqual([ac.signal, ac.signal]);
  });

  test('no categories: everything uncategorised', async () => {
    const list = await fetchXtreamCatalog(fakeApi([], { batches: [items('9', 2)] }), 'movie');
    expect(list.categories).toEqual([{ id: VOD_UNCATEGORIZED, kind: 'movie', name: 'Uncategorized', count: 2 }]);
  });

  test('duplicates are kept once', async () => {
    const shared = items('1', 1)[0]!;
    const list = await fetchXtreamCatalog(fakeApi(cats(2), { batches: [[shared], [{ ...shared, categoryId: '2' }]] }), 'movie');
    expect(list.items).toHaveLength(1);
  });

  test('cap: stops reading, truncated only when a title was dropped', async () => {
    const over = await fetchXtreamCatalog(fakeApi(cats(1), { batches: [items('1', 4), items('1', 4, 4)] }), 'movie', { cap: 6 });
    expect(over.items).toHaveLength(6);
    expect(over.truncated).toBe(true);
    const exact = await fetchXtreamCatalog(fakeApi(cats(1), { batches: [items('1', 3), items('1', 3, 3)] }), 'movie', { cap: 6 });
    expect(exact.items).toHaveLength(6);
    expect(exact.truncated).toBeFalsy();
  });

  test('cancel during the stream rejects with VodFetchCancelled', async () => {
    const ac = new AbortController();
    const api: XtreamVodApi = {
      categories: async () => cats(1),
      list: async () => [],
      all: async function* () { yield items('1', 1); ac.abort(); yield items('1', 1, 1); },
    };
    await expect(fetchXtreamCatalog(api, 'movie', { signal: ac.signal })).rejects.toBeInstanceOf(VodFetchCancelled);
  });

  test('a request that fails after the caller aborted reads as cancelled', async () => {
    const ac = new AbortController();
    const api = fakeApi(cats(1), { batches: [], error: down() });
    api.categories = async () => { ac.abort(); throw new Error('network down'); };
    await expect(fetchXtreamCatalog(api, 'movie', { signal: ac.signal })).rejects.toBeInstanceOf(VodFetchCancelled);
  });

  test('a failed category list fails the fetch (nothing else is asked)', async () => {
    const api = fakeApi(cats(1), { batches: [items('1', 1)] });
    api.categories = async () => { throw down(); };
    await expect(fetchXtreamCatalog(api, 'movie')).rejects.toBeInstanceOf(SourceNetworkError);
  });

  test('progress reports the running count', async () => {
    const seen: number[] = [];
    await fetchXtreamCatalog(fakeApi(cats(1), { batches: [items('1', 2), items('1', 3, 2)] }), 'movie', { onProgress: (n) => seen.push(n) });
    expect(seen).toEqual([2, 5, 5]);
  });

  test('snapshots: the first batch, then at most one per interval, never the final list', async () => {
    const time = fakeTime();
    const snaps: VodList[] = [];
    const api: XtreamVodApi = {
      categories: async () => cats(2),
      list: async () => [],
      all: async function* () {
        yield items('1', 1);
        time.tick(500);
        yield items('1', 1, 1); // 500 ms after the first: skipped
        time.tick(1000);
        yield items('2', 1); // 1500 ms: sent
        time.tick(100);
        yield items('2', 1, 1); // the end follows: the final list is the result, not a snapshot
      },
    };
    const list = await fetchXtreamCatalog(api, 'movie', { now: time.now, snapshotMs: 1500, onSnapshot: (l) => snaps.push(l) });
    expect(snaps.map((s) => s.items.length)).toEqual([1, 3]);
    expect(snaps[1]!.categories.map((c) => c.count)).toEqual([2, 1]);
    // A snapshot is a copy: the fetch going on does not change it.
    expect(snaps[0]!.items).toHaveLength(1);
    expect(list.items).toHaveLength(4);
  });
});

describe('fetchXtreamCatalog: fallback', () => {
  test('a failed full request falls back to one category at a time, paced', async () => {
    const time = fakeTime();
    const api = fakeApi(cats(4), { batches: [], error: down() }, (id) => items(id, 2));
    const origList = api.list;
    api.list = async (id, s) => { time.starts.push(time.now()); return origList(id, s); };
    const list = await fetchXtreamCatalog(api, 'movie', { now: time.now, sleep: time.sleep });
    expect(api.log).toEqual(['categories', 'all', 'cat:1', 'cat:2', 'cat:3', 'cat:4']);
    expect(api.maxActive).toBe(1);
    for (let i = 1; i < time.starts.length; i++) expect(time.starts[i]! - time.starts[i - 1]!).toBeGreaterThanOrEqual(VOD_FALLBACK_GAP_MS);
    expect(list.items).toHaveLength(8);
    expect(list.partial).toBeUndefined();
  });

  test('items read before a mid-stream failure are kept; the fallback adds the rest once', async () => {
    const time = fakeTime();
    const api = fakeApi(cats(2), { batches: [items('1', 2)], error: down() }, (id) => items(id, 2));
    const list = await fetchXtreamCatalog(api, 'movie', { now: time.now, sleep: time.sleep });
    expect(list.items.map((i) => i.id).sort()).toEqual(['s:m1-0', 's:m1-1', 's:m2-0', 's:m2-1']);
  });

  test('a category that fails is skipped and the list is partial', async () => {
    const time = fakeTime();
    const api = fakeApi(cats(3), { batches: [], error: down() }, (id) => {
      if (id === '2') throw down();
      return items(id, 1);
    });
    const list = await fetchXtreamCatalog(api, 'movie', { now: time.now, sleep: time.sleep });
    expect(api.log).toContain('cat:3');
    expect(list.items).toHaveLength(2);
    expect(list.partial).toBe(true);
  });

  test('three failures in a row stop the fallback', async () => {
    const time = fakeTime();
    const api = fakeApi(cats(10), { batches: [], error: down() }, (id) => {
      if (id === '1') return items(id, 1);
      throw down();
    });
    const list = await fetchXtreamCatalog(api, 'movie', { now: time.now, sleep: time.sleep });
    expect(api.log.filter((l) => l.startsWith('cat:'))).toEqual(['cat:1', 'cat:2', 'cat:3', 'cat:4']);
    expect(list.partial).toBe(true);
    const none = fakeApi(cats(10), { batches: [], error: down() }, () => { throw down(); });
    await expect(fetchXtreamCatalog(none, 'movie', { now: time.now, sleep: time.sleep })).rejects.toBeInstanceOf(SourceNetworkError);
  });

  test('a refusal or auth error on the full request does not fall back', async () => {
    const refused = fakeApi(cats(3), { batches: [], error: new SourceRefusedError() }, (id) => items(id, 1));
    await expect(fetchXtreamCatalog(refused, 'movie')).rejects.toBeInstanceOf(SourceRefusedError);
    expect(refused.log).toEqual(['categories', 'all']);
    const auth = fakeApi(cats(3), { batches: [], error: new SourceAuthError() }, (id) => items(id, 1));
    await expect(fetchXtreamCatalog(auth, 'movie')).rejects.toBeInstanceOf(SourceAuthError);
    expect(auth.log).toEqual(['categories', 'all']);
  });

  test('a refusal during the fallback stops it: partial with items, else the refusal', async () => {
    const time = fakeTime();
    const some = fakeApi(cats(4), { batches: [], error: down() }, (id) => {
      if (id === '3') throw new SourceRefusedError();
      return items(id, 1);
    });
    const list = await fetchXtreamCatalog(some, 'movie', { now: time.now, sleep: time.sleep });
    expect(some.log).not.toContain('cat:4');
    expect(list.items).toHaveLength(2);
    expect(list.partial).toBe(true);
    const none = fakeApi(cats(4), { batches: [], error: down() }, () => { throw new SourceRefusedError(); });
    await expect(fetchXtreamCatalog(none, 'movie', { now: time.now, sleep: time.sleep })).rejects.toBeInstanceOf(SourceRefusedError);
    expect(none.log.filter((l) => l.startsWith('cat:'))).toEqual(['cat:1']);
  });

  test('an empty full answer with categories probes the first one only', async () => {
    const time = fakeTime();
    const empty = fakeApi(cats(5), { batches: [] }, () => []);
    const list = await fetchXtreamCatalog(empty, 'movie', { now: time.now, sleep: time.sleep });
    expect(empty.log).toEqual(['categories', 'all', 'cat:1']);
    expect(list.items).toEqual([]);
    const needsCat = fakeApi(cats(3), { batches: [] }, (id) => items(id, 1));
    expect((await fetchXtreamCatalog(needsCat, 'movie', { now: time.now, sleep: time.sleep })).items).toHaveLength(3);
  });

  test('a fallback server that ignores category_id: the first answer is the whole list', async () => {
    const time = fakeTime();
    const all = [...items('1', 2), ...items('2', 3)];
    const api = fakeApi(cats(2), { batches: [], error: down() }, () => all);
    const list = await fetchXtreamCatalog(api, 'movie', { now: time.now, sleep: time.sleep });
    expect(api.log.filter((l) => l.startsWith('cat:'))).toEqual(['cat:1']);
    expect(list.items).toHaveLength(5);
  });

  test('an uncategorised item in the first fallback answer does not make it the full list', async () => {
    const time = fakeTime();
    const api = fakeApi(cats(3), { batches: [], error: down() },
      (id) => (id === '1' ? [...items('1', 1), { ...items('1', 1, 5)[0]!, categoryId: VOD_UNCATEGORIZED }] : items(id, 1)));
    const list = await fetchXtreamCatalog(api, 'movie', { now: time.now, sleep: time.sleep });
    expect(api.log.filter((l) => l.startsWith('cat:'))).toEqual(['cat:1', 'cat:2', 'cat:3']);
    expect(list.items).toHaveLength(4);
  });

  test('the fallback stops at the cap', async () => {
    const time = fakeTime();
    const api = fakeApi(cats(10), { batches: [], error: down() }, (id) => items(id, 4));
    const list = await fetchXtreamCatalog(api, 'movie', { cap: 6, now: time.now, sleep: time.sleep });
    expect(list.items).toHaveLength(6);
    expect(list.truncated).toBe(true);
    expect(api.log.filter((l) => l.startsWith('cat:')).length).toBeLessThan(10);
  });

  test('cancel during the fallback', async () => {
    const time = fakeTime();
    const ac = new AbortController();
    const api = fakeApi(cats(5), { batches: [], error: down() }, (id) => { ac.abort(); return items(id, 1); });
    await expect(fetchXtreamCatalog(api, 'movie', { signal: ac.signal, now: time.now, sleep: time.sleep })).rejects.toBeInstanceOf(VodFetchCancelled);
  });
});
