import { describe, expect, it } from 'vitest';
import type { CompanionChannel, CompanionState } from '@iptv/companion-protocol';
import { applyOps, emptyLayout, type Layout } from '@iptv/core';
import { canHideNoEpg, channelLabel, groupChannels, GroupModel, providerGroups, sortChangeOps } from './groups.ts';

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
      { id: 'g:Alpha', name: 'Alpha', providerName: 'Alpha', count: 3, hidden: false },
      { id: 'g:Bravo', name: 'Bravo', providerName: 'Bravo', count: 1, hidden: false },
    ]);
    const l = lay([
      { op: 'setGroupOrder', ids: ['g:Bravo'] },
      { op: 'renameGroup', id: 'g:Alpha', name: 'First' },
      { op: 'hideGroups', ids: ['g:Alpha'] },
    ]);
    expect(providerGroups(m, l)).toEqual([
      { id: 'g:Bravo', name: 'Bravo', providerName: 'Bravo', count: 1, hidden: false },
      { id: 'g:Alpha', name: 'First', providerName: 'Alpha', count: 3, hidden: true },
    ]);
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
