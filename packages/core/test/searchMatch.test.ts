import { describe, expect, test } from 'vitest';
import { compileQuery, matchKey, nameMatchScore, nameKeys, NO_MATCH } from '../src/text/searchMatch.ts';

const score = (name: string, query: string): number => {
  const q = compileQuery(query);
  if (!q) throw new Error('blank query');
  return nameMatchScore(nameKeys(name), q);
};
const hits = (query: string, names: string[]): string[] => names.filter((n) => score(n, query) !== NO_MATCH);

describe('matchKey', () => {
  test('searchKey with letters and digits split apart', () => {
    expect(matchKey('SE | Kanal5 HD')).toBe('se kanal 5 hd');
    expect(matchKey('TV4')).toBe('tv 4');
    expect(matchKey('Café 24/7')).toBe('cafe 24 7');
  });
});

describe('compileQuery', () => {
  test('blank: undefined; words of the match key', () => {
    expect(compileQuery('  | ')).toBeUndefined();
    expect(compileQuery('Kanal5')).toEqual({ key: 'kanal 5', words: ['kanal', '5'], compact: 'kanal5' });
  });
});

describe('matching', () => {
  const names = ['SE | Kanal 5 HD', '[SE] Kanal5', 'DE-Sport 1 FHD', 'Sport1 Extra', 'UK | News HD', 'Café Musik', 'Kanalen'];

  test('spaces between letters and digits do not matter', () => {
    expect(hits('kanal5', names)).toEqual(['SE | Kanal 5 HD', '[SE] Kanal5']);
    expect(hits('kanal 5', names)).toEqual(['SE | Kanal 5 HD', '[SE] Kanal5']);
    expect(hits('sport1', names)).toEqual(['DE-Sport 1 FHD', 'Sport1 Extra']);
  });

  test('every word, in any order', () => {
    expect(hits('5 kanal', names)).toEqual(['SE | Kanal 5 HD', '[SE] Kanal5']);
    expect(hits('kanal hd', names)).toEqual(['SE | Kanal 5 HD']);
    expect(hits('news sport', names)).toEqual([]);
  });

  test('accents, case and punctuation are folded; words match inside names too', () => {
    expect(hits('CAFE', names)).toEqual(['Café Musik']);
    expect(hits('se: kanal', names)).toEqual(['SE | Kanal 5 HD', '[SE] Kanal5']);
    expect(hits('anal', names)).toEqual(['SE | Kanal 5 HD', '[SE] Kanal5', 'Kanalen']);
  });

  test('a compact query finds a name written apart, beyond digits', () => {
    expect(hits('cafemusik', names)).toEqual(['Café Musik']);
  });
});

describe('ranking (lower is better)', () => {
  test('the name without country prefix and quality tag wins, then its start, then word starts, then inside', () => {
    const exact = score('SE | Kanal 5 HD', 'kanal 5');
    const start = score('Kanal 5 Sport', 'kanal 5');
    const wordStart = score('Nya Kanal 5', 'kanal 5');
    const anyOrder = score('5 Plus Kanal', 'kanal 5');
    const inside = score('Superkanal 5', 'kanal 5');
    expect([exact, start, wordStart, anyOrder, inside]).toEqual([0, 1, 2, 3, 4]);
  });

  test('a compact-only match ranks last', () => {
    expect(score('Café Musik', 'cafemusik')).toBe(5);
  });

  test('"Kanal 5 (Backup)" no longer beats the prefixed "SE | Kanal 5"', () => {
    expect(score('SE | Kanal 5', 'kanal')).toBeLessThan(score('Kanal 5 (Backup)', 'kanal') + 1);
    expect(score('SE | Kanal 5', 'kanal 5')).toBeLessThan(score('Kanal 5 (Backup)', 'kanal 5'));
  });
});
