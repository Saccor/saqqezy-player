import { expect, test } from 'vitest';
import { buildTrendingIndex, matchTrending, type TrendingCandidate, type TrendingFeed } from '../src/vod/trending.ts';

function best(xs: number[]): number {
  return Math.min(...xs);
}

/** 60k catalogue titles as grouping keys them: a third by tmdb id, the rest by title and year, some undated. */
function catalogue(n: number): TrendingCandidate[] {
  return Array.from({ length: n }, (_, i) => {
    const display = `Synthetic Film ${i} Part ${i % 7}`;
    const base = display.toLowerCase();
    const year = 1950 + (i % 75);
    if (i % 3 === 0) return { key: `t:${100_000 + i}`, display, year };
    if (i % 10 === 1) return { key: `n:${base}`, display };
    return { key: `y:${base}|${year}`, display, year };
  });
}

/** 150 items: ids, titles with the exact year, a year off by one, aliases, and titles nobody has. */
function feed(n: number): TrendingFeed {
  return {
    v: 1, kind: 'movie', lang: 'en', at: '2026-10-20T00:00:00.000Z',
    items: Array.from({ length: 150 }, (_, r) => {
      const i = (r * 397) % n;
      const title = `Synthetic Film ${i} Part ${i % 7}`;
      const year = 1950 + (i % 75) + (r % 5 === 0 ? 1 : 0);
      const titles = r % 4 === 0 ? [`Synthetic Absent ${r}`] : [`Syntetisk film ${i}`, title, `${title}: Alias`];
      return { rank: r + 1, wd: `Q${900_000 + r}`, year, titles, ...(r % 2 === 0 && i % 3 === 0 ? { tmdb: 100_000 + i } : {}) };
    }),
  };
}

test('trending: 150 feed items matched against 60k titles', () => {
  const groups = catalogue(60_000);

  buildTrendingIndex(groups); // warm up
  const buildRuns: number[] = [];
  let index = buildTrendingIndex(groups);
  for (let r = 0; r < 5; r++) {
    const t = performance.now();
    index = buildTrendingIndex(groups);
    buildRuns.push(performance.now() - t);
  }

  matchTrending(feed(60_000), 'movie', index); // warm up
  const runs: number[] = [];
  let hits: number[] = [];
  for (let r = 0; r < 5; r++) {
    const f = feed(60_000); // a new feed object: its titles are parsed again, as after a refresh
    const t = performance.now();
    hits = matchTrending(f, 'movie', index, 150);
    runs.push(performance.now() - t);
  }
  const matchMs = best(runs);
  const buildMs = best(buildRuns);
  console.log(`trending: match ${matchMs.toFixed(2)} ms (best of 5, ${hits.length} hits), index build ${buildMs.toFixed(1)} ms (once per catalogue)`);
  expect(hits.length).toBeGreaterThan(100);
  expect(matchMs).toBeLessThan(5);
  // The index is built once per catalogue (cached with it), off the Start path. Regression guard.
  expect(buildMs).toBeLessThan(150);
});
