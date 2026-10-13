import { expect, test } from 'vitest';
import { parseXmltv } from '../src/xmltv/parse.ts';
import { xmltvChunks } from './generate.ts';

declare const gc: (() => void) | undefined;
const gcFn = typeof gc === 'function' ? gc : undefined;

test('~100 MB XMLTV streams: first programme after few input chunks, bounded heap', async () => {
  let chunksConsumed = 0;
  async function* counted(): AsyncGenerator<string> {
    for await (const c of xmltvChunks(2000, 270)) {
      chunksConsumed++;
      yield c;
    }
  }

  gcFn?.();
  const base = process.memoryUsage().heapUsed;
  let peak = base;
  let programmes = 0;
  let chunksAtFirstProgramme = -1;
  const t0 = performance.now();
  for await (const item of parseXmltv(counted())) {
    if (item.type !== 'programme') continue;
    if (chunksAtFirstProgramme < 0) chunksAtFirstProgramme = chunksConsumed;
    if (++programmes % 50_000 === 0) {
      gcFn?.();
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }
  }
  const ms = performance.now() - t0;
  const growthMb = (peak - base) / 1024 / 1024;
  console.log(
    `XMLTV: ${programmes} programmes in ${(ms / 1000).toFixed(1)} s, ` +
      `first programme after ${chunksAtFirstProgramme} of ${chunksConsumed} chunks, ` +
      `peak heap growth ${growthMb.toFixed(0)} MB${gcFn ? '' : ' (gc unavailable)'}`,
  );
  expect(programmes).toBe(2000 * 270);
  // Deterministic streaming check: the channel block is ~2000 x 80 B (~3 chunks of 64 KB).
  // A parser that buffered the whole input would consume ~1400 chunks first.
  expect(chunksAtFirstProgramme).toBeGreaterThan(0);
  expect(chunksAtFirstProgramme).toBeLessThan(40);
  expect(growthMb).toBeLessThan(150);
  // With gc'd samples, steady-state growth is ~16 MB. Buffering the whole input (~91 MB)
  // would exceed 60 MB, so this catches it. Only meaningful when gc is exposed.
  if (gcFn) expect(growthMb).toBeLessThan(60);
});
