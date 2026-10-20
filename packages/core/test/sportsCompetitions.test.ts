import { describe, expect, test } from 'vitest';
import { CATEGORY_CHIPS_MAX, COMPETITION_CHIPS_MAX, matchFilters } from '../src/sports/competitions.ts';

const labels = new Map([['fotboll', 'Fotboll'], ['ishockey', 'Ishockey'], ['sport', 'Sport'], ['0x43', '0x43'], ['tennis', 'Tennis']]);

describe('matchFilters (design note §3.7)', () => {
  test('category chips use the guide\'s own text, leave out generic ones, football words first, then by count (fixture 16)', () => {
    const events = [
      { breadth: 1, cats: ['ishockey', 'sport'] }, { breadth: 1, cats: ['ishockey'] }, { breadth: 1, cats: ['ishockey', '0x43'] },
      { breadth: 1, cats: ['fotboll'] }, { breadth: 1, cats: ['tennis'] }, { breadth: 1, cats: ['tennis'] },
    ];
    expect(matchFilters(events, labels).categories).toEqual([
      { id: 'fotboll', label: 'Fotboll' }, { id: 'ishockey', label: 'Ishockey' }, { id: 'tennis', label: 'Tennis' },
    ]);
  });
  test('a guide with no categories shows no chips', () => {
    expect(matchFilters([{ breadth: 3, cats: [] }], new Map()).categories).toEqual([]);
  });
  test('competition chips: texts in 2 or more events, by summed breadth, the first spelling as the label', () => {
    const events = [
      { comp: 'Test Cup', breadth: 1, cats: [] }, { comp: 'test cup', breadth: 2, cats: [] },
      { comp: 'Northern League', breadth: 10, cats: [] }, { comp: 'Northern League', breadth: 9, cats: [] },
      { comp: 'Once Only', breadth: 40, cats: [] },
    ];
    expect(matchFilters(events, new Map()).competitions).toEqual([
      { id: 'northern league', label: 'Northern League' }, { id: 'test cup', label: 'Test Cup' },
    ]);
  });
  test('caps', () => {
    const events = Array.from({ length: 60 }, (_, i) => ({ comp: `Cup ${i % 20}`, breadth: 1, cats: [`cat${i % 10}`] }));
    const l = new Map(Array.from({ length: 10 }, (_, i) => [`cat${i}`, `Cat ${i}`] as [string, string]));
    const f = matchFilters(events, l);
    expect(f.competitions).toHaveLength(COMPETITION_CHIPS_MAX);
    expect(f.categories).toHaveLength(CATEGORY_CHIPS_MAX);
  });
});
