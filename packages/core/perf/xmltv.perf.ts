import { expect, test } from 'vitest';
import { parseXmltv } from '../src/xmltv/parse.ts';
import { xmltvChunks } from './generate.ts';

declare const gc: (() => void) | undefined;

test('~100 MB XMLTV streams with bounded heap growth', async () => {
  gc?.();
  const base = process.memoryUsage().heapUsed;
  let peak = base;
  let programmes = 0;
  const t0 = performance.now();
  for await (const item of parseXmltv(xmltvChunks(2000, 270))) {
    if (item.type === 'programme' && ++programmes % 20_000 === 0) {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }
  }
  const ms = performance.now() - t0;
  const growthMb = (peak - base) / 1024 / 1024;
  console.log(`XMLTV: ${programmes} programmes in ${(ms / 1000).toFixed(1)} s, peak heap growth ${growthMb.toFixed(0)} MB`);
  expect(programmes).toBe(2000 * 270);
  expect(growthMb).toBeLessThan(150);
});
