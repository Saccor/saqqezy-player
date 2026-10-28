import { describe, expect, test } from 'vitest';
import { ChannelIndex } from '../src/index/channelIndex.ts';
import type { Channel } from '../src/types.ts';

const ch = (n: number, name: string, group = 'Mixed'): Channel =>
  ({ id: `s:${n}`, sourceId: 's', name, url: `http://example.test/${n}.ts`, group, number: n });
const channels = [
  ch(1, 'Kanal 5 (Backup)'),
  ch(2, 'SE | Kanal 5 HD', 'SE | General'),
  ch(3, '[SE] Kanal5', 'SE | General'),
  ch(4, 'Superkanal 5'),
  ch(5, 'DE-Sport 1 FHD', 'DE | Sport'),
  ch(6, 'Sport1 Extra'),
  ch(55, 'Fifty Five'),
];
const names = (cs: readonly Channel[]) => cs.map((c) => c.name);

describe('ChannelIndex search', () => {
  test('every word in any order, spaces between letters and digits ignored', () => {
    const idx = new ChannelIndex(channels);
    expect(names(idx.search('kanal5', 10))).toEqual(['SE | Kanal 5 HD', '[SE] Kanal5', 'Kanal 5 (Backup)', 'Superkanal 5']);
    expect(names(idx.search('5 kanal', 10))).toContain('SE | Kanal 5 HD');
    expect(names(idx.search('sport 1', 10))).toEqual(['DE-Sport 1 FHD', 'Sport1 Extra']);
  });

  test('ranked by score, playlist order within a score; the limit cuts the ranked list', () => {
    const idx = new ChannelIndex(channels);
    expect(idx.searchScored('kanal 5').map((m) => [m.channel.number, m.score])).toEqual([[2, 0], [3, 0], [1, 1], [4, 4]]);
    expect(names(idx.search('kanal 5', 2))).toEqual(['SE | Kanal 5 HD', '[SE] Kanal5']);
  });

  test('a number finds that channel first, then names containing it', () => {
    const idx = new ChannelIndex(channels);
    expect(idx.searchScored('55').map((m) => [m.channel.number, m.score])).toEqual([[55, -1]]);
    expect(names(idx.search('5', 3))).toEqual(['DE-Sport 1 FHD', 'Kanal 5 (Backup)', 'SE | Kanal 5 HD']);
  });

  test('blank query: nothing', () => {
    expect(new ChannelIndex(channels).searchScored(' | ')).toEqual([]);
  });
});
