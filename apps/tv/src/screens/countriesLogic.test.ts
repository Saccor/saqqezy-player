import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CountryChoices } from '@iptv/app-api';
import { countryLanguages } from '@iptv/core';
import { COUNTRIES_COPY } from '../copy.ts';
import { PREFERRED_LANGUAGE_OPTIONS } from '../vod/versionsLogic.ts';
import {
  OTHER_FOLDERS, RESET_PATCH, SKIP_PATCH, applyPatch, createCountrySaver, firstRunFocus, firstRunLanguages, firstRunTarget, hasGrid,
  languageLine, loadApplies, loadChoices, notices, otherFoldersLabel, otherFoldersOf, otherFoldersPatch, pickPatch, preselect,
} from './countriesLogic.ts';

const choices = (over: Partial<CountryChoices> = {}): CountryChoices => ({
  choices: [{ key: 'SE', label: 'Sweden', isLanguage: false, live: 24 }, { key: 'BE', label: 'Belgium', isLanguage: false, live: 31 }],
  regions: { codes: [], mode: 'off' }, foldCountries: true, combineCategories: false, stale: false, counts: { live: 0 },
  ...over,
});
const ALLOWED = PREFERRED_LANGUAGE_OPTIONS.filter((c) => c !== 'auto');
afterEach(() => { vi.useRealTimers(); });

describe("Other countries' folders", () => {
  it('maps to mode and foldCountries both ways', () => {
    expect(OTHER_FOLDERS).toEqual(['fold', 'below', 'hidden']);
    expect(otherFoldersOf({ codes: [], mode: 'off' }, true)).toBe('fold');
    expect(otherFoldersOf({ codes: ['SE'], mode: 'first' }, false)).toBe('below');
    expect(otherFoldersOf({ codes: ['SE'], mode: 'only' }, true)).toBe('hidden');
    expect(otherFoldersPatch('fold')).toEqual({ mode: 'first', foldCountries: true });
    expect(otherFoldersPatch('below')).toEqual({ mode: 'first', foldCountries: false });
    expect(otherFoldersPatch('hidden')).toEqual({ mode: 'only' });
    expect(OTHER_FOLDERS.map(otherFoldersLabel)).toEqual(['In one folder', 'Below yours', 'Hidden']);
  });
  it('a pick keeps Hidden, else puts first; reset keeps the codes; skip clears them', () => {
    expect(pickPatch(['SE'], { codes: [], mode: 'off' })).toEqual({ codes: ['SE'], mode: 'first' });
    expect(pickPatch(['SE', 'BE'], { codes: ['SE'], mode: 'only' })).toEqual({ codes: ['SE', 'BE'], mode: 'only' });
    expect(RESET_PATCH).toEqual({ mode: 'off' });
    expect(SKIP_PATCH).toEqual({ codes: [], mode: 'off' });
    expect(applyPatch(choices(), { codes: ['SE'], mode: 'first', foldCountries: false })).toMatchObject({
      regions: { codes: ['SE'], mode: 'first' }, foldCountries: false,
    });
    expect(applyPatch(choices({ regions: { codes: ['SE'], mode: 'first' } }), RESET_PATCH).regions).toEqual({ codes: ['SE'], mode: 'off' });
  });
});

describe('notices', () => {
  it('fewer than two choices: one plain sentence and no grid', () => {
    const one = choices({ choices: [{ key: 'SE', label: 'Sweden', isLanguage: false, live: 4 }] });
    expect(hasGrid(one)).toBe(false);
    expect(notices(one)).toEqual([COUNTRIES_COPY.none]);
    expect(hasGrid(choices())).toBe(true);
  });
  it('stale, combining turned off (once, after the save that did it), combining back on', () => {
    expect(notices(choices({ stale: true, regions: { codes: ['PL'], mode: 'first' } }))).toEqual([COUNTRIES_COPY.stale]);
    const prev = choices({ combineCategories: true });
    const next = choices({ combineCategories: false, regions: { codes: ['SE'], mode: 'first' } });
    expect(notices(next, prev)).toEqual([COUNTRIES_COPY.combineOff]);
    expect(notices(next, next)).toEqual([]);
    expect(notices(choices({ combineCategories: true, regions: { codes: ['SE'], mode: 'first' } }))).toEqual([COUNTRIES_COPY.combineOn]);
    expect(notices(choices({ combineCategories: true, regions: { codes: ['SE'], mode: 'off' } }))).toEqual([]);
  });
});

describe('loadChoices', () => {
  it('the answer, or undefined after 2 s or on a failure', async () => {
    expect(await loadChoices(async () => choices())).toEqual(choices());
    expect(await loadChoices(() => Promise.reject(new Error('busy')))).toBeUndefined();
    vi.useFakeTimers();
    const slow = loadChoices(() => new Promise<CountryChoices>(() => {}));
    vi.advanceTimersByTime(2000);
    expect(await slow).toBeUndefined();
  });
});

describe('createCountrySaver', () => {
  it('fast presses send one merged write after 300 ms; only the newest answer counts', async () => {
    vi.useFakeTimers();
    const answers: ((c: CountryChoices) => void)[] = [];
    const send = vi.fn((_p: unknown) => new Promise<CountryChoices>((r) => { answers.push(r); }));
    const saved: CountryChoices[] = [];
    const s = createCountrySaver(send, (c) => saved.push(c), () => {});
    s.save({ codes: ['SE'], mode: 'first' });
    s.save({ codes: ['SE', 'BE'] });
    vi.advanceTimersByTime(299);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith({ codes: ['SE', 'BE'], mode: 'first' });
    s.save({ foldCountries: false });
    s.flush();
    expect(send).toHaveBeenCalledTimes(2);
    answers[1]!(choices({ foldCountries: false }));
    answers[0]!(choices());
    await Promise.resolve();
    await Promise.resolve();
    expect(saved).toEqual([choices({ foldCountries: false })]);
  });
  it('a reply while a newer patch waits is not adopted; the last reply with nothing pending is', async () => {
    vi.useFakeTimers();
    const answers: ((c: CountryChoices) => void)[] = [];
    const send = vi.fn((_p: unknown) => new Promise<CountryChoices>((r) => { answers.push(r); }));
    const saved: CountryChoices[] = [];
    const s = createCountrySaver(send, (c) => saved.push(c), () => {});
    s.save({ codes: ['A'] });
    vi.advanceTimersByTime(300);
    s.save({ codes: ['A', 'B'] });
    expect(s.busy()).toBe(true);
    answers[0]!(choices());
    await Promise.resolve();
    await Promise.resolve();
    expect(saved).toEqual([]);
    s.save({ codes: ['A', 'B', 'C'] });
    vi.advanceTimersByTime(300);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ codes: ['A', 'B', 'C'] });
    const last = choices({ stale: true });
    answers[1]!(last);
    await Promise.resolve();
    await Promise.resolve();
    expect(saved).toEqual([last]);
    expect(s.busy()).toBe(false);
  });
  it('a late reply after cancel is dropped', async () => {
    vi.useFakeTimers();
    const answers: ((c: CountryChoices) => void)[] = [];
    const send = vi.fn((_p: unknown) => new Promise<CountryChoices>((r) => { answers.push(r); }));
    const saved: CountryChoices[] = [];
    const s = createCountrySaver(send, (c) => saved.push(c), () => {});
    s.save({ codes: ['A'] });
    s.flush();
    s.cancel();
    answers[0]!(choices());
    await Promise.resolve();
    await Promise.resolve();
    expect(saved).toEqual([]);
    expect(s.busy()).toBe(false);
  });
  it('cancel drops a pending write; a failure calls onError', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => Promise.reject(new Error('x')));
    const onError = vi.fn();
    const s = createCountrySaver(send, () => {}, onError);
    s.save({ codes: ['SE'] });
    s.cancel();
    vi.advanceTimersByTime(500);
    expect(send).not.toHaveBeenCalled();
    s.save({ codes: ['SE'] });
    s.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('loadApplies', () => {
  it('only the newest load applies, and never while a save is pending or in flight', () => {
    expect(loadApplies(2, 2, false)).toBe(true);
    expect(loadApplies(1, 2, false)).toBe(false);
    expect(loadApplies(2, 2, true)).toBe(false);
  });
});

describe('first run', () => {
  it('goes to countries only with two or more choices', () => {
    expect(firstRunTarget(undefined)).toBe('home');
    expect(firstRunTarget(choices({ choices: [{ key: 'SE', label: 'Sweden', isLanguage: false, live: 4 }] }))).toBe('home');
    expect(firstRunTarget(choices())).toBe('countries');
  });
  it('preselects this TV\'s country when nothing is picked yet; focus on Done then', () => {
    expect(preselect(choices({ deviceCountry: 'SE' }))).toEqual(['SE']);
    expect(preselect(choices({ deviceCountry: 'SE', regions: { codes: ['BE'], mode: 'first' } }))).toBeUndefined();
    expect(preselect(choices())).toBeUndefined();
    expect(firstRunFocus(['SE'])).toBe('done');
    expect(firstRunFocus([])).toBe('grid');
  });
  it('languages: the picks\' languages in order, then the TV language, deduplicated, known ones only, at most 5', () => {
    expect(firstRunLanguages(['SE', 'BE', 'lang:en'], 'sv-SE', countryLanguages, ALLOWED)).toEqual(['sv', 'nl', 'fr', 'en']);
    expect(firstRunLanguages(['IS'], 'en-GB', countryLanguages, ALLOWED)).toEqual(['en']);
    expect(firstRunLanguages(['SE', 'DK', 'NO', 'FI', 'DE', 'FR'], 'en-GB', countryLanguages, ALLOWED)).toEqual(['sv', 'da', 'no', 'fi', 'de']);
    expect(firstRunLanguages([], undefined, countryLanguages, ALLOWED)).toEqual([]);
    const name = (c: string) => ({ sv: 'Swedish' } as Record<string, string>)[c];
    expect(languageLine(['sv', 'en'], name)).toBe('Audio and subtitles: Swedish first');
    expect(languageLine([], name)).toBeUndefined();
  });
});
