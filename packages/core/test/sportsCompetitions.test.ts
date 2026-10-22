import { describe, expect, test } from 'vitest';
import { CATEGORY_CHIPS_MAX, COMPETITION_CHIPS_MAX, COMPETITION_CHIPS_PER_SPORT, categoryKey, competitionChips, matchFilters } from '../src/sports/competitions.ts';
import { sanitizeSettings } from '../src/settings.ts';

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
  test("category keys use the setting's normaliser; texts the setting cannot store are never chips", () => {
    expect(categoryKey('  Ice  Hockey ')).toBe('ice hockey');
    expect(categoryKey('Fútbol')).toBe('futbol');
    const long = 'A Very Long Guide Category Text Beyond Forty';
    const l = new Map([[categoryKey('Ice  Hockey'), 'Ice  Hockey'], [categoryKey(long), long]]);
    const chips = matchFilters([{ breadth: 1, cats: [categoryKey('Ice  Hockey'), categoryKey(long)] }], l).categories;
    expect(chips).toEqual([{ id: 'ice hockey', label: 'Ice  Hockey' }]);
    expect(sanitizeSettings({ matchCategories: chips.map((c) => c.id) }).matchCategories).toEqual(['ice hockey']);
  });
});

describe('competitionChips (spec 2026-10-22 §3.2)', () => {
  const none = { pinned: [] as string[], hidden: [] as string[] };
  const events = [
    { comp: 'Test Cup', breadth: 3, cats: ['football'] }, { comp: 'test cup', breadth: 2, cats: ['football'] },
    { comp: 'Northern Cup', breadth: 10, cats: ['football'] }, { comp: 'Northern Cup', breadth: 9, cats: ['football'] },
    { comp: 'Ice Series', breadth: 8, cats: ['ice hockey'] }, { comp: 'Ice Series', breadth: 8, cats: ['ice hockey'] },
    { comp: 'One Final', breadth: 6, cats: ['football'] },
    { comp: 'Once Small', breadth: 1, cats: ['football'] },
    { breadth: 20, cats: ['football'] },
  ];

  test("only that category's competitions, by summed breadth; a single widely carried event counts; first spelling", () => {
    expect(competitionChips(events, 'football', none)).toEqual({
      chips: [
        { id: 'northern cup', label: 'Northern Cup' }, { id: 'one final', label: 'One Final' }, { id: 'test cup', label: 'Test Cup' },
      ],
      more: [],
    });
    expect(competitionChips(events, 'ice hockey', none).chips).toEqual([{ id: 'ice series', label: 'Ice Series' }]);
    expect(competitionChips(events, 'tennis', none)).toEqual({ chips: [], more: [] });
  });

  test('a competition in two categories shows under both', () => {
    const both = [{ comp: 'Mixed Games', breadth: 5, cats: ['football', 'ice hockey'] }];
    expect(competitionChips(both, 'football', none).chips.map((c) => c.id)).toEqual(['mixed games']);
    expect(competitionChips(both, 'ice hockey', none).chips.map((c) => c.id)).toEqual(['mixed games']);
  });

  test('pinned come first and are marked (even with one small event); hidden are left out', () => {
    const r = competitionChips(events, 'football', { pinned: ['once small'], hidden: ['northern cup'] });
    expect(r.chips).toEqual([
      { id: 'once small', label: 'Once Small', pinned: true }, { id: 'one final', label: 'One Final' }, { id: 'test cup', label: 'Test Cup' },
    ]);
  });

  test('the first 8 are chips, the rest go to more', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ comp: `Cup ${String.fromCharCode(65 + i)}`, breadth: 20 - i, cats: ['football'] }));
    const r = competitionChips(many, 'football', none);
    expect(r.chips).toHaveLength(COMPETITION_CHIPS_PER_SPORT);
    expect(r.chips[0]!.label).toBe('Cup A');
    expect(r.more.map((c) => c.label)).toEqual(['Cup I', 'Cup J', 'Cup K', 'Cup L']);
  });
});
