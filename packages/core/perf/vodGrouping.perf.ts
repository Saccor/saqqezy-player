import { expect, test } from 'vitest';
import { VodCatalog } from '../src/vod/catalog.ts';
import { groupVod } from '../src/vod/grouping.ts';
import type { VodCategory, VodItem, VodList } from '../src/vod/types.ts';

const PREFIX = ['EN - ', '|SE| ', '[DK] ', ''] as const;
const QUALITY = [' 4K', ' FHD', ' HD', ' [MULTI-SUB]'] as const;
const LANG_CAT = ['EN', 'SE', 'DK', 'DE'] as const;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

test('vod grouping: 60k movies (15k titles × 4 versions) in 80 language-split categories under 150 ms (best of 5)', () => {
  const n = 60_000;
  const categories: VodCategory[] = Array.from({ length: 80 }, (_, i) => ({
    id: String(i + 1), kind: 'movie', name: `${LANG_CAT[i % 4]} | Category ${Math.floor(i / 4) + 1}`, count: 0,
  }));
  const items: VodItem[] = Array.from({ length: n }, (_, i) => {
    const t = Math.floor(i / 4);
    const v = i % 4;
    return {
      id: `src:m${i + 1}`, kind: 'movie', title: `${PREFIX[v]}Synthetic Film ${t} Part ${t % 7} (${1950 + (t % 75)})${QUALITY[v]}`,
      categoryId: String(((t % 20) * 4 + v) + 1), xid: i + 1, poster: `http://img.example.test/p/${i}.jpg`,
      rating: (i % 100) / 10, added: 1_760_000_000 - i * 60, ext: 'mkv',
    };
  });
  const list: VodList = { items, categories };

  // Warm up the regexes and JIT once, then time several runs (the worker groups once per catalogue load).
  groupVod(list);
  const runs: number[] = [];
  for (let r = 0; r < 5; r++) {
    const t = performance.now();
    groupVod(list);
    runs.push(performance.now() - t);
  }
  const groupMs = median(runs);
  const bestMs = Math.min(...runs);

  (globalThis as { gc?: () => void }).gc?.();
  const before = process.memoryUsage().heapUsed;
  const groups = groupVod(list);
  const grouped = new VodCatalog('movie', list).withGroups(groups);
  grouped.slice('all', 'title', 0, 30);
  (globalThis as { gc?: () => void }).gc?.();
  const heapMb = (process.memoryUsage().heapUsed - before) / 1e6;

  const t2 = performance.now();
  for (const c of grouped.categories()) grouped.slice(c.id, 'added', 0, 30);
  const homeMs = performance.now() - t2;

  console.log(`grouping 60k: best ${bestMs.toFixed(0)} ms, median ${groupMs.toFixed(0)} ms (of 5), ${groups.groups.length} titles, ${groups.categories.length} categories, `
    + `+${heapMb.toFixed(1)} MB with the grouped view, home rows ${homeMs.toFixed(0)} ms`);
  expect(groups.groups).toHaveLength(15_000);
  expect(groups.categories).toHaveLength(20);
  // The spec's target (measured 2026-10-20: about 205 ms before the parse fast paths and once-per-group keys, about
  // 115 ms after). Best of 5 so a busy machine does not fail it; the median keeps a looser guard.
  expect(bestMs).toBeLessThan(150);
  expect(groupMs).toBeLessThan(300);
});
