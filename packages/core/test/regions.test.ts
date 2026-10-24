import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parseM3u, type M3uEntry } from '../src/m3u/parse.ts';
import { m3uEntriesToChannels } from '../src/m3u/toChannels.ts';
import {
  REGION_SURE, countryLabel, countryLanguages, detectRegions, isSure, normalizeCountry, regionInputs, regionKeys,
  tallyTvg, type GroupRegion,
} from '../src/text/regions.ts';

async function* lines(text: string) { for (const l of text.split(/\r?\n/)) yield l; }

async function fixture(name: string): Promise<Record<string, GroupRegion>> {
  const text = readFileSync(new URL(`./fixtures/regions/${name}`, import.meta.url), 'utf8');
  const entries: M3uEntry[] = [];
  for await (const e of parseM3u(lines(text))) entries.push(e);
  const channels = m3uEntriesToChannels('s', entries);
  return detectRegions(regionInputs(channels, tallyTvg(entries)));
}

describe('country table', () => {
  test('normalises GB/UK, alpha-3 aliases and case; unknown codes are undefined', () => {
    expect(normalizeCountry('UK')).toBe('GB');
    expect(normalizeCountry('gb')).toBe('GB');
    expect(normalizeCountry('SWE')).toBe('SE');
    expect(normalizeCountry('USA')).toBe('US');
    expect(normalizeCountry('TV')).toBeUndefined();
    expect(normalizeCountry('SD')).toBeUndefined();
    expect(normalizeCountry('EN')).toBeUndefined();
  });
  test('English labels and default languages, without Intl', () => {
    expect(countryLabel('SE')).toBe('Sweden');
    expect(countryLabel('GB')).toBe('United Kingdom');
    expect(countryLabel('lang:en')).toBe('English');
    expect(countryLanguages('SE')).toEqual(['sv']);
    expect(countryLanguages('CH')).toEqual(['de', 'fr', 'it']);
    expect(countryLanguages('XX')).toEqual([]);
  });
});

describe('detectRegions: fixtures', () => {
  test('leading codes follow the source style; ambiguous codes need two groups', async () => {
    const r = await fixture('prefixed.m3u');
    expect(r['g:SE | Synthetic News']).toMatchObject({ countries: ['SE'], langs: ['sv'], via: 'code' });
    expect(r['g:SE | Synthetic News']!.conf).toBeCloseTo(0.89);
    expect(r['g:DK | Synthetic Docs']).toMatchObject({ countries: ['DK'], langs: ['da'] });
    // NO is ambiguous: two groups, the source's separator.
    expect(r['g:NO | Synthetic Sport']).toMatchObject({ countries: ['NO'], via: 'code' });
    expect(r['g:NO | Synthetic Sport']!.conf).toBeCloseTo(0.7);
    // UK is ambiguous and used by one group only.
    expect(r['g:UK | Synthetic Drama']).toBeUndefined();
    // A language code is a language-only group.
    expect(r['g:EN | Synthetic Cinema']).toMatchObject({ countries: [], langs: ['en'], via: 'code' });
    // Breaking the source style costs 0.1.
    expect(r['g:SE: Synthetic Music']!.conf).toBeCloseTo(0.75);
    // Member vote: 3 of 4 members carry SE.
    expect(r['g:News']).toMatchObject({ countries: ['SE'], via: 'members' });
    expect(r['g:News']!.conf).toBeCloseTo(0.7);
  });

  test('tvg-country majority; GB/UK merge; no majority gives nothing', async () => {
    const r = await fixture('tvg.m3u');
    expect(r['g:Mixed']).toMatchObject({ countries: ['SE'], langs: ['sv'], via: 'tvg' });
    expect(r['g:Mixed']!.conf).toBeCloseTo(0.9);
    expect(r['g:Uk Mixed']).toMatchObject({ countries: ['GB'], via: 'tvg' });
    expect(r['g:Global']).toBeUndefined();
  });

  test('false positives stay undetected', async () => {
    const r = await fixture('false-positives.m3u');
    for (const g of ['IT Synthetic Crowd', 'MY Synthetic Picks', 'AL | Synthetic Gold', 'IN | Synthetic Late',
      'UP - Synthetic Late', 'Synthetic Crowd HD', 'Synthetic | TV', 'Picks', 'Duo',
      // Country names that are also English words.
      'Synthetic Island Docs', 'Synthetic Turkey Kitchen', 'Jordan Synthetic Talk', 'Synthetic Chile Recipes']) {
      expect(r[`g:${g}`], g).toBeUndefined();
    }
    expect(r['g:FI | Synthetic Talk']).toMatchObject({ countries: ['FI'] });
  });

  test('flags, names, region words and trailing codes', async () => {
    const r = await fixture('names.m3u');
    expect(r['g:🇸🇪 Synthetic News']).toMatchObject({ countries: ['SE'], via: 'flag' });
    expect(r['g:SVERIGE']).toMatchObject({ countries: ['SE'], via: 'name' });
    expect(r['g:SVERIGE']!.conf).toBeCloseTo(0.8);
    expect(r['g:Deutschland Synthetic']).toMatchObject({ countries: ['DE'], via: 'name' });
    expect(r['g:Swedish Synthetic Docs']).toMatchObject({ countries: ['SE'], via: 'name' });
    // A name that is also an English word counts only in an all-caps group name.
    expect(r['g:TURKEY SYNTHETIC']).toMatchObject({ countries: ['TR'], via: 'name' });
    expect(r['g:NORDIC']).toMatchObject({ countries: ['SE', 'NO', 'DK', 'FI', 'IS'], via: 'region' });
    expect(r['g:NORDIC']!.conf).toBeCloseTo(0.7);
    expect(r['g:SCANDINAVIA Synthetic']).toMatchObject({ countries: ['SE', 'NO', 'DK'], via: 'region' });
    const trailing = r['g:Synthetic Weekly (FI)']!;
    expect(trailing).toMatchObject({ countries: ['FI'], via: 'trailing' });
    expect(trailing.conf).toBeLessThan(REGION_SURE);
    expect(isSure(trailing)).toBe(false);
  });
});

describe('detectRegions: rules', () => {
  const g = (id: string, members: string[] = []) => ({ id: `g:${id}`, name: id, members });

  test('a user override wins with confidence 1', () => {
    const r = detectRegions([g('SE | Synthetic News')], { 'g:SE | Synthetic News': ['DK', 'lang:en'] });
    expect(r['g:SE | Synthetic News']).toEqual({ countries: ['DK'], langs: ['en', 'da'], conf: 1, via: 'user' });
  });

  test('a tvg-country majority beats a leading code, even one in the source style', () => {
    const tvg = { members: 4, withCountry: 4, country: { DK: 3, SE: 1 }, withLanguage: 0, language: {} };
    const r = detectRegions([
      { id: 'g:SE | Synthetic One', name: 'SE | Synthetic One', tvg }, g('SE | Synthetic Two'), g('FI | Synthetic Three'),
    ]);
    expect(r['g:SE | Synthetic One']).toMatchObject({ countries: ['DK'], via: 'tvg' });
    expect(r['g:SE | Synthetic Two']).toMatchObject({ countries: ['SE'], via: 'code' });
    expect(r['g:SE | Synthetic Two']!.conf).toBeLessThan(0.9);
    expect(isSure(r['g:SE | Synthetic Two']!)).toBe(true);
  });

  test('an ambiguous code needs the source style', () => {
    // Two IT groups but the source writes its codes with ":" (dominant), so "IT |" breaks it.
    const r = detectRegions([g('IT | Synthetic One'), g('IT | Synthetic Two'), g('SE: A'), g('DK: B'), g('FI: C'), g('DE: D'), g('FR: E')]);
    expect(r['g:IT | Synthetic One']).toBeUndefined();
    expect(r['g:SE: A']).toMatchObject({ countries: ['SE'] });
  });

  test('two UK groups in the source style are GB', () => {
    const r = detectRegions([g('UK | Synthetic One'), g('UK | Synthetic Two'), g('SE | Synthetic Three')]);
    expect(r['g:UK | Synthetic One']).toMatchObject({ countries: ['GB'], langs: ['en'] });
  });

  test('a space-separated code counts only when the source writes codes that way', () => {
    const spaced = detectRegions([g('SE Synthetic One'), g('DK Synthetic Two'), g('FI Synthetic Three')]);
    expect(spaced['g:SE Synthetic One']).toMatchObject({ countries: ['SE'] });
    const barred = detectRegions([g('SE Synthetic One'), g('DK | Synthetic Two'), g('FI | Synthetic Three')]);
    expect(barred['g:SE Synthetic One']).toBeUndefined();
  });

  test('regionKeys: countries, else language keys', () => {
    expect(regionKeys({ countries: ['SE'], langs: ['sv'], conf: 0.9, via: 'code' })).toEqual(['SE']);
    expect(regionKeys({ countries: [], langs: ['en'], conf: 0.9, via: 'code' })).toEqual(['lang:en']);
  });
});

describe('detectRegions: trailing code', () => {
  const g = (name: string) => ({ id: `g:${name}`, name, members: [] });

  test('a code at the end after a separator; not a whole-name code, not glued to a word', () => {
    const r = detectRegions([g('Synthetic News | SE'), g('Synthetic Docs (DK) '), g('SE'), g('Synthetic NewsSE'), g('Synthetic | ABSE')]);
    expect(r['g:Synthetic News | SE']).toMatchObject({ countries: ['SE'], via: 'trailing' });
    expect(r['g:Synthetic Docs (DK) ']).toMatchObject({ countries: ['DK'], via: 'trailing' });
    expect(r['g:Synthetic NewsSE']).toBeUndefined();
    expect(r['g:Synthetic | ABSE']).toBeUndefined();
  });

  test('a long separator run before the end is linear, not quadratic', () => {
    const t = performance.now();
    const r = detectRegions([g('Synthetic' + ' |'.repeat(40000) + 'x'), g('Synthetic' + ' |'.repeat(40000) + 'SE')]);
    expect(performance.now() - t).toBeLessThan(200);
    expect(Object.values(r).map((x) => x.countries)).toEqual([['SE']]);
  });
});

describe('detectRegions: performance', () => {
  test('50k channels in 2k groups in under 30 ms', () => {
    const codes = ['SE', 'DK', 'FI', 'DE', 'FR', 'NL', 'PL', 'ES', 'PT', 'GR'];
    const groups = Array.from({ length: 2000 }, (_, i) => {
      const code = codes[i % codes.length]!;
      const name = i % 4 === 0 ? `Synthetic Group ${i}` : `${code} | Synthetic Group ${i}`;
      const members = Array.from({ length: 25 }, (_, k) => (k % 2 ? `${code}: Synthetic ${i}-${k}` : `Synthetic ${i}-${k} HD`));
      return { id: `g:${name}`, name, members };
    });
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const t = performance.now();
      detectRegions(groups);
      best = Math.min(best, performance.now() - t);
    }
    expect(best).toBeLessThan(30);
  });
});

describe('Kurdistan', () => {
  const g = (id: string) => ({ id: `g:${id}`, name: id });

  test('a country key with a label, Kurdish by default, and its code spellings', () => {
    expect(normalizeCountry('KU')).toBe('KU');
    expect(normalizeCountry('KUR')).toBe('KU');
    expect(normalizeCountry('KRD')).toBe('KU');
    expect(countryLabel('KU')).toBe('Kurdistan');
    expect(countryLanguages('KU')).toEqual(['ku']);
  });

  test('leading codes and names find it', () => {
    const r = detectRegions([g('KU | Synthetic News'), g('KURDISH Synthetic Music'), g('Synthetic Kurdistan Docs'), g('SE | Synthetic Talk')]);
    expect(r['g:KU | Synthetic News']).toMatchObject({ countries: ['KU'], langs: ['ku'], via: 'code' });
    expect(r['g:KURDISH Synthetic Music']).toMatchObject({ countries: ['KU'], via: 'name' });
    expect(r['g:Synthetic Kurdistan Docs']).toMatchObject({ countries: ['KU'], via: 'name' });
  });
});
