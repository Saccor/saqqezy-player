import { describe, expect, test } from 'vitest';
import { ChannelIndex } from '../src/index/channelIndex.ts';
import { applyOps, emptyLayout, type LayoutOp } from '../src/layout/index.ts';
import { epgKey } from '../src/epg/window.ts';
import type { Channel } from '../src/types.ts';

const ch = (n: number, name: string, group: string, epgId?: string): Channel => {
  const c: Channel = { id: `s:${n}`, sourceId: 's', name, url: `http://example.test/${n}.ts`, group, number: n };
  if (epgId) c.epgId = epgId;
  return c;
};
const channels = [
  ch(1, 'SE: Channel One HD', 'Nordic', 'one.se'),
  ch(2, 'Example News', 'News'),
  ch(3, 'Channel One FHD', 'HD', 'one.se'),
  ch(4, 'Channel One (backup)', 'HD'),
  ch(5, 'Channel One 4K', 'UHD', 'one.se'),
  ch(6, 'Channel One +1', 'HD', 'one.se'),
];
const lay = (...ops: LayoutOp[]) => applyOps(emptyLayout(), ops).layout;
const names = (cs: Channel[]) => cs.map((c) => c.name);
const ids = (cs: readonly Channel[]) => cs.map((c) => c.id);
const fold = { fold: true };

describe('ChannelIndex fold mode', () => {
  test('All shows one row per channel, named and badged', () => {
    const idx = new ChannelIndex(channels, undefined, undefined, fold);
    const all = idx.slice('all', 0, 10);
    expect(names(all)).toEqual(['Channel One', 'Example News', 'Channel One +1']);
    expect(all[0]).toMatchObject({ id: 's:1', number: 1, sources: 4, quality: 0 });
    expect(all[1]!.sources).toBeUndefined();
    expect(all[1]!.quality).toBeUndefined();
    expect(idx.groupSize('all')).toBe(3);
    expect(idx.folding()).toBe(true);
  });
  test('off: exactly today', () => {
    const a = new ChannelIndex(channels);
    const b = new ChannelIndex(channels, undefined, undefined, { fold: false });
    expect(b.slice('all', 0, 10)).toEqual(a.slice('all', 0, 10));
    expect(b.groups()).toEqual(a.groups());
    expect(b.rowOf('s:3')).toBe('s:3');
    expect(b.rowOf('nope')).toBeUndefined();
    expect(ids(b.sources('s:3'))).toEqual(['s:3']);
    expect(b.folding()).toBe(false);
  });
  test('a row appears in each provider group that holds a member', () => {
    const idx = new ChannelIndex(channels, undefined, undefined, fold);
    expect(ids(idx.slice('g:HD', 0, 10))).toEqual(['s:1', 's:6']);
    expect(ids(idx.slice('g:UHD', 0, 10))).toEqual(['s:1']);
    expect(idx.groups().find((g) => g.id === 'g:HD')?.count).toBe(2);
  });
  test('rowOf, sources, foldKey, neighbour, indexOf and byNumber from a member', () => {
    const idx = new ChannelIndex(channels, undefined, undefined, fold);
    expect(idx.rowOf('s:5')).toBe('s:1');
    expect(ids(idx.sources('s:5'))).toEqual(['s:1', 's:3', 's:4', 's:5']);
    expect(idx.foldKey('s:4')).toBe(idx.foldKey('s:1'));
    expect(idx.foldKey('s:6')).not.toBe(idx.foldKey('s:1'));
    expect(idx.memberInfo('s:4')).toEqual({ quality: 4, backup: true });
    expect(idx.neighbour('all', 's:5', 1)?.id).toBe('s:2');
    expect(idx.neighbour('all', 's:2', -1)?.id).toBe('s:1');
    expect(idx.indexOf('all', 's:4')).toBe(0);
    expect(idx.byNumber(5)?.id).toBe('s:1');
    expect(idx.byNumber(2)?.id).toBe('s:2');
  });
  test('favourites, lists and recents keep member ids and show the row once', () => {
    const l = lay({ op: 'addToList', listId: 'fav', channelIds: ['s:5', 's:3', 's:2'] }, { op: 'markWatched', id: 's:4' });
    const idx = new ChannelIndex(channels, l, undefined, fold);
    expect(ids(idx.slice('fav', 0, 10))).toEqual(['s:1', 's:2']);
    expect(ids(idx.slice('recent', 0, 10))).toEqual(['s:1']);
    expect(idx.layout().lists[0]!.channelIds).toEqual(['s:5', 's:3', 's:2']);
  });
  test('manual order by member id places the row', () => {
    const idx = new ChannelIndex(channels, lay({ op: 'setChannelOrder', groupId: 'all', ids: ['s:6', 's:4'] }), undefined, fold);
    expect(ids(idx.slice('all', 0, 10))).toEqual(['s:6', 's:1', 's:2']);
  });
  test('hidden members drop out of the sources; a fully hidden row disappears', () => {
    const idx = new ChannelIndex(channels, lay({ op: 'hideChannels', ids: ['s:1', 's:3'] }), undefined, fold);
    expect(ids(idx.sources('s:1'))).toEqual(['s:4', 's:5']);
    // The row now sits at its first visible stream (number 4), after Example News.
    expect(idx.slice('all', 0, 10)[1]).toMatchObject({ id: 's:1', sources: 2 });
    expect(idx.byNumber(1)).toBeUndefined();
    const gone = new ChannelIndex(channels, lay({ op: 'hideChannels', ids: ['s:1', 's:3', 's:4', 's:5'] }), undefined, fold);
    expect(names(gone.slice('all', 0, 10))).toEqual(['Example News', 'Channel One +1']);
  });
  test('a hidden group removes its members from the row', () => {
    const idx = new ChannelIndex(channels, lay({ op: 'hideGroups', ids: ['g:HD'] }), undefined, fold);
    expect(ids(idx.sources('s:1'))).toEqual(['s:1', 's:5']);
  });
  test('a rename of a member names the row; get stays per channel', () => {
    const a = new ChannelIndex(channels, lay({ op: 'renameChannel', id: 's:3', name: 'My One' }), undefined, fold);
    expect(a.slice('all', 0, 1)[0]!.name).toBe('My One');
    expect(a.get('s:3')!.name).toBe('My One');
    expect(a.get('s:1')!.name).toBe('SE: Channel One HD');
    const b = new ChannelIndex(channels, lay({ op: 'renameChannel', id: 's:1', name: 'Lead' }, { op: 'renameChannel', id: 's:3', name: 'Other' }), undefined, fold);
    expect(b.slice('all', 0, 1)[0]!.name).toBe('Lead');
  });
  test('search finds the row once by its folded name', () => {
    const idx = new ChannelIndex(channels, undefined, undefined, fold);
    expect(ids(idx.search('channel one', 10))).toEqual(['s:1', 's:6']);
  });
  test('guideChannel: the first member with a guide id, under the row id', () => {
    const cs = [ch(1, 'Channel One (backup)', 'A'), ch(2, 'Channel One HD', 'A', 'one.se')];
    const idx = new ChannelIndex(cs, undefined, undefined, fold);
    const row = idx.slice('all', 0, 1)[0]!;
    expect(row.epgId).toBe('one.se');
    expect(idx.guideChannel(row)).toMatchObject({ id: 's:1', name: 'Channel One HD', epgId: 'one.se' });
    const plain = new ChannelIndex(cs);
    const c = plain.get('s:1')!;
    expect(plain.guideChannel(c)).toBe(c);
  });
  test('hide-no-guide tests the row, not each member', () => {
    const cs = [ch(1, 'Channel One (backup)', 'A'), ch(2, 'Channel One HD', 'A', 'one.se'), ch(3, 'Example News', 'A')];
    const idx = new ChannelIndex(cs, lay({ op: 'setHideNoEpg', value: true }), new Set([epgKey(cs[1]!)]), fold);
    expect(ids(idx.slice('all', 0, 10))).toEqual(['s:1']);
    expect(ids(idx.sources('s:1'))).toEqual(['s:1', 's:2']);
  });
  test('programme search maps guide keys to rows', () => {
    const idx = new ChannelIndex(channels, undefined, undefined, fold);
    expect(ids(idx.channelsForEpgKey('one.se'))).toEqual(['s:1', 's:6']);
  });
  test('rowChannel and memberIds', () => {
    const idx = new ChannelIndex(channels, lay({ op: 'hideChannels', ids: ['s:4'] }), undefined, fold);
    expect(idx.rowChannel('s:5')).toMatchObject({ id: 's:1', name: 'Channel One', sources: 3 });
    expect(idx.memberIds('s:5')).toEqual(['s:1', 's:3', 's:4', 's:5']);
    expect(idx.rowChannel('s:2')!.name).toBe('Example News');
    const off = new ChannelIndex(channels);
    expect(off.rowChannel('s:5')!.name).toBe('Channel One 4K');
    expect(off.memberIds('s:5')).toEqual(['s:5']);
    expect(off.memberIds('nope')).toEqual([]);
  });
  test('withLayout keeps the folds', () => {
    const idx = new ChannelIndex(channels, undefined, undefined, fold);
    idx.slice('all', 0, 10);
    const next = idx.withLayout(lay({ op: 'addToList', listId: 'fav', channelIds: ['s:4'] }));
    expect(next.folding()).toBe(true);
    expect(ids(next.slice('fav', 0, 10))).toEqual(['s:1']);
    expect(ids(next.slice('all', 0, 10))).toEqual(['s:1', 's:2', 's:6']);
  });
});
