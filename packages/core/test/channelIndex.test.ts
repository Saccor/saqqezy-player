import { describe, expect, test } from 'vitest';
import { ChannelIndex } from '../src/index/channelIndex.ts';
import { applyOps, emptyLayout, type Layout, type LayoutOp } from '../src/layout/index.ts';
import { layoutFromFlags } from '../src/layout/migrate.ts';
import { epgKey } from '../src/epg/window.ts';
import type { Channel } from '../src/types.ts';

function ch(n: number, group: string, name = `Channel ${String(n).padStart(3, '0')}`, epgId?: string): Channel {
  const c: Channel = { id: `s:${n}`, sourceId: 's', name, url: `http://example.test/${n}.ts`, group, number: n };
  if (epgId) c.epgId = epgId;
  return c;
}
const channels = [ch(3, 'News'), ch(1, 'Movies'), ch(2, 'News', 'Nyheter Åtta'), ch(4, 'Kids')];

function lay(...ops: LayoutOp[]): Layout {
  return applyOps(emptyLayout(), ops).layout;
}
const ids = (cs: readonly Channel[]): string[] => cs.map((c) => c.id);

describe('ChannelIndex – v1 behaviour', () => {
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
    expect(ids(idx.search('ATTA', 10))).toEqual(['s:2']);
    expect(ids(idx.search('nyheter', 10))).toEqual(['s:2']);
    expect(idx.search('channel 00', 2)).toHaveLength(2);
    expect(idx.search('  ', 10)).toEqual([]);
  });

  test('recent appears after the lists only when it has visible channels', () => {
    expect(new ChannelIndex(channels).groups().some((g) => g.id === 'recent')).toBe(false);
    const idx = new ChannelIndex(channels, lay({ op: 'markWatched', id: 's:2' }));
    const g = idx.groups();
    expect(g.map((x) => x.id).slice(0, 3)).toEqual(['fav', 'recent', 'all']);
    expect(g[1]).toEqual({ id: 'recent', name: 'Recently watched', count: 1 });
    const hidden = new ChannelIndex(channels, lay({ op: 'markWatched', id: 's:2' }, { op: 'hideChannels', ids: ['s:2'] }));
    expect(hidden.groups().some((x) => x.id === 'recent')).toBe(false);
  });

  test('recent follows the visibility rules: hidden groups and no-EPG are excluded, hidden channels always, user lists are exempt', () => {
    const cov = new Set([epgKey(channels[0]!)]); // only s:3 has guide data
    const base = lay(
      { op: 'markWatched', id: 's:1' }, { op: 'markWatched', id: 's:3' }, { op: 'markWatched', id: 's:4' },
      { op: 'addToList', listId: 'fav', channelIds: ['s:1', 's:4'] },
    );
    expect(ids(new ChannelIndex(channels, base).slice('recent', 0, 5))).toEqual(['s:4', 's:3', 's:1']);
    const groupHidden = applyOps(base, [{ op: 'hideGroups', ids: ['g:Movies'] }]).layout;
    const gi = new ChannelIndex(channels, groupHidden);
    expect(ids(gi.slice('recent', 0, 5))).toEqual(['s:4', 's:3']);
    expect(ids(gi.slice('fav', 0, 5))).toEqual(['s:1', 's:4']);
    const noEpg = applyOps(base, [{ op: 'setHideNoEpg', value: true }]).layout;
    const ni = new ChannelIndex(channels, noEpg, cov);
    expect(ids(ni.slice('recent', 0, 5))).toEqual(['s:3']);
    expect(ids(ni.slice('fav', 0, 5))).toEqual(['s:1', 's:4']);
    const chHidden = applyOps(base, [{ op: 'hideChannels', ids: ['s:3'] }]).layout;
    expect(ids(new ChannelIndex(channels, chHidden).slice('recent', 0, 5))).toEqual(['s:4', 's:1']);
  });

  test('recent keeps most-recent-first order', () => {
    const idx = new ChannelIndex(channels, lay(
      { op: 'markWatched', id: 's:1' }, { op: 'markWatched', id: 's:4' }, { op: 'markWatched', id: 's:3' },
    ));
    expect(ids(idx.slice('recent', 0, 5))).toEqual(['s:3', 's:4', 's:1']);
  });
});

describe('ChannelIndex – lists', () => {
  test('favourites keep list order; unknown ids are kept in the layout but not shown', () => {
    const l = lay({ op: 'addToList', listId: 'fav', channelIds: ['s:4', 'gone:1', 's:1'] });
    const idx = new ChannelIndex(channels, l);
    expect(ids(idx.slice('fav', 0, 10))).toEqual(['s:4', 's:1']);
    expect(idx.groupSize('fav')).toBe(2);
    expect(idx.layout().lists[0]!.channelIds).toEqual(['s:4', 'gone:1', 's:1']);
    expect(idx.layout()).toBe(l);
  });

  test('user lists follow layout.lists order, use list:<id> ids, and show even when empty', () => {
    const l = lay(
      { op: 'renameList', listId: 'fav', name: 'Mine' },
      { op: 'createList', id: 'a', name: 'Alpha' },
      { op: 'createList', id: 'b', name: 'Beta' },
      { op: 'addToList', listId: 'b', channelIds: ['s:2'] },
      { op: 'markWatched', id: 's:1' },
    );
    const idx = new ChannelIndex(channels, l);
    expect(idx.groups().slice(0, 5)).toEqual([
      { id: 'fav', name: 'Mine', count: 0 },
      { id: 'list:a', name: 'Alpha', count: 0 },
      { id: 'list:b', name: 'Beta', count: 1 },
      { id: 'recent', name: 'Recently watched', count: 1 },
      { id: 'all', name: 'All channels', count: 4 },
    ]);
    expect(ids(idx.slice('list:b', 0, 10))).toEqual(['s:2']);
  });

  test('lists keep channels from hidden groups and without EPG; hidden channels stay hidden', () => {
    const l = lay(
      { op: 'addToList', listId: 'fav', channelIds: ['s:4', 's:3', 's:1'] },
      { op: 'hideGroups', ids: ['g:Kids'] },
      { op: 'hideChannels', ids: ['s:1'] },
      { op: 'setHideNoEpg', value: true },
    );
    const idx = new ChannelIndex(channels, l, new Set<string>());
    expect(ids(idx.slice('fav', 0, 10))).toEqual(['s:4', 's:3']);
    expect(idx.groups()[0]).toEqual({ id: 'fav', name: 'Favourites', count: 2 });
  });

  test('lists sort by number or name when the mode is not provider', () => {
    const l = lay(
      { op: 'createList', id: 'x', name: 'X' },
      { op: 'addToList', listId: 'x', channelIds: ['s:4', 's:2', 's:1'] },
      { op: 'setSort', groupId: 'list:x', mode: 'number' },
      { op: 'addToList', listId: 'fav', channelIds: ['s:2', 's:4', 's:1'] },
      { op: 'setSort', groupId: 'fav', mode: 'name' },
    );
    const idx = new ChannelIndex(channels, l);
    expect(ids(idx.slice('list:x', 0, 10))).toEqual(['s:1', 's:2', 's:4']);
    // Channel 001, Channel 004, Nyheter Åtta
    expect(ids(idx.slice('fav', 0, 10))).toEqual(['s:1', 's:4', 's:2']);
  });
});

describe('ChannelIndex – visibility', () => {
  test('hidden channels disappear from groups, all, search and byNumber; empty groups are omitted', () => {
    const idx = new ChannelIndex(channels, lay({ op: 'hideChannels', ids: ['s:4'] }));
    expect(idx.groups().map((g) => g.id)).toEqual(['fav', 'all', 'g:News', 'g:Movies']);
    expect(idx.byNumber(4)).toBeUndefined();
    expect(ids(idx.search('channel', 10))).not.toContain('s:4');
    expect(ids(idx.hiddenChannels())).toEqual(['s:4']);
    expect(idx.groupSize('all')).toBe(3);
  });

  test('hidden groups disappear from groups, all, search and byNumber', () => {
    const idx = new ChannelIndex(channels, lay({ op: 'hideGroups', ids: ['g:News'] }));
    expect(idx.groups().map((g) => g.id)).toEqual(['fav', 'all', 'g:Movies', 'g:Kids']);
    expect(ids(idx.slice('all', 0, 10))).toEqual(['s:1', 's:4']);
    expect(idx.byNumber(3)).toBeUndefined();
    expect(idx.search('nyheter', 10)).toEqual([]);
    expect(idx.groupSize('g:News')).toBe(0);
  });

  test('hideNoEpg drops channels whose epgKey is not covered, only when coverage is known', () => {
    const cs = [ch(1, 'A', 'One', 'one.example'), ch(2, 'A', 'Two'), ch(3, 'B', 'Three')];
    const covered = new Set<string>(['one.example', epgKey(cs[1]!)]);
    const l = lay({ op: 'setHideNoEpg', value: true });
    const idx = new ChannelIndex(cs, l, covered);
    expect(ids(idx.slice('all', 0, 10))).toEqual(['s:1', 's:2']);
    expect(idx.groups().map((g) => g.id)).toEqual(['fav', 'all', 'g:A']);
    expect(new ChannelIndex(cs, l).groupSize('all')).toBe(3);
    expect(new ChannelIndex(cs, emptyLayout(), covered).groupSize('all')).toBe(3);
  });

  test('EPG coverage uses the original name, not the renamed display name', () => {
    const cs = [ch(1, 'A', 'Two')];
    const l = lay({ op: 'setHideNoEpg', value: true }, { op: 'renameChannel', id: 's:1', name: 'Renamed' });
    const idx = new ChannelIndex(cs, l, new Set([epgKey(cs[0]!)]));
    expect(idx.groupSize('all')).toBe(1);
  });

  test('hiddenGroupInfos lists hidden provider groups with counts', () => {
    const l = lay({ op: 'hideGroups', ids: ['g:News', 'g:Gone'] }, { op: 'renameGroup', id: 'g:News', name: 'Updates' });
    const idx = new ChannelIndex(channels, l);
    expect(idx.hiddenGroupInfos()).toEqual([{ id: 'g:News', name: 'Updates', count: 2 }]);
  });

  test('allProviderGroups reports every provider group with its state', () => {
    const l = lay({ op: 'hideGroups', ids: ['g:Kids'] }, { op: 'renameGroup', id: 'g:News', name: 'Updates' });
    const idx = new ChannelIndex(channels, l);
    expect(idx.allProviderGroups()).toEqual([
      { id: 'g:News', name: 'Updates', providerName: 'News', count: 2, hidden: false, regionHidden: false, shown: false, regions: [] },
      { id: 'g:Movies', name: 'Movies', providerName: 'Movies', count: 1, hidden: false, regionHidden: false, shown: false, regions: [] },
      { id: 'g:Kids', name: 'Kids', providerName: 'Kids', count: 1, hidden: true, regionHidden: false, shown: false, regions: [] },
    ]);
  });
});

describe('ChannelIndex – renames', () => {
  test('channel renames apply to every returned channel and to search; original name still matches', () => {
    const idx = new ChannelIndex(channels, lay({ op: 'renameChannel', id: 's:3', name: 'Zebra' }));
    expect(idx.displayName('s:3')).toBe('Zebra');
    expect(idx.displayName('s:1')).toBe('Channel 001');
    expect(idx.get('s:3')?.name).toBe('Zebra');
    expect(idx.slice('all', 2, 1)[0]?.name).toBe('Zebra');
    expect(idx.slice('g:News', 0, 1)[0]?.name).toBe('Zebra');
    expect(idx.byNumber(3)?.name).toBe('Zebra');
    expect(ids(idx.search('zebra', 10))).toEqual(['s:3']);
    expect(ids(idx.search('channel 003', 10))).toEqual(['s:3']);
    expect(channels[0]!.name).toBe('Channel 003');
  });

  test('group renames change the group name only', () => {
    const idx = new ChannelIndex(channels, lay({ op: 'renameGroup', id: 'g:Kids', name: 'Family' }));
    expect(idx.groups().find((g) => g.id === 'g:Kids')).toEqual({ id: 'g:Kids', name: 'Family', count: 1 });
  });
});

describe('ChannelIndex – ordering', () => {
  const cs = [ch(5, 'G', 'beta'), ch(2, 'G', 'Alpha 10'), ch(9, 'G', 'alpha 9'), ch(1, 'H', 'Delta')];

  test('provider groups default to playlist order, all defaults to number', () => {
    const idx = new ChannelIndex(cs);
    expect(ids(idx.slice('g:G', 0, 10))).toEqual(['s:5', 's:2', 's:9']);
    expect(ids(idx.slice('all', 0, 10))).toEqual(['s:1', 's:2', 's:5', 's:9']);
  });

  test('number sort', () => {
    const idx = new ChannelIndex(cs, lay({ op: 'setSort', groupId: 'g:G', mode: 'number' }));
    expect(ids(idx.slice('g:G', 0, 10))).toEqual(['s:2', 's:5', 's:9']);
  });

  test('name sort is case-insensitive and numeric-aware, and uses display names', () => {
    const idx = new ChannelIndex(cs, lay({ op: 'setSort', groupId: 'g:G', mode: 'name' }));
    expect(ids(idx.slice('g:G', 0, 10))).toEqual(['s:9', 's:2', 's:5']);
    const renamed = new ChannelIndex(cs, lay(
      { op: 'setSort', groupId: 'g:G', mode: 'name' }, { op: 'renameChannel', id: 's:5', name: 'aardvark' },
    ));
    expect(ids(renamed.slice('g:G', 0, 10))).toEqual(['s:5', 's:9', 's:2']);
  });

  test('all can be sorted by provider order or name', () => {
    expect(ids(new ChannelIndex(cs, lay({ op: 'setSort', groupId: 'all', mode: 'provider' })).slice('all', 0, 10)))
      .toEqual(['s:5', 's:2', 's:9', 's:1']);
    expect(ids(new ChannelIndex(cs, lay({ op: 'setSort', groupId: 'all', mode: 'name' })).slice('all', 0, 10)))
      .toEqual(['s:9', 's:2', 's:5', 's:1']);
  });

  test('manual channel order puts listed (existing, visible, member) ids first, then the sort order', () => {
    const l = lay(
      { op: 'setChannelOrder', groupId: 'g:G', ids: ['s:9', 'gone', 's:1', 's:5'] },
      { op: 'setSort', groupId: 'g:G', mode: 'number' },
    );
    const idx = new ChannelIndex([...cs, ch(7, 'G', 'x'), ch(3, 'G', 'y')], l);
    expect(ids(idx.slice('g:G', 0, 10))).toEqual(['s:9', 's:5', 's:2', 's:3', 's:7']);
    const hidden = new ChannelIndex(cs, applyOps(l, [{ op: 'hideChannels', ids: ['s:9'] }]).layout);
    expect(ids(hidden.slice('g:G', 0, 10))).toEqual(['s:5', 's:2']);
  });

  test('manual order on a list', () => {
    const l = lay(
      { op: 'addToList', listId: 'fav', channelIds: ['s:1', 's:2', 's:5'] },
      { op: 'setChannelOrder', groupId: 'fav', ids: ['s:5'] },
    );
    expect(ids(new ChannelIndex(cs, l).slice('fav', 0, 10))).toEqual(['s:5', 's:1', 's:2']);
  });

  test('groupOrder puts listed existing groups first, then the rest in provider order', () => {
    const many = [ch(1, 'A'), ch(2, 'B'), ch(3, 'C'), ch(4, 'D')];
    const idx = new ChannelIndex(many, lay({ op: 'setGroupOrder', ids: ['g:C', 'g:Gone', 'g:A'] }));
    expect(idx.groups().map((g) => g.id)).toEqual(['fav', 'all', 'g:C', 'g:A', 'g:B', 'g:D']);
  });

  test('neighbour and indexOf follow the effective order', () => {
    const idx = new ChannelIndex(cs, lay({ op: 'setSort', groupId: 'g:G', mode: 'name' }));
    expect(idx.indexOf('g:G', 's:5')).toBe(2);
    expect(idx.neighbour('g:G', 's:5', 1)?.id).toBe('s:9');
  });
});

describe('ChannelIndex – v1 flags compatibility', () => {
  test('constructor accepts v1 UserFlags and flags() maps back', () => {
    const idx = new ChannelIndex(channels, { favourites: ['s:1', 'gone:1'], hidden: ['gone:2'], recent: ['gone:3', 's:4'] });
    expect(idx.groupSize('fav')).toBe(1);
    expect(ids(idx.slice('recent', 0, 5))).toEqual(['s:4']);
    expect(idx.flags()).toEqual({ favourites: ['s:1', 'gone:1'], hidden: ['gone:2'], recent: ['gone:3', 's:4'] });
  });

  test('flags without recent still load', () => {
    const idx = new ChannelIndex(channels, { favourites: [], hidden: [] });
    expect(idx.flags().recent ?? []).toEqual([]);
  });

  test('withLayout rebuilds over the same channels', () => {
    const idx = new ChannelIndex(channels);
    const next = idx.withLayout(applyOps(idx.layout(), [{ op: 'addToList', listId: 'fav', channelIds: ['s:2'] }]).layout);
    expect(ids(next.slice('fav', 0, 5))).toEqual(['s:2']);
    expect(idx.groupSize('fav')).toBe(0);
  });

  test('withLayout after markWatched updates recent and keeps every other group correct', () => {
    const l0 = lay({ op: 'addToList', listId: 'fav', channelIds: ['s:2'] }, { op: 'renameChannel', id: 's:1', name: 'Zed' });
    const idx = new ChannelIndex(channels, l0);
    idx.groups(); idx.slice('g:News', 0, 5); idx.slice('recent', 0, 5);
    const next = idx.withLayout(applyOps(l0, [{ op: 'markWatched', id: 's:1' }]).layout);
    expect(ids(next.slice('recent', 0, 5))).toEqual(['s:1']);
    expect(next.slice('recent', 0, 5)[0]!.name).toBe('Zed');
    expect(ids(next.slice('fav', 0, 5))).toEqual(['s:2']);
    expect(ids(next.slice('g:News', 0, 5))).toEqual(ids(idx.slice('g:News', 0, 5)));
    expect(idx.groupSize('recent')).toBe(0);
  });

  test('the layout is a frozen snapshot', () => {
    const idx = new ChannelIndex(channels, lay({ op: 'markWatched', id: 's:1' }));
    expect(Object.isFrozen(idx.layout())).toBe(true);
    expect(Object.isFrozen(idx.withLayout(emptyLayout()).layout())).toBe(true);
    expect(Object.isFrozen(new ChannelIndex(channels, { favourites: [], hidden: [] }).layout())).toBe(true);
  });
});

describe('layoutFromFlags', () => {
  test('favourites become the fav list, hidden becomes hiddenChannels, recent carries over', () => {
    const l = layoutFromFlags({ favourites: ['a', 'b', 'a'], hidden: ['c'], recent: ['d', 'e'] });
    expect(l.lists).toEqual([{ id: 'fav', name: 'Favourites', channelIds: ['a', 'b'] }]);
    expect(l.hiddenChannels).toEqual(['c']);
    expect(l.recent).toEqual(['d', 'e']);
    expect(l.version).toBe(0);
  });

  test('missing recent and over-long recent are handled', () => {
    expect(layoutFromFlags({ favourites: [], hidden: [] }).recent).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => `r${i}`);
    expect(layoutFromFlags({ favourites: [], hidden: [], recent: many }).recent).toHaveLength(20);
  });
});

describe('ChannelIndex – search keys and epgKey lookup', () => {
  test('search folds ø/æ and treats punctuation as spaces; prefix matches come first', () => {
    const cs = [ch(1, 'A', 'Sport Øst'), ch(2, 'A', 'Night-News'), ch(3, 'A', 'Late Night News'), ch(4, 'A', 'Aerial')];
    const idx = new ChannelIndex(cs);
    expect(ids(idx.search('ost', 10))).toEqual(['s:1']);
    expect(ids(idx.search('night news', 10))).toEqual(['s:2', 's:3']);
    expect(ids(idx.search('æ', 10))).toEqual(['s:4']);
  });

  test('channelsForEpgKey: shared key maps to every visible channel, number order, renames applied', () => {
    const cs = [ch(5, 'A', 'Five', 'x.test'), ch(2, 'B', 'Two', 'x.test'), ch(3, 'A', 'Three', 'y.test'), ch(4, 'A', 'No Id')];
    const idx = new ChannelIndex(cs, lay({ op: 'renameChannel', id: 's:5', name: 'Renamed Five' }));
    expect(idx.channelsForEpgKey('x.test').map((c) => [c.id, c.name])).toEqual([['s:2', 'Two'], ['s:5', 'Renamed Five']]);
    expect(ids(idx.channelsForEpgKey('name:no id'))).toEqual(['s:4']);
    expect(idx.channelsForEpgKey('missing')).toEqual([]);
  });

  test('channelsForEpgKey: nothing hidden or renamed returns the same array per key, no copy per call', () => {
    const cs = [ch(1, 'A', 'One', 'x.test'), ch(2, 'B', 'Two', 'x.test'), ch(3, 'A', 'Three', 'y.test')];
    const idx = new ChannelIndex(cs);
    const first = idx.channelsForEpgKey('x.test');
    expect(ids(first)).toEqual(['s:1', 's:2']);
    expect(idx.channelsForEpgKey('x.test')).toBe(first);
    expect(idx.channelsForEpgKey('missing')).toBe(idx.channelsForEpgKey('other missing'));
    // Hiding or renaming one channel: filtered and renamed results again.
    expect(ids(idx.withLayout(lay({ op: 'hideChannels', ids: ['s:1'] })).channelsForEpgKey('x.test'))).toEqual(['s:2']);
    expect(idx.withLayout(lay({ op: 'renameChannel', id: 's:2', name: 'Renamed' })).channelsForEpgKey('x.test').map((c) => c.name))
      .toEqual(['One', 'Renamed']);
    expect(new ChannelIndex(cs, { ...emptyLayout(), hideNoEpg: true }, new Set(['y.test'])).channelsForEpgKey('x.test')).toEqual([]);
  });

  test('channelsForEpgKey excludes hidden channels and hidden groups', () => {
    const cs = [ch(1, 'A', 'One', 'x.test'), ch(2, 'B', 'Two', 'x.test'), ch(3, 'A', 'Three', 'x.test')];
    const idx = new ChannelIndex(cs, lay({ op: 'hideChannels', ids: ['s:1'] }, { op: 'hideGroups', ids: ['g:B'] }));
    expect(ids(idx.channelsForEpgKey('x.test'))).toEqual(['s:3']);
  });
});
