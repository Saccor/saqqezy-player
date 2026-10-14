import { expect, test } from 'vitest';
import { TitleIndexBuilder, queryTitles } from '../src/search/titleIndex.ts';
import { parseXmltv } from '../src/xmltv/parse.ts';
import { xmltvChunks } from './generate.ts';

const MIN = 60_000;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

test('title index: 50k channels x 10 airings, 150k unique titles: build, query (median), size', () => {
  const channels = 50_000;
  const per = 10;
  const unique = 150_000; // 7919 is prime and does not divide 150000, so every title appears.
  const base = Date.UTC(2026, 9, 13, 0, 0);

  // Pre-generate titles so buildMs measures only add + build.
  const titles: string[] = new Array<string>(channels * per);
  for (let k = 0; k < titles.length; k++) titles[k] = `Synthetic Title ${(k * 7919) % unique}`;

  const t0 = performance.now();
  const b = new TitleIndexBuilder();
  let k = 0;
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < per; i++) {
      const start = base + i * 30 * MIN;
      b.add(titles[k++] ?? '', `c${c}.test`, start, start + 30 * MIN);
    }
  }
  const data = b.build();
  const buildMs = performance.now() - t0;

  const now = base + 60 * MIN;
  const queries = ['s', 'sy', 'synt', 'title 12', 'title 9999', '1', 'e'];
  // Warm-up pass over all queries, then 21 timed single runs per query; report the median.
  for (const q of queries) queryTitles(data, q, now, 100);
  const times: Record<string, number> = {};
  for (const q of queries) {
    const runs: number[] = [];
    for (let r = 0; r < 21; r++) {
      const q0 = performance.now();
      queryTitles(data, q, now, 100);
      runs.push(performance.now() - q0);
    }
    times[q] = median(runs);
  }

  const bytes =
    data.haystack.length * 2 + // UTF-16 upper bound
    data.offsets.byteLength +
    data.airFirst.byteLength +
    data.airKey.byteLength +
    data.airStart.byteLength +
    data.airStop.byteLength;
  console.log(
    `Title index: build ${buildMs.toFixed(0)} ms, ~${(bytes / 1024 / 1024).toFixed(1)} MB typed+haystack, ` +
      `median query ms ${JSON.stringify(times)}`,
  );

  expect(data.offsets.length).toBe(unique);
  expect(data.airKey.length).toBe(channels * per);
  for (const ms of Object.values(times)) expect(ms).toBeLessThan(10);
});

test('title index: import overhead on XMLTV parse (2000 channels x 270 programmes, 50k unique titles)', async () => {
  // Parse-only denominator vs parse + TitleIndexBuilder.add per programme + build().
  async function parseOnly(): Promise<number> {
    const t0 = performance.now();
    let n = 0;
    for await (const item of parseXmltv(xmltvChunks(2000, 270, { uniqueTitles: 50_000 }))) {
      if (item.type === 'programme') n++;
    }
    expect(n).toBe(2000 * 270);
    return performance.now() - t0;
  }
  async function parseWithIndex(): Promise<number> {
    const t0 = performance.now();
    const b = new TitleIndexBuilder();
    for await (const item of parseXmltv(xmltvChunks(2000, 270, { uniqueTitles: 50_000 }))) {
      if (item.type !== 'programme') continue;
      const p = item.programme;
      b.add(p.title, p.epgId, p.start, p.stop);
    }
    const data = b.build();
    expect(data.offsets.length).toBe(50_000);
    return performance.now() - t0;
  }

  // Alternate the order and run each variant twice; keep the faster run of each.
  const parse: number[] = [];
  const indexed: number[] = [];
  parse.push(await parseOnly());
  indexed.push(await parseWithIndex());
  indexed.push(await parseWithIndex());
  parse.push(await parseOnly());
  const parseMs = Math.min(...parse);
  const indexedMs = Math.min(...indexed);
  const overheadPct = ((indexedMs - parseMs) / parseMs) * 100;
  console.log(
    `Title index import overhead: parse-only ${parseMs.toFixed(0)} ms, parse+index ${indexedMs.toFixed(0)} ms, ` +
      `overhead ${overheadPct.toFixed(1)} % (spec target < 5 % for the real import, which also writes IndexedDB; ` +
      `parse-only is a stricter denominator)`,
  );

  // The spec target for the real import (which also writes IndexedDB batches) is < 5 %.
  // Parse-only is a stricter denominator, so this 15 % bound is the enforced limit here.
  expect(overheadPct).toBeLessThan(15);
});
