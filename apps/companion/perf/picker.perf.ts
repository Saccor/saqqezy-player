import { expect, test } from 'vitest';
import type { CompanionChannel } from '@iptv/companion-protocol';
import { buildSearchKeys, filterChannels } from '../src/logic/picker.ts';

// Moved from src/logic/picker.test.ts with its budget unchanged.
test('picker: filters 50k channels in under 50 ms (keys built beforehand, as the picker memoises them)', () => {
  const many = Array.from({ length: 50_000 }, (_, i): CompanionChannel =>
    ({ id: `c${i}`, name: `Channel ${i} Ünïcode`, group: `Group ${i % 300}`, number: i + 1, hasEpg: true }));
  const k = buildSearchKeys(many);
  filterChannels(k, 'warm up');
  for (const q of ['unicode group 12', 'channel 4999', '12', 'nothing matches this']) {
    const t0 = performance.now();
    filterChannels(k, q);
    expect(performance.now() - t0, q).toBeLessThan(50);
  }
});
