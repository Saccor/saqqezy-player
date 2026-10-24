import { describe, expect, it } from 'vitest';
import type { CompanionChannel, CompanionState } from '@iptv/companion-protocol';
import { applyOps, emptyLayout, type Layout } from '@iptv/core';
import { canHideNoEpg, channelLabel, groupChannels, GroupModel, groupShowOps, providerGroups, sortChangeOps } from './groups.ts';

const ch = (id: string, name: string, group: string, number: number, hasEpg = true): CompanionChannel =>
  ({ id, name, group, number, hasEpg });

const CHANNELS = [
  ch('a1', 'Zeta', 'Alpha', 3),
  ch('b1', 'Beta One', 'Bravo', 10),
  ch('a2', 'alpha two', 'Alpha', 1),
  ch('a3', 'Mid', 'Alpha', 2),
];

const lay = (ops: Parameters<typeof applyOps>[1]): Layout => applyOps(emptyLayout(), ops).layout;

describe('providerGroups', () => {
  it('lists groups in provider order with counts, names and hidden flags from the layout', () => {
    const m = new GroupModel(CHANNELS);
    expect(providerGroups(m, emptyLayout())).toEqual([
      { id: 'g:Alpha', name: 'Alpha', providerName: 'Alpha', count: 3, hidden: false, regionHidden: false, shown: false },
      { id: 'g:Bravo', name: 'Bravo', providerName: 'Bravo', count: 1, hidden: false, regionHidden: false, shown: false },
    ]);
    const l = lay([
      { op: 'setGroupOrder', ids: ['g:Bravo'] },
      { op: 'renameGroup', id: 'g:Alpha', name: 'First' },
      { op: 'hideGroups', ids: ['g:Alpha'] },
    ]);
    expect(providerGroups(m, l)).toEqual([
      { id: 'g:Bravo', name: 'Bravo', providerName: 'Bravo', count: 1, hidden: false, regionHidden: false, shown: false },
      { id: 'g:Alpha', name: 'First', providerName: 'Alpha', count: 3, hidden: true, regionHidden: false, shown: false },
    ]);
  });

  it('with your countries on, the chosen groups come in pick order', () => {
    const m = new GroupModel([ch('s1', 'One', 'SE | A', 1), ch('d1', 'Two', 'DK | B', 2), ch('o1', 'Three', 'Other', 3)]);
    const regions = { mode: 'first' as const, codes: ['DK', 'SE'], keys: { 'g:SE | A': ['SE'], 'g:DK | B': ['DK'] } };
    expect(providerGroups(m, emptyLayout(), regions).map((g) => g.id)).toEqual(['g:DK | B', 'g:SE | A', 'g:Other']);
  });
});

describe('groupChannels (the TV order)', () => {
  const m = new GroupModel(CHANNELS);
  const ids = (l: Layout) => groupChannels(m, 'g:Alpha', l).map((c) => c.id);

  it('uses the provider order by default', () => {
    expect(ids(emptyLayout())).toEqual(['a1', 'a2', 'a3']);
  });

  it('sorts by number or by name (renames included)', () => {
    expect(ids(lay([{ op: 'setSort', groupId: 'g:Alpha', mode: 'number' }]))).toEqual(['a2', 'a3', 'a1']);
    expect(ids(lay([{ op: 'setSort', groupId: 'g:Alpha', mode: 'name' }]))).toEqual(['a2', 'a3', 'a1']);
    expect(ids(lay([
      { op: 'setSort', groupId: 'g:Alpha', mode: 'name' },
      { op: 'renameChannel', id: 'a1', name: 'Aardvark' },
    ]))).toEqual(['a1', 'a2', 'a3']);
  });

  it('puts the manual order first, then the rest in sort order', () => {
    expect(ids(lay([{ op: 'setChannelOrder', groupId: 'g:Alpha', ids: ['a3', 'zz'] }]))).toEqual(['a3', 'a1', 'a2']);
  });
});

describe('channelLabel', () => {
  it('prefers the layout rename, then the original name (displayName as a fallback without a layout)', () => {
    const c: CompanionChannel = { ...ch('x', 'Orig', 'G', 1), displayName: 'Stale' };
    expect(channelLabel(c, lay([{ op: 'renameChannel', id: 'x', name: 'New' }]))).toBe('New');
    expect(channelLabel(c, emptyLayout())).toBe('Orig');
    expect(channelLabel(c, undefined)).toBe('Stale');
  });
});

describe('canHideNoEpg', () => {
  const state = (coverageKnown: boolean, channels: CompanionChannel[]): Pick<CompanionState, 'coverageKnown' | 'channels'> =>
    ({ coverageKnown, channels });
  it('is off until a guide exists', () => {
    expect(canHideNoEpg(state(false, CHANNELS))).toBe(false);
    expect(canHideNoEpg(state(true, CHANNELS))).toBe(true);
    expect(canHideNoEpg(state(false, [ch('n', 'N', 'G', 1, false)]))).toBe(true);
  });
});

describe('sortChangeOps', () => {
  it('asks before a sort replaces a custom order, and does nothing when the answer is no', () => {
    const asked: string[] = [];
    const no = (q: string) => { asked.push(q); return false; };
    expect(sortChangeOps('g:A', 'name', true, no)).toBeUndefined();
    expect(asked).toEqual(['This replaces your custom order. Continue?']);
  });

  it('replaces the custom order when confirmed', () => {
    expect(sortChangeOps('g:A', 'number', true, () => true)).toEqual([
      { op: 'setSort', groupId: 'g:A', mode: 'number' },
      { op: 'setChannelOrder', groupId: 'g:A', ids: null },
    ]);
  });

  it('does not ask without a custom order', () => {
    let asked = false;
    expect(sortChangeOps('g:A', 'name', false, () => { asked = true; return false; })).toEqual([
      { op: 'setSort', groupId: 'g:A', mode: 'name' },
    ]);
    expect(asked).toBe(false);
  });
});

describe('providerGroups with your countries (protocol 3)', () => {
  const R = [ch('s1', 'Synthetic One', 'SE News', 1), ch('d1', 'Synthetic Two', 'DK News', 2), ch('m1', 'Synthetic Three', 'Mixed', 3), ch('s2', 'Synthetic Four', 'SE Kids', 4)];
  const keys = { 'g:SE News': ['SE'], 'g:DK News': ['DK'], 'g:SE Kids': ['SE'] };

  it('only: other countries are region-hidden (not user-hidden); shown beats the rule; chosen first', () => {
    const m = new GroupModel(R);
    const v = providerGroups(m, emptyLayout(), { mode: 'only', codes: ['SE'], keys });
    expect(v.map((g) => [g.id, g.hidden, g.regionHidden])).toEqual([
      ['g:SE News', false, false], ['g:SE Kids', false, false], ['g:DK News', false, true], ['g:Mixed', false, false],
    ]);
    const shown = providerGroups(m, lay([{ op: 'showGroups', ids: ['g:DK News'] }]), { mode: 'only', codes: ['SE'], keys });
    expect(shown.find((g) => g.id === 'g:DK News')).toMatchObject({ regionHidden: false, shown: true });
  });

  it('without regions (older TV): exactly the old view, with the new flags false', () => {
    const m = new GroupModel(R);
    expect(providerGroups(m, emptyLayout()).map((g) => g.id)).toEqual(['g:SE News', 'g:DK News', 'g:Mixed', 'g:SE Kids']);
    expect(providerGroups(m, emptyLayout()).every((g) => !g.regionHidden && !g.shown)).toBe(true);
  });

  it('a layout from an older TV (schema 1, no shownGroups) is read safely', () => {
    const m = new GroupModel(R);
    const old = { ...emptyLayout() } as Partial<Layout>;
    delete old.shownGroups;
    delete old.groupRegion;
    expect(() => providerGroups(m, old as Layout, { mode: 'only', codes: ['SE'], keys })).not.toThrow();
  });

  it('groupShowOps: show uses showGroups on protocol 3 TVs, unhideGroups on older ones; hide is hideGroups', () => {
    const m = new GroupModel(R);
    const dk = providerGroups(m, emptyLayout(), { mode: 'only', codes: ['SE'], keys }).find((g) => g.id === 'g:DK News')!;
    expect(groupShowOps(dk, true, 3)).toEqual([{ op: 'showGroups', ids: ['g:DK News'] }]);
    expect(groupShowOps(dk, true, 2)).toEqual([{ op: 'unhideGroups', ids: ['g:DK News'] }]);
    expect(groupShowOps(dk, false, 3)).toEqual([{ op: 'hideGroups', ids: ['g:DK News'] }]);
    const se = providerGroups(m, lay([{ op: 'hideGroups', ids: ['g:SE News'] }]), { mode: 'only', codes: ['SE'], keys })[0]!;
    // Not region-hidden: unhiding returns it to the rule, which shows it.
    expect(groupShowOps(se, true, 3)).toEqual([{ op: 'unhideGroups', ids: ['g:SE News'] }]);
  });
});
