import { describe, expect, it } from 'vitest';
import type { CompanionChannel } from '@iptv/companion-protocol';
import { buildSearchKeys, filterChannels } from './picker.ts';

const ch = (id: string, name: string, group: string, number: number, displayName?: string): CompanionChannel => {
  const c: CompanionChannel = { id, name, group, number, hasEpg: true };
  if (displayName) c.displayName = displayName;
  return c;
};

const CHANNELS = [
  ch('1', 'Café Télé', 'Général', 1),
  ch('2', 'News One', 'News', 2),
  ch('3', 'Nature Two', 'Docs', 12),
  ch('4', 'Ugly Name', 'Docs', 120, 'Pretty Name'),
  ch('5', 'Weather', 'Local', 21),
];

describe('picker filtering', () => {
  const keys = buildSearchKeys(CHANNELS);
  const names = (idx: number[]) => idx.map((i) => CHANNELS[i]!.id);

  it('returns every channel for an empty query', () => {
    expect(names(filterChannels(keys, ''))).toEqual(['1', '2', '3', '4', '5']);
    expect(names(filterChannels(keys, '   '))).toEqual(['1', '2', '3', '4', '5']);
  });

  it('ignores case and diacritics on both sides (core normalize)', () => {
    expect(names(filterChannels(keys, 'cafe tele'))).toEqual(['1']);
    expect(names(filterChannels(keys, 'CAFÉ'))).toEqual(['1']);
    expect(names(filterChannels(keys, 'general'))).toEqual(['1']);
  });

  it('matches every word, in any field, in any order', () => {
    expect(names(filterChannels(keys, 'docs two'))).toEqual(['3']);
    expect(names(filterChannels(keys, 'two docs'))).toEqual(['3']);
    expect(names(filterChannels(keys, 'news'))).toEqual(['2']);
  });

  it('matches the rename and the original name', () => {
    expect(names(filterChannels(keys, 'pretty'))).toEqual(['4']);
    expect(names(filterChannels(keys, 'ugly'))).toEqual(['4']);
  });

  it('matches a number by prefix', () => {
    expect(names(filterChannels(keys, '12'))).toEqual(['3', '4']);
    expect(names(filterChannels(keys, '2'))).toEqual(['2', '5']);
  });

  it('stays fast with 50k channels', () => {
    const many = Array.from({ length: 50_000 }, (_, i) => ch(`c${i}`, `Channel ${i} Ünïcode`, `Group ${i % 300}`, i + 1));
    const t0 = performance.now();
    const k = buildSearchKeys(many);
    const r = filterChannels(k, 'unicode group 12');
    const dt = performance.now() - t0;
    expect(r.length).toBeGreaterThan(0);
    expect(dt).toBeLessThan(1500);
  });
});
