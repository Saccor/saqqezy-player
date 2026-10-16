import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parseM3u, type M3uEntry, type ParseStats } from '../src/m3u/parse.ts';
import { m3uEntriesToChannels, uniqueId } from '../src/m3u/toChannels.ts';
import { splitLines } from '../src/text/lines.ts';
import { fnv1a } from '../src/hash.ts';

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

describe('tvg-shift and bare-url names', () => {
  test('tvg-shift is parsed, clamped and ignored when not finite', async () => {
    const { out } = await parse([
      '#EXTM3U',
      '#EXTINF:-1 tvg-shift="2.5",A', 'http://example.test/a.ts',
      '#EXTINF:-1 tvg-shift="-30",B', 'http://example.test/b.ts',
      '#EXTINF:-1 tvg-shift="99",C', 'http://example.test/c.ts',
      '#EXTINF:-1 tvg-shift="abc",D', 'http://example.test/d.ts',
      '#EXTINF:-1,E', 'http://example.test/e.ts',
    ].join('\n'));
    expect(out.map((e) => e.tvgShift)).toEqual([2.5, -12, 12, undefined, undefined]);
  });

  test('Channel.epgShift is copied only when non-zero', async () => {
    const { out } = await parse([
      '#EXTINF:-1 tvg-shift="1",A', 'http://example.test/a.ts',
      '#EXTINF:-1 tvg-shift="0",B', 'http://example.test/b.ts',
      '#EXTINF:-1,C', 'http://example.test/c.ts',
    ].join('\n'));
    const ch = m3uEntriesToChannels('s', out);
    expect(ch[0]?.epgShift).toBe(1);
    expect(ch[1]).not.toHaveProperty('epgShift');
    expect(ch[2]).not.toHaveProperty('epgShift');
  });

  test('a bare url without a name is shown redacted', async () => {
    const { out } = await parse('http://example.test/live/me/secret/9.ts\nhttp://example.test/x.ts?username=me&password=secret');
    expect(out[0]?.name).toBe('http://example.test/live/***/***/9.ts');
    expect(out[0]?.url).toBe('http://example.test/live/me/secret/9.ts');
    expect(out[1]?.name).not.toContain('secret');
  });
});

describe('parseM3u – per-channel headers', () => {
  test('reads #EXTVLCOPT user agent and referrer', async () => {
    const { out } = await parse([
      '#EXTM3U',
      '#EXTINF:-1,Channel 001',
      '#EXTVLCOPT:http-user-agent=SyntheticAgent/1.0',
      '#EXTVLCOPT:http-referrer=http://example.test/page',
      'http://example.test/live/1.ts',
    ].join('\n'));
    expect(out[0]?.headers).toEqual({ userAgent: 'SyntheticAgent/1.0', referrer: 'http://example.test/page' });
    expect(out[0]?.url).toBe('http://example.test/live/1.ts');
  });

  test('reads #EXTHTTP JSON; malformed JSON and non-string values are ignored', async () => {
    const { out } = await parse([
      '#EXTINF:-1,Channel 001',
      '#EXTHTTP:{"User-Agent":"SyntheticAgent/2.0","Referer":"http://example.test/r","Cookie":"x"}',
      'http://example.test/live/1.ts',
      '#EXTINF:-1,Channel 002',
      '#EXTHTTP:{"User-Agent":',
      'http://example.test/live/2.ts',
      '#EXTINF:-1,Channel 003',
      '#EXTHTTP:{"User-Agent":42,"Referer":["x"]}',
      'http://example.test/live/3.ts',
    ].join('\n'));
    expect(out[0]?.headers).toEqual({ userAgent: 'SyntheticAgent/2.0', referrer: 'http://example.test/r' });
    expect(out[1]?.headers).toBeUndefined();
    expect(out[2]?.headers).toBeUndefined();
    expect(out.map((e) => e.name)).toEqual(['Channel 001', 'Channel 002', 'Channel 003']);
  });

  test('reads the URL pipe and strips it from the URL', async () => {
    const { out } = await parse([
      '#EXTINF:-1,Channel 001',
      'http://example.test/live/1.ts|User-Agent=Synthetic%20Agent%2F3&Referer=http%3A%2F%2Fexample.test%2F',
      '#EXTINF:-1,Channel 002',
      'http://example.test/live/2.ts|X-Other=1',
    ].join('\n'));
    expect(out[0]).toMatchObject({ url: 'http://example.test/live/1.ts', headers: { userAgent: 'Synthetic Agent/3', referrer: 'http://example.test/' } });
    expect(out[1]?.url).toBe('http://example.test/live/2.ts');
    expect(out[1]?.headers).toBeUndefined();
  });

  test('an empty value is ignored, and headers never carry over to the next entry', async () => {
    const { out } = await parse([
      '#EXTINF:-1,Channel 001',
      '#EXTVLCOPT:http-user-agent=',
      '#EXTVLCOPT:http-referrer=  ',
      'http://example.test/live/1.ts|User-Agent=',
      '#EXTINF:-1,Channel 002',
      '#EXTVLCOPT:http-user-agent=SyntheticAgent/1.0',
      'http://example.test/live/2.ts',
      '#EXTINF:-1,Channel 003',
      'http://example.test/live/3.ts',
    ].join('\n'));
    expect(out[0]?.headers).toBeUndefined();
    expect(out[0]?.url).toBe('http://example.test/live/1.ts');
    expect(out[1]?.headers).toEqual({ userAgent: 'SyntheticAgent/1.0' });
    expect(out[2]?.headers).toBeUndefined();
  });

  test('the URL pipe wins over the tags; control characters are dropped and values capped at 512', async () => {
    const long = 'a'.repeat(600);
    const { out } = await parse([
      '#EXTINF:-1,Channel 001',
      '#EXTVLCOPT:http-user-agent=FromTag',
      '#EXTHTTP:{"Referer":"Ref\\r\\nX-Injected: 1"}',
      'http://example.test/live/1.ts|User-Agent=FromPipe',
      '#EXTINF:-1,Channel 002',
      `#EXTVLCOPT:http-user-agent=${long}`,
      'http://example.test/live/2.ts',
    ].join('\n'));
    expect(out[0]?.headers).toEqual({ userAgent: 'FromPipe', referrer: 'RefX-Injected: 1' });
    expect(out[1]?.headers?.userAgent).toHaveLength(512);
  });

  test('a skipped #EXTINF drops its header tags', async () => {
    const { out, stats } = await parse([
      '#EXTINF:-1,Lost entry',
      '#EXTVLCOPT:http-user-agent=SyntheticAgent/1.0',
      '#EXTINF:-1,Channel 002',
      'http://example.test/live/2.ts',
    ].join('\n'));
    expect(stats.skipped).toBe(1);
    expect(out[0]?.headers).toBeUndefined();
  });

  test('a piped entry keeps the line as its id key; ids and duplicates are what they were before', async () => {
    const piped = 'http://example.test/live/1.ts|User-Agent=SyntheticAgent';
    const { out } = await parse(['#EXTINF:-1,A', piped, '#EXTINF:-1,B', 'http://example.test/live/2.ts'].join('\n'));
    expect(out[0]).toMatchObject({ url: 'http://example.test/live/1.ts', idKey: piped });
    expect(out[1] && 'idKey' in out[1]).toBe(false);
    const [a, b] = m3uEntriesToChannels('s', out);
    expect(a?.id).toBe(`s:${fnv1a(piped)}`);
    expect(a?.url).toBe('http://example.test/live/1.ts');
    expect(b?.id).toBe(`s:${fnv1a('http://example.test/live/2.ts')}`);
    // The same stream with two different pipes stayed two channels before; it still is.
    const twice = m3uEntriesToChannels('s', [
      { name: 'A', url: 'http://example.test/a.ts', idKey: 'http://example.test/a.ts|User-Agent=One' },
      { name: 'A', url: 'http://example.test/a.ts', idKey: 'http://example.test/a.ts|User-Agent=Two' },
    ]);
    expect(twice).toHaveLength(2);
  });

  test('m3uEntriesToChannels keeps the headers on the channel', () => {
    const [a, b] = m3uEntriesToChannels('s', [
      { name: 'A', url: 'http://example.test/a.ts', headers: { userAgent: 'SyntheticAgent/1.0' } },
      { name: 'B', url: 'http://example.test/b.ts' },
    ]);
    expect(a?.headers).toEqual({ userAgent: 'SyntheticAgent/1.0' });
    expect(b && 'headers' in b).toBe(false);
  });
});
