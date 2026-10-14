import { expect, test } from 'vitest';
import { ChannelIndex } from '../src/index/channelIndex.ts';
import { emptyLayout } from '../src/layout/index.ts';
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

test('50k-channel index build with layout (5k hidden, 2k renames, manual order on 10 groups) under 300 ms', async () => {
  const entries: M3uEntry[] = [];
  for await (const e of parseM3u(splitLines(m3uChunks(50_000)))) entries.push(e);
  const channels = m3uEntriesToChannels('s', entries);
  const layout = emptyLayout();
  layout.hiddenChannels = channels.filter((_, i) => i % 10 === 0).map((c) => c.id);
  for (let i = 0; i < 2000; i++) layout.channelNames[channels[i * 25]!.id] = `Renamed ${i}`;
  const groupIds = [...new Set(channels.map((c) => `g:${c.group}`))].slice(0, 10);
  for (const gid of groupIds) {
    const members = channels.filter((c) => `g:${c.group}` === gid).map((c) => c.id);
    layout.channelOrder[gid] = members.reverse().slice(0, 100);
    layout.sort[gid] = 'name';
  }
  layout.lists[0]!.channelIds = channels.slice(0, 500).map((c) => c.id);

  const t0 = performance.now();
  const idx = new ChannelIndex(channels, layout);
  const groups = idx.groups();
  const slice = idx.slice('all', 25_000, 30);
  const first = idx.slice(groupIds[1]!, 0, 30);
  const ms = performance.now() - t0;
  console.log(`50k index build with layout: ${ms.toFixed(0)} ms`);
  expect(layout.hiddenChannels).toHaveLength(5000);
  expect(groups.find((g) => g.id === 'all')?.count).toBe(45_000);
  expect(slice).toHaveLength(30);
  expect(first.length).toBeGreaterThan(0);
  expect(ms).toBeLessThan(300);
});
