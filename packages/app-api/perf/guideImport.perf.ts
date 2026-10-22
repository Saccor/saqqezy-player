import { expect, test } from 'vitest';
import { SourceService, TV_EPG_BATCH, type FetchFn } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { m3uChunks, xmltvChunks } from '../../core/perf/generate.ts';
import { AppApi } from '../src/appApi.ts';

/**
 * Spec 2026-10-22-g9-stability §E: the guide import shares the worker with the UI. A 54k-channel source (the size of
 * the owner's TV) re-imports its guide while a probe asks the API for a channel page every 50 ms; every answer must
 * come quickly. 54k channels x 12 programmes (648k programmes, ~110 MB of XMLTV; 324k are in the stored window)
 * runs in well under 30 s here, so the full channel count is used. The import yields with its default `setTimeout(0)`
 * (about 15 ms on Windows, so it runs slower here than on a TV).
 */
const CHANNELS = 54_000;
const PER_CHANNEL = 12;
// The generator's programmes are on 2026-10-13: "now" at noon keeps those from 06:00 on.
const NOW = Date.UTC(2026, 9, 13, 12, 0);

const body = (chunks: AsyncGenerator<string>): Response => {
  const enc = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(ctl) {
      const r = await chunks.next();
      if (r.done) ctl.close();
      else ctl.enqueue(enc.encode(r.value));
    },
  }));
};

const fetchFn: FetchFn = async (url) => {
  if (url.endsWith('/p.m3u')) return body(m3uChunks(CHANNELS));
  if (url.endsWith('/epg.xml')) return body(xmltvChunks(CHANNELS, PER_CHANNEL));
  throw new TypeError('no route');
};

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

/** One turn of the event loop (timers and I/O get theirs in between), without a timer's rounding. */
const turn = () => new Promise<void>((resolve) => { setImmediate(resolve); });

/**
 * Runs `work` while a probe calls `read` every 50 ms; answers each probe's wait in ms, from when it was due (so time
 * the thread was held before the probe got a turn counts) to its answer. The probe waits by polling turns, not with a
 * timer: Windows rounds `setTimeout` to its ~15 ms tick, which would hide what the import does.
 */
async function probeDuring(work: () => Promise<unknown>, read: () => Promise<unknown>): Promise<number[]> {
  const waits: number[] = [];
  let done = false;
  const probe = (async () => {
    while (!done) {
      const due = performance.now() + 50;
      while (!done && performance.now() < due) await turn();
      if (done) break;
      await read();
      waits.push(performance.now() - due);
    }
  })();
  try {
    await work();
  } finally {
    done = true;
    await probe;
  }
  return waits;
}

test('a 54k-channel guide import leaves the API answering: p95 under 15 ms, longest wait under 50 ms', async () => {
  const storage = new MemoryStorage();
  // The TV's write batch (the worker passes it on Tizen and webOS): a 5,000-row write clones for ~12 ms by itself.
  const service = new SourceService({ storage, fetch: fetchFn, now: () => NOW, epgBatch: TV_EPG_BATCH });
  const api = new AppApi({ service, storage, emit: () => undefined, now: () => NOW, appVersion: 'perf' });
  await api.addSource({ kind: 'm3u', name: 'Synthetic', playlistUrl: 'http://example.test/p.m3u', epgUrl: 'http://example.test/epg.xml' });
  // The first import also fills the coverage, which rebuilds the channel index once (`liveFold.perf.ts` budgets that).
  const t0 = performance.now();
  const first = await probeDuring(() => api.refresh('epg'), () => api.getChannelSlice('all', 0, 12));
  const firstMs = performance.now() - t0;
  await api.idle();
  // The nightly re-import: same coverage, so the index is kept and nothing outside the import blocks the thread.
  const t1 = performance.now();
  const waits = await probeDuring(() => api.refresh('epg'), () => api.getChannelSlice('all', 0, 12));
  const ms = performance.now() - t1;
  await api.idle();
  const stored = (await api.diagnostics()).sources[0]!.guideImport!.count;
  console.log(
    `guide import ${CHANNELS} channels, ${stored} programmes stored: first ${(firstMs / 1000).toFixed(1)} s ` +
      `(probe p95 ${pct(first, 0.95).toFixed(1)} ms, max ${Math.max(...first).toFixed(1)} ms, n ${first.length}); ` +
      `re-import ${(ms / 1000).toFixed(1)} s (probe p95 ${pct(waits, 0.95).toFixed(1)} ms, ` +
      `max ${Math.max(...waits).toFixed(1)} ms, n ${waits.length})`,
  );
  expect(stored).toBeGreaterThan(300_000);
  expect(waits.length).toBeGreaterThan(10);
  expect(pct(waits, 0.95)).toBeLessThan(15);
  expect(Math.max(...waits)).toBeLessThan(50);
});
