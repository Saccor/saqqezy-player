import { describe, expect, test } from 'vitest';
import { SportsIndexBuilder, isSportsIndexRecord } from '../src/sports/index.ts';

const H = 3600_000;
const NOW = Date.UTC(2026, 9, 19, 18);
const prog = (title: string, start = NOW, hours = 2) => ({ epgId: 'x', start, stop: start + hours * H, title });

describe('SportsIndexBuilder', () => {
  test('keeps detected events in the window with normalised sides', () => {
    const b = new SportsIndexBuilder(NOW);
    b.add(prog('LIVE: Northbridge FC v Eastport'), { categories: ['Sports'], icon: 'http://img.test/i.png' }, 'c1.test');
    b.add(prog('Evening Bulletin'), undefined, 'c2.test');
    b.add(prog('Lakeshore v Pinecrest', NOW + 40 * H), { categories: ['Sports'] }, 'c3.test');
    expect(b.build()).toEqual([{
      epgKey: 'c1.test', start: NOW, stop: NOW + 2 * H, title: 'Northbridge FC v Eastport', nt: 'northbridge fc v eastport',
      ns: ['northbridge', 'eastport'], sides: ['Northbridge FC', 'Eastport'], icon: 'http://img.test/i.png', live: true,
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
});
