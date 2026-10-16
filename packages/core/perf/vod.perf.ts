import { expect, test } from 'vitest';
import { VodCatalog } from '../src/vod/catalog.ts';
import { buildVodList } from '../src/vod/list.ts';
import { searchVodIndex, vodSearchIndexBytes, type VodSearchIndex } from '../src/vod/searchIndex.ts';
import type { VodCategory, VodItem } from '../src/vod/types.ts';

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

test('vod catalogue: 60k movies in 80 categories: build, first sorts, slices, search, stored size', () => {
  const n = 60_000;
  const categories: VodCategory[] = Array.from({ length: 80 }, (_, i) => ({ id: String(i + 1), kind: 'movie', name: `Category ${i + 1}`, count: 0 }));
  const items: VodItem[] = Array.from({ length: n }, (_, i) => ({
    id: `src:m${i + 1}`, kind: 'movie', title: `Synthetic Film ${(i * 7919) % n} Part ${i % 7}`, categoryId: String((i % 80) + 1),
    xid: i + 1, poster: `http://img.example.test/posters/w342/${(i * 2654435761) % 1e9}.jpg`,
    year: 1950 + (i % 75), rating: (i % 100) / 10, added: 1_760_000_000 - i * 60, ext: 'mkv',
  }));

  const t0 = performance.now();
  const list = buildVodList('movie', items, categories);
  const catalog = new VodCatalog('movie', list);
  const buildMs = performance.now() - t0;

  const t1 = performance.now();
  catalog.slice('all', 'title', 0, 30);
  catalog.slice('all', 'added', 0, 30);
  catalog.slice('all', 'rating', 0, 30);
  const firstSortsMs = performance.now() - t1;

  const sliceTimes: number[] = [];
  for (let r = 0; r < 50; r++) {
    const t = performance.now();
    catalog.slice(String((r % 80) + 1), 'title', r * 7, 21);
    sliceTimes.push(performance.now() - t);
  }

  // What getVodHome does on a fresh catalogue: the first 30 of every category.
  const fresh = new VodCatalog('movie', list);
  const t2 = performance.now();
  for (const c of fresh.categories()) fresh.slice(c.id, 'added', 0, 30);
  const homeRowsMs = performance.now() - t2;

  const searchTimes: number[] = [];
  for (const q of ['s', 'film 1', 'part 3', 'synthetic film 59999', 'zzz']) {
    for (let r = 0; r < 5; r++) {
      const t = performance.now();
      catalog.search(q, 20);
      searchTimes.push(performance.now() - t);
    }
  }

  const storedBytes = JSON.stringify(list).length;
  console.log(JSON.stringify({
    buildMs: Math.round(buildMs), firstSortsMs: Math.round(firstSortsMs), homeRowsMs: Math.round(homeRowsMs),
    sliceMedianMs: median(sliceTimes).toFixed(2), searchMedianMs: median(searchTimes).toFixed(2),
    storedMB: (storedBytes / 1e6).toFixed(1),
  }));

  expect(buildMs).toBeLessThan(500);
  expect(firstSortsMs).toBeLessThan(2000);
  expect(homeRowsMs).toBeLessThan(60);
  expect(median(sliceTimes)).toBeLessThan(20);
  expect(median(searchTimes)).toBeLessThan(30);
  expect(storedBytes).toBeLessThan(15e6);
});

declare const gc: (() => void) | undefined;
const gcFn = typeof gc === 'function' ? gc : undefined;

test('vod catalogue: resident heap at 60k movies with realistic ids and poster URLs', () => {
  if (!gcFn) throw new Error('Run with --expose-gc (pnpm test:perf does).');
  const n = 60_000;
  // 14 characters, like SourceService's default ids.
  const sourceId = 'mgq3x7k2a9f1zp';

  const measure = () => {
    gcFn();
    const mem0 = process.memoryUsage();
    const categories: VodCategory[] = Array.from({ length: 80 }, (_, i) => ({ id: String(i + 1), kind: 'movie', name: `Synthetic Category ${i + 1}`, count: 0 }));
    let raw: VodItem[] | undefined = Array.from({ length: n }, (_, i) => ({
      id: `${sourceId}:m${100_000 + i}`, kind: 'movie', title: `Synthetic Film Title Number ${i} Part ${i % 7}`,
      categoryId: String((i % 80) + 1), xid: 100_000 + i,
      // 86 characters, typical of provider poster URLs.
      poster: `https://img.example.test/t/p/w600_and_h900_bestv2/${i.toString(16).padStart(32, '0')}.jpg`,
      year: 1950 + (i % 75), rating: (i % 100) / 10, added: 1_760_000_000 - i * 60, ext: 'mkv',
    }));
    // The app reads the catalogue from IndexedDB, which yields flat strings (structured clone), not the ropes template literals leave.
    const items = structuredClone(raw);
    raw = undefined;
    const list = buildVodList('movie', items, categories);
    const catalog = new VodCatalog('movie', list);
    // What a browse session builds: one sort and the search keys.
    catalog.slice('all', 'title', 0, 30);
    catalog.search('a', 20);
    gcFn();
    const mem1 = process.memoryUsage();
    void [items, list];
    const result = {
      heapMB: (mem1.heapUsed - mem0.heapUsed) / 1e6,
      externalMB: (mem1.external - mem0.external) / 1e6,
      arrayBuffersMB: (mem1.arrayBuffers - mem0.arrayBuffers) / 1e6,
      jsonMB: JSON.stringify(list).length / 1e6,
      posterChars: items[0]!.poster!.length,
      size: catalog.size,
    };
    void [items, list, catalog];
    return result;
  };

  const runs = [measure(), measure(), measure()];
  const med = median(runs.map((r) => r.heapMB));
  console.log(JSON.stringify({
    heapMB: runs.map((r) => r.heapMB.toFixed(1)), medianHeapMB: med.toFixed(1),
    externalMB: runs.map((r) => r.externalMB.toFixed(1)), arrayBuffersMB: runs.map((r) => r.arrayBuffersMB.toFixed(1)),
    jsonMB: runs[0]!.jsonMB.toFixed(1), posterChars: runs[0]!.posterChars,
  }));
  for (const r of runs) {
    expect(r.posterChars).toBe(86);
    expect(r.size).toBe(n);
  }
  expect(med).toBeLessThan(40);
});

test('vod search index: 50k movies + 10k series built from stored catalogues, retained heap and search time', () => {
  if (!gcFn) throw new Error('Run with --expose-gc (pnpm test:perf does).');
  const sourceId = 'mgq3x7k2a9f1zp';
  const stored = (kind: 'movie' | 'series', n: number): VodItem[] => structuredClone(Array.from({ length: n }, (_, i): VodItem => ({
    id: `${sourceId}:${kind === 'movie' ? 'm' : 's'}${100_000 + i}`, kind, title: `Synthetic Film Title Number ${i} Part ${i % 7}`,
    categoryId: String((i % 80) + 1), xid: 100_000 + i,
    poster: `https://img.example.test/t/p/w600_and_h900_bestv2/${i.toString(16).padStart(32, '0')}.jpg`,
    year: 1950 + (i % 75), rating: (i % 100) / 10, added: 1_760_000_000 - i * 60, ext: 'mkv',
  })));
  const categories = (kind: 'movie' | 'series'): VodCategory[] => Array.from({ length: 80 }, (_, i) => ({ id: String(i + 1), kind, name: `Synthetic Category ${i + 1}`, count: 0 }));

  const measure = () => {
    gcFn();
    const mem0 = process.memoryUsage();
    const t0 = performance.now();
    // What the worker does for a kind that is not resident: read the stored list once, build, drop the list.
    const indexes: VodSearchIndex[] = (['movie', 'series'] as const).map((kind) => {
      const list = buildVodList(kind, stored(kind, kind === 'movie' ? 50_000 : 10_000), categories(kind));
      return new VodCatalog(kind, list).searchIndex();
    });
    const buildMs = performance.now() - t0;
    gcFn();
    const mem1 = process.memoryUsage();
    return { indexes, buildMs, heapMB: (mem1.heapUsed - mem0.heapUsed + mem1.arrayBuffers - mem0.arrayBuffers) / 1e6 };
  };
  const runs = [measure(), measure(), measure()];
  const med = median(runs.map((r) => r.heapMB));
  const { indexes } = runs[0]!;

  const searchTimes: number[] = [];
  for (const q of ['s', 'film 1', 'part 3', 'synthetic film title number 49999', 'zzz']) {
    for (let r = 0; r < 5; r++) {
      const t = performance.now();
      for (const ix of indexes) searchVodIndex(ix, q, 20);
      searchTimes.push(performance.now() - t);
    }
  }
  console.log(JSON.stringify({
    indexHeapMB: runs.map((r) => r.heapMB.toFixed(2)), medianIndexHeapMB: med.toFixed(2),
    packedMB: indexes.map((ix) => (vodSearchIndexBytes(ix) / 1e6).toFixed(2)),
    buildMs: runs.map((r) => Math.round(r.buildMs)), searchMedianMs: median(searchTimes).toFixed(2),
  }));
  expect(indexes.map((ix) => ix.size)).toEqual([50_000, 10_000]);
  expect(median(searchTimes)).toBeLessThan(30);
  // Budget (plan 6 decision): 7 MB, no posters in the index (with posters it measured 8.7 MB).
  expect(med).toBeLessThan(7);
});
