import { expect, test } from 'vitest';
import { ChannelIndex } from '../src/index/channelIndex.ts';
import { parseM3u, type M3uEntry } from '../src/m3u/parse.ts';
import { m3uEntriesToChannels } from '../src/m3u/toChannels.ts';
import { splitLines } from '../src/text/lines.ts';
import { m3uChunks } from './generate.ts';

test('50k-channel M3U: parse + index + group/search queries under 2 s', async () => {
  const t0 = performance.now();
  const entries: M3uEntry[] = [];
  for await (const e of parseM3u(splitLines(m3uChunks(50_000)))) entries.push(e);
  const idx = new ChannelIndex(m3uEntriesToChannels('s', entries));
  const groups = idx.groups();
  const slice = idx.slice('all', 25_000, 30);
  const hits = idx.search('channel 4999', 50);
  const ms = performance.now() - t0;
  console.log(`50k M3U pipeline: ${ms.toFixed(0)} ms`);
  expect(entries).toHaveLength(50_000);
  expect(groups.length).toBe(302);
  expect(slice).toHaveLength(30);
  expect(hits.length).toBeGreaterThan(0);
  expect(ms).toBeLessThan(2000);
});
