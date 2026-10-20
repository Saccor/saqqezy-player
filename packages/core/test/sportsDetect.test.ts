import { describe, expect, test } from 'vitest';
import { EVENT_THRESHOLD, mayBeEvent, parseMatch, scoreProgramme } from '../src/sports/detect.ts';
import { MATCH_FLAGS } from '../src/sports/words.ts';

const H = 3600_000;
const p = (title: string, hours = 2) => ({ title, start: 0, stop: hours * H });
const isEvent = (title: string, extra?: Parameters<typeof scoreProgramme>[1], hours = 2) =>
  scoreProgramme(p(title, hours), extra).score >= EVENT_THRESHOLD;

describe('scoreProgramme', () => {
  test('mayBeEvent: false only when the programme cannot reach the threshold, and then scoreProgramme agrees', () => {
    const cases: [string, Parameters<typeof scoreProgramme>[1]][] = [
      ['Evening News', undefined], ['Northbridge FC v Eastport', undefined], ['Northbridge FC v Eastport', { categories: ['News'] }],
      ['Cooking Show', { categories: ['Lifestyle'], subTitle: 'Lakeshore v Pinecrest' }],
      ['Live at the Hall', undefined], ['Magazine', { categories: ['0x42'] }],
    ];
    for (const [title, extra] of cases) {
      expect(mayBeEvent(title, extra)).toBe(false);
      expect(scoreProgramme(p(title), extra).score).toBeLessThan(EVENT_THRESHOLD);
    }
    expect(mayBeEvent('Northbridge FC v Eastport', { categories: ['Sports'] })).toBe(true);
    expect(mayBeEvent('Northbridge FC v Eastport', { live: true })).toBe(true);
    expect(mayBeEvent('LIVE: Northbridge FC v Eastport')).toBe(true);
    expect(mayBeEvent('Northbridge FC v Eastport', { categories: ['0x43'] })).toBe(true);
  });

  test('sports category plus two sides is an event; sides are split', () => {
    const d = scoreProgramme(p('Northbridge FC v Eastport'), { categories: ['Sports'] });
    expect(d.score).toBe(4);
    expect(d.sides).toEqual(['Northbridge FC', 'Eastport']);
    expect(d.cleanTitle).toBe('Northbridge FC v Eastport');
  });
  test('every separator splits', () => {
    for (const sep of ['v', 'vs', 'vs.', '-', '–', '—', 'x', '@', 'gegen', 'mot']) {
      expect(scoreProgramme(p(`Harbour City ${sep} Westvale United`)).sides).toEqual(['Harbour City', 'Westvale United']);
    }
  });
  test('live prefix is stripped and counts', () => {
    const d = scoreProgramme(p('LIVE: Rivermouth Rovers vs Kingsgate'));
    expect(d.cleanTitle).toBe('Rivermouth Rovers vs Kingsgate');
    expect(d.live).toBe(true);
    expect(d.score).toBe(4);
    expect(scoreProgramme(p('DIREKT Lakeshore - Pinecrest')).live).toBe(true);
    expect(scoreProgramme(p('(L) Lakeshore - Pinecrest')).live).toBe(true);
  });
  test('the live flag counts like the prefix', () => {
    expect(isEvent('Lakeshore - Pinecrest', { live: true })).toBe(true);
  });
  test('competition prefix before a colon is dropped from the title', () => {
    expect(scoreProgramme(p('Test Cup: Lakeshore v Pinecrest'), { categories: ['Football'] }).cleanTitle).toBe('Lakeshore v Pinecrest');
  });
  test('sides from the sub-title when the title has none', () => {
    const d = scoreProgramme(p('Test Cup Football'), { categories: ['Sport'], subTitle: 'Lakeshore v Pinecrest' });
    expect(d.sides).toEqual(['Lakeshore', 'Pinecrest']);
    expect(d.score).toBe(3);
  });
  test('DVB sports codes count, the magazine code does not', () => {
    expect(isEvent('Lakeshore v Pinecrest', { categories: ['0x43'] })).toBe(true);
    expect(isEvent('Lakeshore v Pinecrest', { categories: ['0x42'] })).toBe(false);
  });
  test('negatives: highlights, replay, reruns, short two-sides slots', () => {
    expect(isEvent('Northbridge FC v Eastport Highlights', { categories: ['Sports'] })).toBe(false);
    expect(isEvent('Northbridge FC v Eastport', { categories: ['Sports'], rerun: true })).toBe(false);
    expect(isEvent('Northbridge FC v Eastport (R)', { categories: ['Sports'] })).toBe(false);
    expect(isEvent('Northbridge FC v Eastport', { categories: ['Sports'] }, 0.5)).toBe(false);
  });
  test('false-positive guards: a film or talk show with "vs" and no sports signal', () => {
    expect(isEvent('Hollis vs Hollis', { categories: ['Film'] })).toBe(false);
    expect(isEvent('Morning Show - Weekend')).toBe(false);
  });
  test('numeric sides and very long sides are not sides', () => {
    expect(scoreProgramme(p('2024 - 2025')).sides).toBeUndefined();
    expect(scoreProgramme(p(`${'a'.repeat(50)} v b2`)).sides).toBeUndefined();
  });
  test('a plain sports category alone is not an event', () => {
    expect(isEvent('Golf Weekly', { categories: ['Sports'] })).toBe(false);
  });
});

describe('parseMatch (index v2, design note §3.2)', () => {
  test('the strongest separator wins and a competition prefix is peeled (fixture 2)', () => {
    for (const t of ['Northern Cup - Northbridge FC v Eastport', 'Northern Cup | Northbridge FC v Eastport', 'Northern Cup: Northbridge FC v Eastport']) {
      const m = parseMatch(t)!;
      expect(m.sides).toEqual(['Northbridge FC', 'Eastport']);
      expect(m.comp).toBe('Northern Cup');
      expect(m.strong).toBe(true);
      expect(m.title).toBe('Northbridge FC v Eastport');
    }
  });
  test('suffixes are peeled: live, tags and stages; a short plain suffix is the competition (fixture 3)', () => {
    expect(parseMatch('Northbridge FC v Eastport - Live')).toMatchObject({ sides: ['Northbridge FC', 'Eastport'], live: true });
    expect(parseMatch('Northbridge FC v Eastport - Live')!.comp).toBeUndefined();
    expect(parseMatch('Northbridge FC v Eastport (R)')!.sides).toEqual(['Northbridge FC', 'Eastport']);
    const staged = parseMatch('Northbridge FC v Eastport, Round 12')!;
    expect(staged.sides).toEqual(['Northbridge FC', 'Eastport']);
    expect(staged.comp).toBeUndefined();
    expect(parseMatch('Northbridge FC v Eastport | Test Cup')!.comp).toBe('Test Cup');
    expect(parseMatch('Northbridge FC v Eastport: Höjdpunkter')!.sides).toEqual(['Northbridge FC', 'Eastport']);
  });
  test('weak separators split only without a strong one; a stage prefix is not a competition', () => {
    expect(parseMatch('Northbridge FC - Eastport (Wdh.)')).toMatchObject({ sides: ['Northbridge FC', 'Eastport'], strong: false });
    const t = parseMatch('Final: A. Marlow - J. Okafor')!;
    expect(t.sides).toEqual(['A. Marlow', 'J. Okafor']);
    expect(t.comp).toBeUndefined();
    expect(parseMatch('Lakeshore x Pinecrest - Live')).toMatchObject({ sides: ['Lakeshore', 'Pinecrest'], strong: false, live: true });
  });
  test('a side has at most 5 words and no tag word', () => {
    expect(parseMatch('Evening News - Weekend Edition')).toBeUndefined();
    expect(parseMatch('One Two Three Four Five Six v Eastport')).toBeUndefined();
    expect(parseMatch('Matchday Studio')).toBeUndefined();
  });
});

describe('tag flags (design note §3.3)', () => {
  const flagsOf = (title: string, extra?: Parameters<typeof scoreProgramme>[1], desc?: string, hours = 2) =>
    scoreProgramme({ title, start: 0, stop: hours * H, ...(desc ? { desc } : {}) }, extra).flags;
  test('replay tags in several languages, the rerun flag and a desc mention (fixture 8)', () => {
    for (const t of ['Northbridge FC - Eastport (Wdh.)', 'Northbridge FC v Eastport (R)', 'Northbridge FC v Eastport - Repetición',
      'Northbridge FC v Eastport - Rediffusion', 'Northbridge FC v Eastport (repris)']) {
      expect(flagsOf(t) & MATCH_FLAGS.replay).toBeTruthy();
    }
    expect(flagsOf('Northbridge FC v Eastport', { rerun: true }) & MATCH_FLAGS.rerun).toBeTruthy();
    expect(flagsOf('Northbridge FC v Eastport', undefined, 'Wiederholung vom Samstag') & MATCH_FLAGS.replay).toBeTruthy();
    expect(flagsOf('Northbridge FC v Eastport')).toBe(0);
  });
  test('highlights and studio tags in the title or sub-title (fixtures 6–8)', () => {
    expect(flagsOf('Northbridge FC v Eastport: Höjdpunkter') & MATCH_FLAGS.highlights).toBeTruthy();
    expect(flagsOf('Northbridge FC v Eastport - Resumen') & MATCH_FLAGS.highlights).toBeTruthy();
    expect(flagsOf('Northbridge FC v Eastport', { subTitle: 'Extended highlights' }) & MATCH_FLAGS.highlights).toBeTruthy();
    expect(flagsOf('Northbridge v Eastport: Build-up') & MATCH_FLAGS.studio).toBeTruthy();
    expect(flagsOf('LIVE: Matchday Studio') & MATCH_FLAGS.studio).toBeTruthy();
  });
  test('a desc never sets studio or highlights (a live match desc may mention the build-up)', () => {
    expect(flagsOf('Northbridge FC v Eastport', undefined, 'Live, with build-up, analysis and all the goals.')).toBe(0);
  });
  test('live marker and weak separator bits', () => {
    expect(flagsOf('LIVE: Northbridge FC v Eastport') & MATCH_FLAGS.live).toBeTruthy();
    expect(flagsOf('Northbridge FC - Eastport') & MATCH_FLAGS.weakSep).toBeTruthy();
    expect(flagsOf('Northbridge FC v Eastport') & MATCH_FLAGS.weakSep).toBe(0);
  });
  test('detection keeps the competition: prefix, then sub-title, then a non-generic category', () => {
    expect(scoreProgramme(p('Northern Cup: Northbridge FC v Eastport'), { categories: ['Football'] }).comp).toBe('Northern Cup');
    expect(scoreProgramme(p('Lakeshore v Pinecrest'), { categories: ['Sports'], subTitle: 'Test Cup: Round 3' }).comp).toBe('Test Cup');
    expect(scoreProgramme(p('Lakeshore v Pinecrest'), { categories: ['Sports', 'Northern League'] }).comp).toBe('Northern League');
    expect(scoreProgramme(p('Lakeshore v Pinecrest'), { categories: ['Sports', 'Football', 'Live', '0x43'] }).comp).toBeUndefined();
    expect(scoreProgramme(p('Lakeshore v Pinecrest'), { categories: ['Sports'], subTitle: 'Round 3' }).comp).toBeUndefined();
  });
  test('sport signal and separator strength are reported', () => {
    expect(scoreProgramme(p('Lakeshore v Pinecrest'), { categories: ['Fotboll'] })).toMatchObject({ sportCat: true, strong: true });
    expect(scoreProgramme(p('Lakeshore - Pinecrest'), { live: true })).toMatchObject({ sportCat: false, strong: false });
  });
});
