import { expect, test } from 'vitest';
import { TitleIndexBuilder, queryTitles } from '../src/search/titleIndex.ts';

const MIN = 60_000;

test('title index: 50k channels x 10 airings, 100k unique titles: build, query, size', () => {
  const channels = 50_000;
  const per = 10;
  const unique = 100_000;
  const base = Date.UTC(2026, 9, 13, 0, 0);
  const b = new TitleIndexBuilder();
  const t0 = performance.now();
  let k = 0;
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < per; i++) {
      const start = base + i * 30 * MIN;
      b.add(`Synthetic Title ${(k++ * 7919) % unique}`, `c${c}.test`, start, start + 30 * MIN);
    }
  }
  const data = b.build();
  const buildMs = performance.now() - t0;

  const now = base + 60 * MIN;
  const times: Record<string, number> = {};
  for (const q of ['s', 'sy', 'synt', 'title 12', 'title 9999', '1', 'e']) {
    const q0 = performance.now();
    for (let r = 0; r < 20; r++) queryTitles(data, q, now, 100);
    times[q] = (performance.now() - q0) / 20;
  }
  const bytes = data.haystack.length + 4 * (data.offsets.length + data.airFirst.length + 3 * data.airKey.length);
  console.log(`Title index: build ${buildMs.toFixed(0)} ms, ~${(bytes / 1024 / 1024).toFixed(1)} MB typed+haystack, query ms ${JSON.stringify(times)}`);

  expect(data.offsets.length).toBe(unique);
  expect(data.airKey.length).toBe(channels * per);
  for (const ms of Object.values(times)) expect(ms).toBeLessThan(10);
});
