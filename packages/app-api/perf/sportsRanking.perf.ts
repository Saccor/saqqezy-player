import { expect, test } from 'vitest';
import { ChannelIndex, SportsIndexBuilder, type Channel } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { SportsController, matchTiles, type MatchSettings } from '../src/sportsController.ts';

// Moved from test/sportsController.test.ts (fixture 19): a wall-clock budget belongs with the other budgets, not in
// the unit suite, where a busy machine running every file in parallel can push it over.
const T = Date.UTC(2026, 9, 19, 18);
const NOW = T + 30 * 60_000;
const S0: MatchSettings = { followed: [], pinned: [], hidden: [], categories: [] };
const ch = (n: number, epg: string, name: string): Channel =>
  ({ id: `c${n}`, sourceId: 's', name, url: `http://example.test/${n}.ts`, group: 'G', epgId: epg, number: n });
/** `copies` playlist channels per guide key ("HD", "FHD", "SD"). */
function channels(keys: number, copies: number, from = 1): Channel[] {
  const out: Channel[] = [];
  const q = [' HD', ' FHD', ' SD'];
  let n = from;
  for (let k = 0; k < keys; k++) {
    for (let c = 0; c < copies; c++, n++) out.push(ch(n, `k${k}`, `Test Sport ${k}${q[c] ?? ''}`));
  }
  return out;
}

test('sports: 20k candidates over 300 keys with 5 copies each group and rank under 300 ms; ranking alone under 10 ms', async () => {
  const b = new SportsIndexBuilder(NOW);
  const teams = Array.from({ length: 400 }, (_, i) => `Team ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + (Math.floor(i / 26) % 26))}`);
  for (let i = 0; i < 20_000; i++) {
    const key = `k${i % 300}`;
    const m = Math.floor(i / 300);
    const start = T + (((m * 37) % (34 * 60)) - 12 * 60) * 60_000;
    b.add({ epgId: key, title: `${teams[(m * 2) % 400]} v ${teams[(m * 2 + 1) % 400]}`, start, stop: start + 115 * 60_000 }, { categories: ['Football'] }, key);
  }
  const slack = process.env.CI ? 3 : 1;
  const record = b.record(1, NOW);
  for (const fold of [false, true]) {
    // Combining folds the copies of a guide channel into one row: channelsForEpgKey then returns one channel per row.
    const index = new ChannelIndex([...channels(300, 3), ...channels(300, 2, 2000)], undefined, undefined, { fold });
    const sc = new SportsController({ storage: new MemoryStorage(), now: () => NOW });
    const t0 = performance.now();
    const view = await sc.view('s', record, index, 0);
    matchTiles(view, NOW, S0, sc.aliases());
    expect(performance.now() - t0).toBeLessThan(300 * slack);
    const t1 = performance.now();
    matchTiles(view, NOW, S0, sc.aliases());
    expect(performance.now() - t1).toBeLessThan(10 * slack);
  }
});
