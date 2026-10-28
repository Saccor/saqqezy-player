import { expect, test } from 'vitest';
import { detectRegions } from '../src/text/regions.ts';

// Moved from test/regions.test.ts with its budget unchanged: wall-clock budgets run here, not in the unit suite.
test('detectRegions: 50k channels in 2k groups in under 30 ms', () => {
  const codes = ['SE', 'DK', 'FI', 'DE', 'FR', 'NL', 'PL', 'ES', 'PT', 'GR'];
  const groups = Array.from({ length: 2000 }, (_, i) => {
    const code = codes[i % codes.length]!;
    const name = i % 4 === 0 ? `Synthetic Group ${i}` : `${code} | Synthetic Group ${i}`;
    const members = Array.from({ length: 25 }, (_, k) => (k % 2 ? `${code}: Synthetic ${i}-${k}` : `Synthetic ${i}-${k} HD`));
    return { id: `g:${name}`, name, members };
  });
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const t = performance.now();
    detectRegions(groups);
    best = Math.min(best, performance.now() - t);
  }
  expect(best).toBeLessThan(30);
});
