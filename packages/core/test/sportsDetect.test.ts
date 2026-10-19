import { describe, expect, test } from 'vitest';
import { EVENT_THRESHOLD, mayBeEvent, scoreProgramme } from '../src/sports/detect.ts';

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
