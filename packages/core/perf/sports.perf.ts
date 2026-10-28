import { expect, test } from 'vitest';
import { groupEvents, type GroupInput } from '../src/sports/group.ts';
import { normSide } from '../src/sports/match.ts';
import { rankMatches, type MatchEvent, type RankOptions } from '../src/sports/rank.ts';

// Moved from test/sportsGroup.test.ts and test/sportsRank.test.ts (fixture 19) with their budgets unchanged.
const M = 60_000;
const T0 = Date.UTC(2026, 9, 19, 18);
const NOW = Date.UTC(2026, 9, 20, 19, 30);

test('sports: 50k candidates group in under 300 ms', () => {
  const item = (title: string, a: string, b: string, ch: string, startMin: number): GroupInput<string> => ({
    ns: [normSide(a), normSide(b)], nt: title.toLowerCase(), title, sides: [a, b],
    start: T0 + startMin * M, stop: T0 + (startMin + 120) * M, live: false, airing: ch,
  });
  const items: GroupInput<string>[] = [];
  // Varied names, as in real guides (distinct first letters spread the fuzzy buckets).
  const az = 'abcdefghijklmnopqrstuvwxyz';
  const name = (k: number) => `${az[k % 26]}${az[Math.floor(k / 26) % 26]}${az[(k * 7) % 26]}ton ${k}`;
  for (let m = 0; m < 5000; m++) {
    const a = name(2 * m);
    const b = name(2 * m + 1);
    for (let c = 0; c < 10; c++) items.push(item(`${a} v ${b}`, a, b, `c${c}`, (m % 48) * 30));
  }
  const t = performance.now();
  const { events } = groupEvents(items, new Map(), (s: string) => s);
  const ms = performance.now() - t;
  expect(ms).toBeLessThan(300);
  expect(events).toHaveLength(5000);
});

test('sports: ranking 5k events takes under 10 ms', () => {
  let n = 0;
  const ev = (o: Partial<MatchEvent> & { inMin: number }): MatchEvent => {
    const start = NOW + o.inMin * M;
    const { inMin: _i, ...rest } = o;
    return {
      title: `Side ${++n} v Other ${n}`, start, stop: start + 115 * M, cats: ['football'], sportCat: true, strong: true,
      liveMark: false, sporty: false, breadth: 1, countryBreadth: 0, followed: false, reair: false, sides: ['Side', 'Other'],
      ...rest,
    };
  };
  const opts = (o: Partial<RankOptions> = {}): RankOptions => ({ now: NOW, pinned: [], hidden: [], categories: [], countryScope: 'many', ...o });
  const many = Array.from({ length: 5000 }, (_, i) => ev({ inMin: -60 + (i % 1400), breadth: 1 + (i % 40), comp: `Cup ${i % 30}` }));
  rankMatches(many, opts());
  // Best of 5: one run can stall (GC, other workers); the budget is for the code itself.
  let best = Infinity;
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now();
    rankMatches(many, opts({ pinned: ['cup 3'], hidden: ['cup 4'] }));
    best = Math.min(best, performance.now() - t0);
  }
  expect(best).toBeLessThan(10);
});
