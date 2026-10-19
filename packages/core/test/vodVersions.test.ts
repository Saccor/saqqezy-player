import { describe, expect, test } from 'vitest';
import { orderVersions, preferredLanguages, type VersionCandidate } from '../src/vod/versions.ts';

const v = (id: string, lang: string | undefined, quality: number, activeAt?: number): VersionCandidate => {
  const c: VersionCandidate = { id, quality };
  if (lang) c.lang = lang;
  if (activeAt !== undefined) c.activeAt = activeAt;
  return c;
};
const ids = (cs: VersionCandidate[]) => cs.map((c) => c.id);

describe('orderVersions', () => {
  const cands = [v('en-hd', 'en', 2), v('sv-fhd', 'sv', 1), v('sv-4k', 'sv', 0), v('none-hd', undefined, 2), v('da-4k', 'da', 0)];

  test('preferred languages in order, best quality first within each', () => {
    expect(ids(orderVersions(cands, { langs: ['sv', 'en'] }))).toEqual(['sv-4k', 'sv-fhd', 'en-hd', 'none-hd', 'da-4k']);
  });

  test('no preferred match: no-language versions (often the original) first, then by quality', () => {
    expect(ids(orderVersions(cands, { langs: ['fi'] }))).toEqual(['none-hd', 'sv-4k', 'da-4k', 'sv-fhd', 'en-hd']);
  });

  test('the remembered pick beats preferences', () => {
    expect(ids(orderVersions(cands, { langs: ['sv'], pick: 'en-hd' }))[0]).toBe('en-hd');
  });

  test('a pick that is not a member is ignored', () => {
    expect(ids(orderVersions(cands, { langs: ['sv'], pick: 'gone' }))[0]).toBe('sv-4k');
  });

  test('a version in progress beats the pick; the most recent wins', () => {
    const withProgress = [...cands.slice(0, 3), v('none-hd', undefined, 2, 100), v('da-4k', 'da', 0, 200)];
    expect(ids(orderVersions(withProgress, { langs: ['sv'], pick: 'en-hd' })).slice(0, 3)).toEqual(['da-4k', 'none-hd', 'en-hd']);
  });

  test('ties keep list order', () => {
    expect(ids(orderVersions([v('a', 'en', 1), v('b', 'en', 1)], { langs: ['en'] }))).toEqual(['a', 'b']);
  });

  test('does not change the input', () => {
    const copy = [...cands];
    orderVersions(cands, { langs: ['sv'] });
    expect(cands).toEqual(copy);
  });
});

describe('preferredLanguages', () => {
  test('empty setting: the TV language, then English', () => {
    expect(preferredLanguages([], 'sv-SE')).toEqual(['sv', 'en']);
    expect(preferredLanguages([], 'en-US')).toEqual(['en']);
    expect(preferredLanguages([], undefined)).toEqual(['en']);
    expect(preferredLanguages([], 'nb-NO')).toEqual(['no', 'en']);
  });
  test('a set list is used as is', () => {
    expect(preferredLanguages(['da', 'sv'], 'en-US')).toEqual(['da', 'sv']);
  });
});
