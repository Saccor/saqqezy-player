import { describe, expect, test } from 'vitest';
import { foldChannels } from '../src/live/fold.ts';
import type { Channel } from '../src/types.ts';

let n = 0;
const ch = (name: string, extra: Partial<Channel> = {}): Channel =>
  ({ id: `s:${++n}`, sourceId: 's', name, url: `http://example.test/${n}.ts`, group: 'G', number: n, ...extra });
const names = (cs: Channel[]) => foldChannels(cs).folds.map((g) => g.members.map((i) => cs[i]!.name));

describe('foldChannels', () => {
  test('the spec example folds into one row via the guide id', () => {
    const cs = [ch('SE: Channel One HD', { epgId: 'one.se' }), ch('Channel One FHD', { epgId: 'one.se' }),
      ch('Channel One (backup)'), ch('Channel One 4K', { epgId: 'one.se' })];
    const f = foldChannels(cs);
    expect(f.folds).toHaveLength(1);
    expect(f.folds[0]).toMatchObject({ display: 'Channel One', quality: 0, lead: 0 });
    expect(Array.from(f.memberBackup)).toEqual([0, 0, 1, 0]);
    expect(Array.from(f.foldOf)).toEqual([0, 0, 0, 0]);
  });
  test('without a guide id the country is kept', () => {
    expect(names([ch('SE: Channel One'), ch('UK: Channel One'), ch('SE: Channel One HD')]))
      .toEqual([['SE: Channel One', 'SE: Channel One HD'], ['UK: Channel One']]);
  });
  test('never merges timeshift, East/West, longer names, or a shared id with another name', () => {
    expect(foldChannels([ch('Channel One'), ch('Channel One +1'), ch('Channel One +2')]).folds).toHaveLength(3);
    expect(foldChannels([ch('Channel One East'), ch('Channel One West')]).folds).toHaveLength(2);
    expect(foldChannels([ch('Channel One'), ch('Channel One Sport')]).folds).toHaveLength(2);
    expect(foldChannels([ch('Channel One'), ch('Channel One VIP')]).folds).toHaveLength(2);
    expect(foldChannels([ch('Channel One', { epgId: 'x' }), ch('Channel Two', { epgId: 'x' })]).folds).toHaveLength(2);
  });
  test('different tvg-shift never merges', () => {
    expect(foldChannels([ch('Channel One', { epgId: 'x' }), ch('Channel One HD', { epgId: 'x', epgShift: 1 })]).folds).toHaveLength(2);
  });
  test('join rule: a no-id channel joins exactly one guide-id fold with its name', () => {
    expect(names([ch('Channel One', { epgId: 'a' }), ch('Channel One (backup)')])).toEqual([['Channel One', 'Channel One (backup)']]);
    expect(foldChannels([ch('Channel One', { epgId: 'a' }), ch('Channel One HD', { epgId: 'b' }), ch('Channel One (backup)')]).folds).toHaveLength(3);
    expect(foldChannels([ch('SE: Channel One', { epgId: 'a' }), ch('UK: Channel One')]).folds).toHaveLength(2);
    expect(foldChannels([ch('SE: Channel One', { epgId: 'a' }), ch('SE: Channel One (backup)')]).folds).toHaveLength(1);
  });
  test('lead is the lowest number; display prefers a member without a country', () => {
    const cs = [ch('SE: Channel One HD', { epgId: 'a', number: 40 }), ch('Channel One FHD', { epgId: 'a', number: 7 })];
    expect(foldChannels(cs).folds[0]).toMatchObject({ lead: 1, display: 'Channel One' });
  });
  test('guide ids compare case-insensitively; empty ids count as none', () => {
    expect(foldChannels([ch('Channel One', { epgId: 'One.SE' }), ch('Channel One HD', { epgId: 'one.se' })]).folds).toHaveLength(1);
    expect(foldChannels([ch('Channel One', { epgId: '' }), ch('Channel One HD')]).folds).toHaveLength(1);
  });
});
