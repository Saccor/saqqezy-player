import { describe, expect, test } from 'vitest';
import { SPORTS_INDEX_VERSION, SportsIndexBuilder, isSportsIndexRecord } from '../src/sports/index.ts';
import { MATCH_FLAGS } from '../src/sports/words.ts';

const H = 3600_000;
const NOW = Date.UTC(2026, 9, 19, 18);
const prog = (title: string, start = NOW, hours = 2, desc?: string) => ({ epgId: 'x', start, stop: start + hours * H, title, ...(desc ? { desc } : {}) });

describe('SportsIndexBuilder', () => {
  test('keeps detected events in the window with normalised sides', () => {
    const b = new SportsIndexBuilder(NOW);
    b.add(prog('LIVE: Northbridge FC v Eastport'), { categories: ['Sports'], icon: 'http://img.test/i.png' }, 'c1.test');
    b.add(prog('Evening Bulletin'), undefined, 'c2.test');
    b.add(prog('Lakeshore v Pinecrest', NOW + 40 * H), { categories: ['Sports'] }, 'c3.test');
    expect(b.build()).toEqual([{
      epgKey: 'c1.test', start: NOW, stop: NOW + 2 * H, title: 'Northbridge FC v Eastport', nt: 'northbridge fc v eastport',
      ns: ['northbridge', 'eastport'], sides: ['Northbridge FC', 'Eastport'], icon: 'http://img.test/i.png', live: true,
      cats: [0], flags: MATCH_FLAGS.live,
    }]);
  });
  test('stops at the cap and says so', () => {
    const b = new SportsIndexBuilder(NOW, 2);
    for (let i = 0; i < 3; i++) b.add(prog(`Team${i} v Other${i}`), { categories: ['Sports'] }, `c${i}`);
    expect(b.build()).toHaveLength(2);
    expect(b.truncated).toBe(true);
  });
  test('record shape check', () => {
    expect(isSportsIndexRecord({ gen: 1, built: NOW, candidates: [], truncated: false })).toBe(true);
    expect(isSportsIndexRecord({ gen: 1, candidates: 'x' })).toBe(false);
    expect(isSportsIndexRecord(null)).toBe(false);
  });

  test('v2 record: interned categories in the guide\'s own text, competition, flags, desc scanned but not stored', () => {
    const b = new SportsIndexBuilder(NOW);
    b.add(prog('Northern Cup | Northbridge FC v Eastport'), { categories: ['Fotboll'] }, 'c1.test');
    b.add(prog('Lakeshore v Pinecrest', NOW, 2, 'Wiederholung vom Samstag'), { categories: ['fotboll', 'Ishockey'] }, 'c2.test');
    const rec = b.record(3, NOW);
    expect(rec.v).toBe(SPORTS_INDEX_VERSION);
    expect(rec).toMatchObject({ gen: 3, built: NOW, truncated: false, categories: ['Fotboll', 'Ishockey'] });
    expect(rec.candidates[0]).toMatchObject({ comp: 'Northern Cup', cats: [0], sides: ['Northbridge FC', 'Eastport'], title: 'Northbridge FC v Eastport' });
    expect(rec.candidates[1]!.cats).toEqual([0, 1]);
    expect(rec.candidates[1]!.flags! & MATCH_FLAGS.replay).toBeTruthy();
    expect(JSON.stringify(rec)).not.toContain('Samstag');
    expect(isSportsIndexRecord(rec)).toBe(true);
  });

  test('sporty keys: guide channels with 3 or more sport programmes in the window', () => {
    const b = new SportsIndexBuilder(NOW);
    for (let i = 0; i < 3; i++) b.add(prog(`Studio Hour ${i}`, NOW + i * 2 * H), { categories: ['Sports'] }, 'sporty.test');
    b.add(prog('LIVE Lakeshore v Pinecrest'), undefined, 'sporty.test');
    for (let i = 0; i < 2; i++) b.add(prog(`Golf Weekly ${i}`, NOW + i * 2 * H), { categories: ['Sports'] }, 'other.test');
    b.add(prog('LIVE: Evening News - Weekend Edition'), undefined, 'other.test');
    expect(b.record(1, NOW).sportyKeys).toEqual(['sporty.test']);
  });

  test('sport-named channels: a two-sided title with no category counts, hyphen included, and the channel is sporty', () => {
    const b = new SportsIndexBuilder(NOW, undefined, new Set(['sport.test']));
    b.add(prog('Northbridge FC - Eastport'), undefined, 'sport.test');
    b.add(prog('Northbridge FC - Eastport'), undefined, 'news.test');
    const rec = b.record(1, NOW);
    expect(rec.candidates.map((c) => [c.epgKey, c.title])).toEqual([['sport.test', 'Northbridge FC - Eastport']]);
    expect(rec.candidates[0]!.sides).toEqual(['Northbridge FC', 'Eastport']);
    expect(rec.candidates[0]!.flags! & MATCH_FLAGS.weakSep).toBe(MATCH_FLAGS.weakSep);
    expect(rec.sportyKeys).toEqual(['sport.test']);
  });

  test('sport-named channels never lift a title with no sides, a replay or a short untagged slot', () => {
    const b = new SportsIndexBuilder(NOW, undefined, new Set(['sport.test']));
    b.add(prog('Synthetic League'), undefined, 'sport.test');
    b.add(prog('Northbridge FC - Eastport (R)'), undefined, 'sport.test');
    b.add(prog('Lakeshore - Pinecrest', NOW, 0.5), undefined, 'sport.test');
    expect(b.build()).toEqual([]);
  });
});
