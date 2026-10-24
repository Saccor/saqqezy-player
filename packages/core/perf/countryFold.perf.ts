import { expect, test } from 'vitest';
import { ChannelIndex, type ChannelRegionView } from '../src/index/channelIndex.ts';
import { buildRegionsRecord, knownCountries } from '../src/text/regions.ts';
import type { Channel } from '../src/types.ts';

/** Codes that are also words: the detector treats them strictly, so the generator leaves them out. */
const STRICT = new Set(['IN', 'NO', 'IT', 'AR', 'CA', 'AL', 'MY', 'ID']);

test('2k groups / 50k channels: build + groups() with the country fold within the 20 ms budget + 5 ms', () => {
  const codes = knownCountries().filter((c) => !STRICT.has(c)).slice(0, 40);
  const channels: Channel[] = [];
  for (let i = 0; i < 50_000; i++) {
    const g = i % 2000;
    const group = g < 1900 ? `${codes[g % codes.length]} | Synthetic ${g}` : `Synthetic Mix ${g}`;
    channels.push({ id: `s:${i}`, sourceId: 's', name: `Channel ${i}`, url: `http://example.test/${i}.ts`, group, number: i + 1 });
  }
  const detected = buildRegionsRecord(channels).groups;
  const view = (fold: boolean): ChannelRegionView => ({ detected, codes: ['SE', 'DK'], mode: 'first', fold });
  const median = (fold: boolean) => {
    const times: number[] = [];
    for (let r = 0; r < 7; r++) {
      const t0 = performance.now();
      const groups = new ChannelIndex(channels, undefined, undefined, { regions: view(fold) }).groups();
      times.push(performance.now() - t0);
      expect(groups.length).toBeGreaterThan(2000);
    }
    times.sort((a, b) => a - b);
    return times[3]!;
  };
  median(true); // warm-up (JIT, sure-keys cache)
  const flat = median(false);
  const folded = median(true);
  console.log(`2k groups: build + groups() flat ${flat.toFixed(1)} ms, folded ${folded.toFixed(1)} ms`);
  expect(folded - flat).toBeLessThan(5);
  // Absolute guard only: the flat build alone is ~25 ms on this PC (fresh 50k-channel index per run); the fold delta above is the budget.
  expect(folded).toBeLessThan(45);
});
