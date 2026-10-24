import { describe, expect, test } from 'vitest';
import {
  MATCHES_ALL_CAP, MATCHES_ROW_CAP, ON_NOW_AHEAD_MS, competitionKey, matchScore, rankMatches, type MatchEvent, type RankOptions,
} from '../src/sports/rank.ts';

const M = 60_000;
const H = 60 * M;
const NOW = Date.UTC(2026, 9, 20, 19, 30);
let n = 0;
/** A passing match unless overridden: two sides, a sport category, 115 min, starting in `inMin`. */
const ev = (o: Partial<MatchEvent> & { inMin?: number; len?: number } = {}): MatchEvent => {
  const start = NOW + (o.inMin ?? 60) * M;
  const e: MatchEvent = {
    title: o.title ?? `Side ${++n} v Other ${n}`, start, stop: start + (o.len ?? 115) * M, cats: o.cats ?? ['football'],
    sportCat: true, strong: true, liveMark: false, sporty: false, breadth: 1, countryBreadth: 0, followed: false, reair: false,
    sides: ['Side', 'Other'],
  };
  const { inMin: _i, len: _l, ...rest } = o;
  return { ...e, ...rest };
};
const opts = (o: Partial<RankOptions> = {}): RankOptions => ({ now: NOW, pinned: [], hidden: [], categories: [], countryScope: 'many', ...o });
const titles = (list: readonly { event: MatchEvent }[]) => list.map((r) => r.event.title);

describe('rankMatches gates (design note §3.5)', () => {
  test('G1: events with no sides are not matches; a sport one goes to the end of See all only (fixture 6)', () => {
    const studio: MatchEvent = { ...ev({ title: 'Lakeside Open' }), sides: undefined };
    const big = ev({ title: 'Northbridge FC v Eastport', breadth: 24 });
    const r = rankMatches([studio, big], opts());
    expect(titles(r.row)).toEqual(['Northbridge FC v Eastport']);
    expect(titles(r.all)).toEqual(['Northbridge FC v Eastport', 'Lakeside Open']);
    expect(r.all[1]!.match).toBe(false);
    const noSport: MatchEvent = { ...studio, sportCat: false, cats: [] };
    expect(rankMatches([noSport], opts()).all).toEqual([]);
  });

  test('G2: a sport signal is needed; weak separators need a category or a sports channel (fixtures 4–5)', () => {
    const news = ev({ title: 'Evening News - Weekend Edition', sportCat: false, cats: [], strong: false, liveMark: true });
    const quiz = ev({ title: 'Quiz Night - The Final', sportCat: false, cats: [], strong: false, liveMark: true, breadth: 3 });
    const artist = ev({ title: 'Artist x Artist', sportCat: false, cats: [], strong: false, liveMark: true });
    expect(rankMatches([news, quiz, artist], opts()).all).toEqual([]);
    const sportyWeak = ev({ title: 'Northbridge - Eastport', sportCat: false, cats: [], strong: false, liveMark: true, sporty: true });
    const strongLiveSporty = ev({ title: 'Lakeshore v Pinecrest', sportCat: false, cats: [], liveMark: true, sporty: true });
    const strongTwoKeys = ev({ title: 'Harbour City v Kingsgate', sportCat: false, cats: [], breadth: 2 });
    const strongAlone = ev({ title: 'Hollis v Hollis', sportCat: false, cats: [] });
    expect(titles(rankMatches([sportyWeak, strongLiveSporty, strongTwoKeys, strongAlone], opts()).all).sort())
      .toEqual(['Harbour City v Kingsgate', 'Lakeshore v Pinecrest', 'Northbridge - Eastport']);
  });

  test('G3: re-airs are dropped (fixture 9)', () => {
    expect(rankMatches([ev({ reair: true })], opts()).all).toEqual([]);
  });

  test('G5: under 60 min needs a live marker (fixture 11)', () => {
    expect(rankMatches([ev({ len: 50 })], opts()).all).toEqual([]);
    expect(rankMatches([ev({ len: 50, liveMark: true })], opts()).all).toHaveLength(1);
  });

  test('G6: on air (started at most 3 h ago) or upcoming inside the window; ended ones never', () => {
    const onAir = ev({ title: 'On air', inMin: -30 });
    const old = ev({ title: 'Started 4 h ago', inMin: -240, len: 300 });
    const ended = ev({ title: 'Ended', inMin: -200 });
    const r = rankMatches([onAir, old, ended], opts());
    expect(titles(r.all)).toEqual(['On air']);
    expect(r.all[0]!.onAir).toBe(true);
  });

  test('G6: the window is 6 h, widened to 12 h while fewer than 4 matches pass (fixture 15)', () => {
    const in6 = [ev({ inMin: 60 }), ev({ inMin: 120 })];
    const in12 = [ev({ inMin: 7 * 60 }), ev({ inMin: 9 * 60 }), ev({ inMin: 11 * 60 })];
    const later = ev({ title: 'Tomorrow', inMin: 20 * 60 });
    const r = rankMatches([...in6, ...in12, later], opts());
    expect(r.all).toHaveLength(5);
    expect(r.windowHours).toBe(12);
    const busy = Array.from({ length: 4 }, (_, i) => ev({ inMin: 30 + i * 30 }));
    const r2 = rankMatches([...busy, ev({ title: 'Tomorrow 07:00', inMin: 11 * 60 + 30 })], opts());
    expect(r2.windowHours).toBe(6);
    expect(titles(r2.all)).not.toContain('Tomorrow 07:00');
  });

  test('G6: a followed side shows up to 36 h ahead; another match 30 h ahead does not (fixture 14)', () => {
    const followed = ev({ title: 'Westvale v Eastport', inMin: 30 * 60, followed: true });
    const other = ev({ title: 'Kingsgate v Rivermouth Rovers', inMin: 30 * 60 });
    const tooFar = ev({ title: 'Too far', inMin: 37 * 60, followed: true });
    expect(titles(rankMatches([followed, other, tooFar], opts()).all)).toEqual(['Westvale v Eastport']);
  });

  test('G7: hidden competitions and the category filter (fixtures 16–17)', () => {
    const cup = ev({ title: 'Lakeshore v Pinecrest', comp: 'Test Cup' });
    const hockey = ev({ title: 'Harbour City v Kingsgate', cats: ['ishockey'] });
    expect(titles(rankMatches([cup, hockey], opts({ hidden: [competitionKey('test cup')] })).all)).toEqual(['Harbour City v Kingsgate']);
    expect(titles(rankMatches([cup, hockey], opts({ categories: ['fotboll'] })).all)).toEqual([]);
    const fot = ev({ title: 'Northbridge v Eastport', cats: ['fotboll'] });
    expect(titles(rankMatches([fot, hockey], opts({ categories: ['fotboll'] })).all)).toEqual(['Northbridge v Eastport']);
  });

  test('G8: small matches stay in See all while the top match is broad; followed, pinned or chosen-country ones pass (fixture 12)', () => {
    const big = [24, 20, 16, 12].map((b, i) => ev({ title: `Big ${i}`, breadth: b, inMin: 60 + i }));
    const darts = ev({ title: 'Player One v Player Two', breadth: 1, inMin: -10, liveMark: true });
    const r = rankMatches([...big, darts], opts());
    expect(titles(r.row)).not.toContain('Player One v Player Two');
    expect(titles(r.all)).toContain('Player One v Player Two');
    const home = { ...darts, countryBreadth: 1 };
    expect(titles(rankMatches([...big, home], opts()).row)).toContain('Player One v Player Two');
  });

  test('G8 never pads the row: small matches stay in See all; a single-country guide turns the cut-off off', () => {
    const top = ev({ title: 'Top', breadth: 16 });
    const small = [1, 2, 1].map((b, i) => ev({ title: `Small ${i}`, breadth: b, inMin: 60 + i }));
    const r = rankMatches([top, ...small], opts());
    expect(titles(r.row)).toEqual(['Top']);
    expect(r.all).toHaveLength(4);
    expect(rankMatches([top, ...small], opts({ countryScope: 'one' })).row).toHaveLength(4);
  });

  test('G8 never pads: followed and pinned small matches still join the row', () => {
    const top = ev({ title: 'Top', breadth: 16 });
    const followed = ev({ title: 'Followed', breadth: 1, followed: true, inMin: 70 });
    const pinned = ev({ title: 'Pinned', breadth: 1, comp: 'Test Cup', inMin: 80 });
    const plain = ev({ title: 'Plain', breadth: 1, inMin: 90 });
    const r = rankMatches([top, followed, pinned, plain], opts({ pinned: [competitionKey('Test Cup')] }));
    expect(titles(r.row).sort()).toEqual(['Followed', 'Pinned', 'Top']);
  });

  test('G8 with no country prefixes seen: 25 % of the top breadth, at least 1', () => {
    const top = ev({ title: 'Top', breadth: 24, inMin: 40 });
    const mid = [6, 5].map((b, i) => ev({ title: `Mid ${i}`, breadth: b, inMin: 50 + i }));
    const small = Array.from({ length: 8 }, (_, i) => ev({ title: `Small ${i}`, breadth: 1, inMin: 60 + i }));
    const r = rankMatches([top, ...mid, ...small], opts({ countryScope: 'unknown' }));
    expect(titles(r.row)).toEqual(['Top', 'Mid 0']);
    const flat = Array.from({ length: 6 }, (_, i) => ev({ title: `Flat ${i}`, breadth: 1, inMin: 60 + i }));
    expect(rankMatches(flat, opts({ countryScope: 'unknown' })).row).toHaveLength(6);
  });

  test('caps: the row shows 12, See all 100', () => {
    const many = Array.from({ length: 130 }, (_, i) => ev({ inMin: 10 + (i % 100), breadth: 8 }));
    const r = rankMatches(many, opts());
    expect(r.row).toHaveLength(MATCHES_ROW_CAP);
    expect(r.all).toHaveLength(MATCHES_ALL_CAP);
    expect(r.total).toBe(130);
    expect(ON_NOW_AHEAD_MS).toBe(2 * H);
  });

  test('row (spec 2026-10-24 §1.2): on air first in score order, then kick-offs within 2 h by start; later ones only in See all', () => {
    const liveSmall = ev({ title: 'Live small', inMin: -20, breadth: 4 });
    const liveBig = ev({ title: 'Live big', inMin: -40, breadth: 16 });
    const soon = ev({ title: 'In 90', inMin: 90, breadth: 16 });
    const sooner = ev({ title: 'In 30', inMin: 30, breadth: 8 });
    const bigLater = ev({ title: 'Big in 3 h', inMin: 180, breadth: 16 });
    const r = rankMatches([bigLater, soon, liveSmall, sooner, liveBig], opts());
    expect(titles(r.row)).toEqual(['Live big', 'Live small', 'In 30', 'In 90']);
    expect(titles(r.all)).toContain('Big in 3 h');
    expect(r.total).toBe(5);
  });

  test('row: exactly 2 h counts, 2 h 1 min does not; the row may be empty while See all is not', () => {
    const edge = ev({ title: 'Edge', inMin: 120, breadth: 8 });
    const over = ev({ title: 'Over', inMin: 121, breadth: 8 });
    const r = rankMatches([edge, over], opts());
    expect(titles(r.row)).toEqual(['Edge']);
    expect(titles(r.all)).toEqual(['Edge', 'Over']);
    expect(rankMatches([over], opts()).row).toEqual([]);
    expect(rankMatches([over], opts()).all).toHaveLength(1);
  });

  test('row: a followed side 5 h ahead is in See all, not the row; a followed side on air leads the row', () => {
    const followedLater = ev({ title: 'Followed later', inMin: 300, followed: true, breadth: 1 });
    const followedLive = ev({ title: 'Followed live', inMin: -10, followed: true, breadth: 1 });
    const plainLive = ev({ title: 'Plain live', inMin: -10, breadth: 16 });
    const r = rankMatches([plainLive, followedLater, followedLive], opts());
    expect(titles(r.row)).toEqual(['Followed live', 'Plain live']);
    expect(titles(r.all)).toContain('Followed later');
  });

  test('row: G8 still applies inside the window (a small kick-off stays in See all while the top match is broad)', () => {
    const top = ev({ title: 'Top', breadth: 16, inMin: 30 });
    const small = ev({ title: 'Small', breadth: 1, inMin: 40 });
    const r = rankMatches([top, small], opts());
    expect(titles(r.row)).toEqual(['Top']);
    expect(titles(r.all)).toEqual(['Top', 'Small']);
  });
});

describe('matchScore and order (design note §3.6)', () => {
  test('the worked example: followed ≫ breadth ≫ country ≫ on air', () => {
    const at = (h: number, m: number) => Math.round((Date.UTC(2026, 9, 20, h, m) - NOW) / M);
    const westvale = ev({ title: 'Westvale v Eastport', inMin: at(21, 0), breadth: 2, followed: true });
    const northbridge = ev({ title: 'Northbridge FC v Southmere', inMin: -20, breadth: 24, countryBreadth: 3, liveMark: true });
    const kingsgate = ev({ title: 'Kingsgate v Rivermouth Rovers', inMin: at(20, 45), breadth: 9 });
    const lakeshore = ev({ title: 'Lakeshore v Pinecrest', inMin: at(20, 0), breadth: 1, countryBreadth: 1 });
    const darts = ev({ title: 'Player One v Player Two', inMin: -5, breadth: 1, liveMark: true });
    const r = rankMatches([darts, lakeshore, kingsgate, northbridge, westvale], opts());
    expect(titles(r.row)).toEqual(['Northbridge FC v Southmere', 'Lakeshore v Pinecrest', 'Kingsgate v Rivermouth Rovers', 'Westvale v Eastport']);
    expect(titles(r.all)).toEqual(['Westvale v Eastport', 'Northbridge FC v Southmere', 'Kingsgate v Rivermouth Rovers', 'Lakeshore v Pinecrest', 'Player One v Player Two']);
  });

  test('breadth is a log scale, capped at 5; sooner first within a band', () => {
    const s = (b: number, inMin = 60) => matchScore(ev({ breadth: b, inMin }), NOW, new Set());
    expect(s(1)).toBeLessThan(s(2));
    expect(s(2)).toBe(s(3));
    expect(s(3)).toBeLessThan(s(4));
    expect(s(32)).toBe(s(100));
    expect(s(4, 30)).toBeGreaterThan(s(4, 300));
  });

  test('a pinned competition lifts a narrower match above a broader one; hiding removes it (fixture 17)', () => {
    const lakeshore = ev({ title: 'Lakeshore v Pinecrest', comp: 'Test Cup', breadth: 1, inMin: 200 });
    const broad = ev({ title: 'Northbridge FC v Eastport', breadth: 24, inMin: 30 });
    expect(titles(rankMatches([broad, lakeshore], opts({ pinned: [competitionKey('Test Cup')] })).all)[0]).toBe('Lakeshore v Pinecrest');
    expect(titles(rankMatches([broad, lakeshore], opts({ hidden: [competitionKey('Test Cup')] })).all)).toEqual(['Northbridge FC v Eastport']);
  });

  test('performance: ranking 5k events takes under 10 ms (fixture 19)', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ev({ inMin: -60 + (i % 1400), breadth: 1 + (i % 40), comp: `Cup ${i % 30}` }));
    rankMatches(many, opts());
    // Best of 5: the full parallel suite can stall one run (GC, other workers); the budget is for the code itself.
    let best = Infinity;
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      rankMatches(many, opts({ pinned: ['cup 3'], hidden: ['cup 4'] }));
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(10);
  });
});

describe('competitionKey', () => {
  test('folded, trimmed, inner spaces collapsed', () => {
    expect(competitionKey('  Northern   Cüp ')).toBe('northern cup');
  });
});
