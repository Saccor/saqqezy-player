import { describe, expect, test } from 'vitest';
import { buildCountryChoices, type CountryChoicesInput } from '../src/countryChoices.ts';

const base: CountryChoicesInput = {
  live: [
    { keys: ['SE'], hidden: false }, { keys: ['SE'], hidden: false }, { keys: ['DK'], hidden: false }, { keys: ['DK'], hidden: false },
    { keys: ['DK'], hidden: false }, { keys: ['BE'], hidden: true }, { keys: [], hidden: false }, { keys: ['SE', 'NO'], hidden: false },
  ],
  vod: [],
  regions: { codes: [], mode: 'off' }, foldCountries: true, combineCategories: false,
};

describe('buildCountryChoices', () => {
  test('sure keys only, user-hidden folders count nowhere, most folders first, ties by label', () => {
    const c = buildCountryChoices(base);
    expect(c.choices.map((x) => [x.key, x.live])).toEqual([['DK', 3], ['SE', 3], ['NO', 1]]);
    expect(c.choices[0]).toEqual({ key: 'DK', label: 'Denmark', isLanguage: false, live: 3 });
    expect(c).toMatchObject({ stale: false, counts: { live: 0 }, foldCountries: true, combineCategories: false });
    expect(c.deviceCountry).toBeUndefined();
  });

  test('this TV\'s country first when it is among the choices', () => {
    expect(buildCountryChoices({ ...base, deviceCountry: 'NO' }).choices.map((x) => x.key)).toEqual(['NO', 'DK', 'SE']);
    expect(buildCountryChoices({ ...base, deviceCountry: 'NO' }).deviceCountry).toBe('NO');
    expect(buildCountryChoices({ ...base, deviceCountry: 'PL' }).deviceCountry).toBeUndefined();
  });

  test('VOD kinds that are known add their counts (0 when absent); language keys say so', () => {
    const c = buildCountryChoices({ ...base, vod: [{ kind: 'movie', keys: [['SE'], ['lang:en'], ['SE']] }] });
    expect(c.choices.find((x) => x.key === 'SE')).toEqual({ key: 'SE', label: 'Sweden', isLanguage: false, live: 3, movies: 2 });
    expect(c.choices.find((x) => x.key === 'DK')).toMatchObject({ movies: 0 });
    expect(c.choices.find((x) => x.key === 'DK')!.series).toBeUndefined();
    expect(c.choices.find((x) => x.key === 'lang:en')).toEqual({ key: 'lang:en', label: 'English', isLanguage: true, live: 0, movies: 1 });
    expect(c.choices[0]!.key).toBe('SE'); // 3 live + 2 movies
  });

  test('counts: folders that go first with the picks; none while off; stale when no pick matches', () => {
    const vod = [{ kind: 'movie' as const, keys: [['SE'], ['lang:en']] }];
    const on = buildCountryChoices({ ...base, vod, regions: { codes: ['SE'], mode: 'first' } });
    expect(on.counts).toEqual({ live: 3, movies: 1 });
    expect(on.stale).toBe(false);
    expect(buildCountryChoices({ ...base, vod, regions: { codes: ['SE'], mode: 'off' } }).counts).toEqual({ live: 0, movies: 0 });
    const stale = buildCountryChoices({ ...base, regions: { codes: ['PL'], mode: 'only' } });
    expect(stale).toMatchObject({ stale: true, counts: { live: 0 } });
    expect(stale.regions).toEqual({ codes: ['PL'], mode: 'only' });
  });
});
