import { describe, expect, test } from 'vitest';
import { isFollowed } from '../src/sports/follow.ts';
import { groupEvents, type GroupInput } from '../src/sports/group.ts';
import { normSide } from '../src/sports/match.ts';

const M = 60_000;
const T0 = Date.UTC(2026, 9, 19, 18);
const item = (title: string, a: string, b: string, ch: string, startMin = 0, durMin = 120, live = false): GroupInput<string> => ({
  ns: [normSide(a), normSide(b)], nt: title.toLowerCase(), title, sides: [a, b],
  start: T0 + startMin * M, stop: T0 + (startMin + durMin) * M, live, airing: ch,
});
const id = (s: string) => s;

describe('groupEvents', () => {
  test('one match on five channels: swapped sides, other separators, a 10-minute offset', () => {
    const items = [
      item('LIVE: Northbridge FC v Eastport', 'Northbridge FC', 'Eastport', 'c1', 0, 120, true),
      item('Northbridge v Eastport', 'Northbridge', 'Eastport', 'c2'),
      item('Eastport - Northbridge FC', 'Eastport', 'Northbridge FC', 'c3', 10),
      item('Northbridge FC vs Eastport', 'Northbridge FC', 'Eastport', 'c4', -10),
      item('Northbridge FC – Eastport', 'Northbridge FC', 'Eastport', 'c5'),
    ];
    const { events } = groupEvents(items, new Map(), id);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.key).toBe('p:eastport|northbridge');
    expect(e.airings.sort()).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(e.live).toBe(true);
    expect(e.start).toBe(T0 - 10 * M);
    expect(e.stop).toBe(T0 + 130 * M);
  });

  test('two different matches at the same time stay apart; the same pairing hours later is another event', () => {
    const { events } = groupEvents([
      item('Northbridge v Eastport', 'Northbridge', 'Eastport', 'c1'),
      item('Harbour City v Westvale United', 'Harbour City', 'Westvale United', 'c2'),
      item('Northbridge v Eastport', 'Northbridge', 'Eastport', 'c3', 24 * 60),
    ], new Map(), id);
    expect(events).toHaveLength(3);
  });

  test('a fuzzy side groups, and is learned as an alias once two channels show it', () => {
    const { events, learned } = groupEvents([
      item('Harbour City v Westvale United', 'Harbour City', 'Westvale United', 'c1'),
      item('Harbour City v Westvale Unitd', 'Harbour City', 'Westvale Unitd', 'c2'),
      item('Harbour City v Westvale Unitd', 'Harbour City', 'Westvale Unitd', 'c3'),
    ], new Map(), id);
    expect(events).toHaveLength(1);
    expect(learned).toEqual([['westvale unitd', 'westvale united']]);
  });

  test('known aliases join sides that are not fuzzy-close', () => {
    const aliases = new Map([['hc', 'harbour city']]);
    const { events } = groupEvents([
      item('Harbour City v Westvale United', 'Harbour City', 'Westvale United', 'c1'),
      item('HC v Westvale United', 'HC', 'Westvale United', 'c2'),
    ], aliases, id);
    expect(events).toHaveLength(1);
  });

  test('the same channel twice is one airing; the display title is the most common one', () => {
    const { events } = groupEvents([
      item('Lakeshore v Pinecrest', 'Lakeshore', 'Pinecrest', 'c1'),
      item('Lakeshore v Pinecrest', 'Lakeshore', 'Pinecrest', 'c1', 5),
      item('Lakeshore v Pinecrest', 'Lakeshore', 'Pinecrest', 'c2'),
      item('Lakeshore - Pinecrest', 'Lakeshore', 'Pinecrest', 'c3'),
    ], new Map(), id);
    expect(events[0]!.airings).toEqual(['c1', 'c2', 'c3']);
    expect(events[0]!.title).toBe('Lakeshore v Pinecrest');
  });

  test('title-only events group by title', () => {
    const t = (ch: string): GroupInput<string> => ({ nt: 'grand prix race', title: 'Grand Prix Race', start: T0, stop: T0 + 120 * M, live: false, airing: ch });
    expect(groupEvents([t('c1'), t('c2')], new Map(), id).events).toHaveLength(1);
  });

  test('sides that normalise to empty fall back to grouping by title', () => {
    const e = (title: string, ch: string): GroupInput<string> => ({
      ns: [normSide('FC'), normSide('AFC')], nt: title.toLowerCase(), title, sides: ['FC', 'AFC'],
      start: T0, stop: T0 + 120 * M, live: false, airing: ch,
    });
    const { events } = groupEvents([e('Cup Final', 'c1'), e('Cup Final', 'c2'), e('Other Show', 'c3')], new Map(), id);
    expect(events.map((g) => g.key).sort()).toEqual(['t:cup final', 't:other show']);
    expect(events.find((g) => g.key === 't:cup final')!.airings).toEqual(['c1', 'c2']);
  });

  test('budget: 50k candidates group in under 300 ms', () => {
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
    const { events } = groupEvents(items, new Map(), id);
    const ms = performance.now() - t;
    expect(ms).toBeLessThan(300);
    expect(events).toHaveLength(5000);
  });
});

describe('isFollowed', () => {
  test('exact after normalising, alias, or close (0.92), on either side', () => {
    expect(isFollowed(['Northbridge FC', 'Eastport'], ['northbridge'], new Map())).toBe(true);
    expect(isFollowed(['Northbridge FC', 'Eastport'], ['Eastport'], new Map())).toBe(true);
    expect(isFollowed(['NB', 'Eastport'], ['Northbridge'], new Map([['nb', 'northbridge']]))).toBe(true);
    expect(isFollowed(['Northbridge FC', 'Eastport'], ['Kingsgate'], new Map())).toBe(false);
    expect(isFollowed(undefined, ['Kingsgate'], new Map())).toBe(false);
  });
});
