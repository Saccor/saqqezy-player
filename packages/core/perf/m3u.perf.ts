import { expect, test } from 'vitest';
import { applyOps } from '../src/layout/index.ts';
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

test('50k-channel index build with layout (7k hidden, 2k renames, manual order on 10 groups) under 300 ms', async () => {
  const entries: M3uEntry[] = [];
  for await (const e of parseM3u(splitLines(m3uChunks(50_000)))) entries.push(e);
  const channels = m3uEntriesToChannels('s', entries);
  const layout = emptyLayout();
  // Stride 7 is coprime with the 300 groups, so hidden channels spread over every group and none is wiped out.
  layout.hiddenChannels = channels.filter((_, i) => i % 7 === 0).map((c) => c.id);
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
  expect(groups).toHaveLength(302); // fav + all + 300 provider groups: none emptied by the hidden pattern
  expect(layout.hiddenChannels).toHaveLength(7143);
  expect(groups.find((g) => g.id === 'all')?.count).toBe(50_000 - 7143);
  expect(slice).toHaveLength(30);
  expect(first.length).toBeGreaterThan(0);
  expect(ms).toBeLessThan(300);
});

test('50k channels: markWatched -> withLayout -> neighbour(all) under 20 ms (median of 20, warm base)', async () => {
  const entries: M3uEntry[] = [];
  for await (const e of parseM3u(splitLines(m3uChunks(50_000)))) entries.push(e);
  const channels = m3uEntriesToChannels('s', entries);
  let layout = emptyLayout();
  layout.hiddenChannels = channels.filter((_, i) => i % 7 === 0).map((c) => c.id);
  for (let i = 0; i < 2000; i++) layout.channelNames[channels[i * 25]!.id] = `Renamed ${i}`;
  let idx = new ChannelIndex(channels, layout);
  idx.groups(); // warm base and caches
  idx.neighbour('all', channels[1]!.id, 1);
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const id = channels[1 + i * 7]!.id; // index % 7 === 1: never hidden, changes recent every run
    layout = applyOps(layout, [{ op: 'markWatched', id }]).layout;
    const t0 = performance.now();
    idx = idx.withLayout(layout);
    const n = idx.neighbour('all', id, 1);
    times.push(performance.now() - t0);
    expect(n).toBeDefined();
  }
  times.sort((a, b) => a - b);
  const median = (times[9]! + times[10]!) / 2;
  console.log(`50k markWatched rebuild + neighbour: median ${median.toFixed(2)} ms, max ${times[19]!.toFixed(2)} ms`);
  expect(median).toBeLessThan(20);
});

test('50k channels: index build + groups without search (search keys are lazy) under 20 ms (best of 5)', async () => {
  const entries: M3uEntry[] = [];
  for await (const e of parseM3u(splitLines(m3uChunks(50_000)))) entries.push(e);
  const channels = m3uEntriesToChannels('s', entries);
  const build: number[] = [];
  const first: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const idx = new ChannelIndex(channels);
    idx.groups();
    const t1 = performance.now();
    const hits = idx.search('channel 4999', 50);
    const t2 = performance.now();
    build.push(t1 - t0);
    first.push(t2 - t1);
    expect(hits.length).toBeGreaterThan(0);
  }
  build.sort((a, b) => a - b);
  first.sort((a, b) => a - b);
  console.log(`50k index build (no search): best ${build[0]!.toFixed(1)} ms, median ${build[2]!.toFixed(1)} ms; first search (builds the keys): median ${first[2]!.toFixed(1)} ms`);
  expect(build[0]!).toBeLessThan(20);
});
