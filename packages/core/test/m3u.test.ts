import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parseM3u, type M3uEntry, type ParseStats } from '../src/m3u/parse.ts';
import { m3uEntriesToChannels, uniqueId } from '../src/m3u/toChannels.ts';
import { splitLines } from '../src/text/lines.ts';

async function* once(s: string) { yield s; }
async function parse(text: string) {
  const stats: ParseStats = { entries: 0, skipped: 0 };
  const out: M3uEntry[] = [];
  for await (const e of parseM3u(splitLines(once(text)), stats)) out.push(e);
  return { out, stats };
}
const fixture = readFileSync(new URL('./fixtures/basic.m3u', import.meta.url), 'utf8');

describe('parseM3u', () => {
  test('parses attributes, names with commas, EXTGRP and bare urls', async () => {
    const { out, stats } = await parse(fixture);
    expect(out.map((e) => e.name)).toEqual([
      'Channel 001', 'Channel, with comma "002"', 'Channel 003',
      'http://example.test/live/4.ts', 'Duplicate of 001',
    ]);
    expect(out[0]).toEqual({
      name: 'Channel 001', url: 'http://example.test/live/1.ts', tvgId: 'ch1.test',
      tvgName: 'Channel 001', tvgLogo: 'http://example.test/l/1.png', groupTitle: 'News',
    });
    expect(out[1]?.tvgChno).toBe(10);
    expect(out[2]?.groupTitle).toBe('Kids');
    expect(stats).toEqual({ entries: 5, skipped: 1 });
  });

  test('empty input yields nothing', async () => {
    const { out, stats } = await parse('');
    expect(out).toEqual([]);
    expect(stats).toEqual({ entries: 0, skipped: 0 });
  });
});

describe('m3uEntriesToChannels', () => {
  test('dedupes urls, assigns ids, groups and numbers', async () => {
    const { out } = await parse(fixture);
    const ch = m3uEntriesToChannels('src1', out);
    expect(ch).toHaveLength(4);
    expect(ch.map((c) => [c.name, c.number, c.group])).toEqual([
      ['Channel 001', 11, 'News'],
      ['Channel, with comma "002"', 10, 'Movies'],
      ['Channel 003', 12, 'Kids'],
      ['http://example.test/live/4.ts', 13, 'Uncategorized'],
    ]);
    expect(ch[0]?.id).toMatch(/^src1:[0-9a-f]{8}$/);
    expect(ch[0]?.epgId).toBe('ch1.test');
    expect(ch[0]?.sourceId).toBe('src1');
  });
});

describe('uniqueId', () => {
  test('suffixes -2, -3 on collisions and records each id as used', () => {
    const used = new Set<string>();
    expect(uniqueId('src1:deadbeef', used)).toBe('src1:deadbeef');
    expect(uniqueId('src1:deadbeef', used)).toBe('src1:deadbeef-2');
    expect(uniqueId('src1:deadbeef', used)).toBe('src1:deadbeef-3');
    expect(used.has('src1:deadbeef-3')).toBe(true);
  });
});
