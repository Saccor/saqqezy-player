import { describe, expect, test } from 'vitest';
import { ChannelIndex, type ChannelRegionView } from '../src/index/channelIndex.ts';
import { applyOps, emptyLayout, type LayoutOp } from '../src/layout/index.ts';
import { buildRegionsRecord } from '../src/text/regions.ts';
import type { Channel } from '../src/types.ts';

const ch = (n: number, name: string, group: string, epgId?: string): Channel => {
  const c: Channel = { id: `s:${n}`, sourceId: 's', name, url: `http://example.test/${n}.ts`, group, number: n };
  if (epgId) c.epgId = epgId;
  return c;
};
const channels = [
  ch(1, 'Synthetic News', 'DK | News', 'one'),
  ch(2, 'Synthetic Docs', 'DK | Docs'),
  ch(3, 'Synthetic News', 'SE | News', 'one'),
  ch(4, 'Synthetic Kids', 'SE | Kids'),
  ch(5, 'Synthetic Mix', 'Mixed Bag'),
  ch(6, 'Synthetic Film', 'FI | Film'),
  ch(7, 'Synthetic Weekly', 'Weekly (PL)'),
];
const detected = buildRegionsRecord(channels).groups;
const view = (mode: ChannelRegionView['mode'], codes: string[]): ChannelRegionView => ({ detected, mode, codes });
const lay = (...ops: LayoutOp[]) => applyOps(emptyLayout(), ops).layout;
const groupIds = (idx: ChannelIndex) => idx.groups().filter((g) => g.id.startsWith('g:')).map((g) => g.id);

describe('ChannelIndex regions', () => {
  test('off, or no regions given: exactly today', () => {
    const plain = new ChannelIndex(channels);
    const off = new ChannelIndex(channels, undefined, undefined, { regions: view('off', ['SE']) });
    expect(off.groups()).toEqual(plain.groups());
    expect(off.slice('all', 0, 20)).toEqual(plain.slice('all', 0, 20));
    expect(off.regionState()).toEqual({ mode: 'off', requested: 'off', stale: false });
  });

  test('first: chosen countries first in provider order, then the rest; nothing hidden', () => {
    const idx = new ChannelIndex(channels, undefined, undefined, { regions: view('first', ['SE', 'FI']) });
    expect(groupIds(idx)).toEqual(['g:SE | News', 'g:SE | Kids', 'g:FI | Film', 'g:DK | News', 'g:DK | Docs', 'g:Mixed Bag', 'g:Weekly (PL)']);
    expect(idx.groupSize('all')).toBe(7);
    const infos = idx.groups().filter((g) => g.id.startsWith('g:'));
    expect(infos.find((g) => g.id === 'g:SE | News')?.other).toBeUndefined();
    expect(infos.find((g) => g.id === 'g:DK | News')?.other).toBe(true);
  });

  test('first never overrides the user order', () => {
    const l = lay({ op: 'setGroupOrder', ids: ['g:Mixed Bag', 'g:DK | Docs'] });
    const idx = new ChannelIndex(channels, l, undefined, { regions: view('first', ['SE']) });
    expect(groupIds(idx)).toEqual(['g:Mixed Bag', 'g:DK | Docs', 'g:SE | News', 'g:SE | Kids', 'g:DK | News', 'g:FI | Film', 'g:Weekly (PL)']);
  });

  test('only: other countries hidden by rule, undetected and not-sure groups stay, never written to hiddenGroups', () => {
    const idx = new ChannelIndex(channels, undefined, undefined, { regions: view('only', ['SE']) });
    expect(groupIds(idx)).toEqual(['g:SE | News', 'g:SE | Kids', 'g:Mixed Bag', 'g:Weekly (PL)']);
    expect(idx.groupSize('all')).toBe(4);
    expect(idx.layout().hiddenGroups).toEqual([]);
    const pg = idx.allProviderGroups();
    expect(pg.find((g) => g.id === 'g:DK | News')).toMatchObject({ hidden: false, regionHidden: true, regions: ['DK'] });
    expect(pg.find((g) => g.id === 'g:Weekly (PL)')).toMatchObject({ regionHidden: false, regions: [] });
    expect(idx.search('synthetic', 20).map((c) => c.id)).not.toContain('s:2');
  });

  test('searchRuleHidden: matches only the region rule hides, counted, prefix first, user-hidden never', () => {
    const l = lay({ op: 'hideChannels', ids: ['s:6'] });
    const idx = new ChannelIndex(channels, undefined, undefined, { regions: view('only', ['SE']) });
    expect(idx.searchRuleHidden('synthetic', 20)).toEqual({ count: 3, channels: [channels[0], channels[1], channels[5]] });
    expect(idx.searchRuleHidden('docs', 20)).toEqual({ count: 1, channels: [channels[1]] });
    expect(idx.searchRuleHidden('synthetic', 1)).toEqual({ count: 3, channels: [channels[0]] });
    expect(idx.searchRuleHidden('', 20)).toEqual({ count: 0, channels: [] });
    const user = new ChannelIndex(channels, lay({ op: 'hideGroups', ids: ['g:DK | Docs'] }), undefined, { regions: view('only', ['SE']) });
    expect(user.searchRuleHidden('docs', 20)).toEqual({ count: 0, channels: [] });
    const hiddenCh = new ChannelIndex(channels, l, undefined, { regions: view('only', ['SE']) });
    expect(hiddenCh.searchRuleHidden('film', 20).count).toBe(0);
    const first = new ChannelIndex(channels, undefined, undefined, { regions: view('first', ['SE']) });
    expect(first.searchRuleHidden('synthetic', 20)).toEqual({ count: 0, channels: [] });
    const folded = new ChannelIndex(channels, undefined, undefined, { fold: true, regions: view('only', ['SE']) });
    expect(folded.searchRuleHidden('news', 20)).toEqual({ count: 1, channels: [channels[0]] });
  });

  test('hidden beats shown beats the rule; groupRegion overrides detection', () => {
    const l = lay(
      { op: 'showGroups', ids: ['g:DK | Docs'] },
      { op: 'hideGroups', ids: ['g:SE | Kids'] },
      { op: 'setGroupRegion', id: 'g:Mixed Bag', codes: ['DK'] },
      { op: 'setGroupRegion', id: 'g:FI | Film', codes: ['SE'] },
    );
    const idx = new ChannelIndex(channels, l, undefined, { regions: view('only', ['SE']) });
    expect(groupIds(idx)).toEqual(['g:SE | News', 'g:FI | Film', 'g:DK | Docs', 'g:Weekly (PL)']);
    expect(idx.allProviderGroups().find((g) => g.id === 'g:SE | Kids')).toMatchObject({ hidden: true });
    expect(idx.allProviderGroups().find((g) => g.id === 'g:DK | Docs')).toMatchObject({ shown: true, regionHidden: false });
  });

  test('stale: no group matches the chosen codes, so the rule is off and a notice is due', () => {
    const idx = new ChannelIndex(channels, undefined, undefined, { regions: view('only', ['PL']) });
    expect(idx.groupSize('all')).toBe(7);
    expect(idx.regionState()).toEqual({ mode: 'off', requested: 'only', stale: true });
  });

  test('filter before fold: a hidden country stream never feeds a row; first orders chosen sources first', () => {
    const only = new ChannelIndex(channels, undefined, undefined, { fold: true, regions: view('only', ['SE']) });
    expect(only.sources('s:3').map((c) => c.id)).toEqual(['s:3']);
    expect(only.slice('all', 0, 20).find((c) => c.id === 's:1' || c.id === 's:3')?.sources).toBeUndefined();
    const first = new ChannelIndex(channels, undefined, undefined, { fold: true, regions: view('first', ['SE']) });
    expect(first.sources('s:1').map((c) => c.id)).toEqual(['s:3', 's:1']);
    expect(first.memberInfo('s:3')?.chosen).toBe(true);
    expect(first.memberInfo('s:1')?.chosen).toBe(false);
    const off = new ChannelIndex(channels, undefined, undefined, { fold: true, regions: view('off', ['SE']) });
    expect(off.memberInfo('s:3')?.chosen).toBe(false);
  });

  test('withLayout keeps the regions and rebuilds the effective set', () => {
    const idx = new ChannelIndex(channels, undefined, undefined, { regions: view('only', ['SE']) });
    const next = idx.withLayout(lay({ op: 'showGroups', ids: ['g:DK | News'] }));
    expect(groupIds(next)).toContain('g:DK | News');
    expect(groupIds(next)).not.toContain('g:DK | Docs');
    expect(next.withLayout(emptyLayout()).regionState().requested).toBe('only');
  });
});
