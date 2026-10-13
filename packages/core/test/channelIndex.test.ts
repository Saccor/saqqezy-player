import { describe, expect, test } from 'vitest';
import { ChannelIndex } from '../src/index/channelIndex.ts';
import type { Channel } from '../src/types.ts';

function ch(n: number, group: string, name = `Channel ${String(n).padStart(3, '0')}`): Channel {
  return { id: `s:${n}`, sourceId: 's', name, url: `http://example.test/${n}.ts`, group, number: n };
}
const channels = [ch(3, 'News'), ch(1, 'Movies'), ch(2, 'News', 'Nyheter Åtta'), ch(4, 'Kids')];

describe('ChannelIndex', () => {
  test('groups: fav first, all second, provider groups in first-appearance order', () => {
    const idx = new ChannelIndex(channels);
    expect(idx.groups()).toEqual([
      { id: 'fav', name: 'Favourites', count: 0 },
      { id: 'all', name: 'All channels', count: 4 },
      { id: 'g:News', name: 'News', count: 2 },
      { id: 'g:Movies', name: 'Movies', count: 1 },
      { id: 'g:Kids', name: 'Kids', count: 1 },
    ]);
  });

  test('all is sorted by number, provider group keeps playlist order', () => {
    const idx = new ChannelIndex(channels);
    expect(idx.slice('all', 0, 10).map((c) => c.number)).toEqual([1, 2, 3, 4]);
    expect(idx.slice('g:News', 0, 10).map((c) => c.number)).toEqual([3, 2]);
    expect(idx.slice('all', 1, 2).map((c) => c.number)).toEqual([2, 3]);
    expect(idx.slice('nope', 0, 10)).toEqual([]);
  });

  test('favourites keep insertion order and survive flags()', () => {
    const idx = new ChannelIndex(channels);
    idx.setFavourite('s:4', true);
    idx.setFavourite('s:1', true);
    idx.setFavourite('s:1', true);
    expect(idx.slice('fav', 0, 10).map((c) => c.id)).toEqual(['s:4', 's:1']);
    const again = new ChannelIndex(channels, idx.flags());
    expect(again.groupSize('fav')).toBe(2);
    idx.setFavourite('s:4', false);
    expect(idx.slice('fav', 0, 10).map((c) => c.id)).toEqual(['s:1']);
  });

  test('hidden channels disappear everywhere and empty groups are omitted', () => {
    const idx = new ChannelIndex(channels);
    idx.setFavourite('s:4', true);
    idx.setHidden('s:4', true);
    expect(idx.groups().map((g) => g.id)).toEqual(['fav', 'all', 'g:News', 'g:Movies']);
    expect(idx.groupSize('fav')).toBe(0);
    expect(idx.byNumber(4)).toBeUndefined();
    expect(idx.search('channel', 10).map((c) => c.id)).not.toContain('s:4');
    expect(idx.hiddenChannels().map((c) => c.id)).toEqual(['s:4']);
    idx.setHidden('s:4', false);
    expect(idx.groupSize('all')).toBe(4);
  });

  test('indexOf, byNumber and wrapping neighbour', () => {
    const idx = new ChannelIndex(channels);
    expect(idx.indexOf('all', 's:3')).toBe(2);
    expect(idx.indexOf('g:Kids', 's:3')).toBe(-1);
    expect(idx.byNumber(2)?.id).toBe('s:2');
    expect(idx.neighbour('all', 's:4', 1)?.id).toBe('s:1');
    expect(idx.neighbour('all', 's:1', -1)?.id).toBe('s:4');
    expect(idx.neighbour('g:News', 's:3', 1)?.id).toBe('s:2');
    expect(idx.neighbour('all', 'missing', 1)).toBeUndefined();
  });

  test('search is case and diacritic insensitive, prefix matches first', () => {
    const idx = new ChannelIndex(channels);
    expect(idx.search('ATTA', 10).map((c) => c.id)).toEqual(['s:2']);
    expect(idx.search('nyheter', 10).map((c) => c.id)).toEqual(['s:2']);
    expect(idx.search('channel 00', 2)).toHaveLength(2);
    expect(idx.search('  ', 10)).toEqual([]);
  });
});
