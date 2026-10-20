import { describe, expect, test } from 'vitest';
import {
  DEFAULT_SETTINGS, FOLLOWED_TEAMS_MAX, HIDDEN_COMPETITIONS_MAX, MATCH_CATEGORIES_MAX, PINNED_COMPETITIONS_MAX, REGIONS_MAX, SUBTITLE_LANGUAGES, sanitizeSettings,
} from '../src/settings.ts';

describe('sanitizeSettings', () => {
  test('non-objects give defaults', () => {
    for (const v of [undefined, null, 5, 'x', []]) expect(sanitizeSettings(v)).toEqual(DEFAULT_SETTINGS);
  });

  test('defaults are as specified', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      epgOffsetHours: 0, preferredFormat: 'ts', autoRefreshHours: 12, sleepTimerMinutes: 0, showClock: true,
      liveDelay: 'balanced', subtitleLanguage: 'off', audioLanguage: 'auto', subtitleExactMatch: false,
      combineDuplicates: true, preferredLanguages: [], openOn: 'lastChannel', followedTeams: [], posterSize: 'standard', combineChannels: false,
      regions: { codes: [], mode: 'off' }, combineCategories: false,
      pinnedCompetitions: [], hiddenCompetitions: [], matchCategories: [],
    });
  });

  test('openOn keeps known values and falls back to lastChannel', () => {
    for (const v of ['lastChannel', 'start'] as const) expect(sanitizeSettings({ openOn: v }).openOn).toBe(v);
    for (const v of ['home', 1, null, undefined]) expect(sanitizeSettings({ openOn: v }).openOn).toBe('lastChannel');
  });

  test('motion keeps known levels; anything else stays unset (follow the system)', () => {
    for (const v of ['full', 'reduced', 'off'] as const) expect(sanitizeSettings({ motion: v }).motion).toBe(v);
    for (const v of ['fast', 1, null, undefined]) expect('motion' in sanitizeSettings({ motion: v })).toBe(false);
  });

  test('posterSize keeps known values and falls back to standard', () => {
    for (const v of ['standard', 'compact'] as const) expect(sanitizeSettings({ posterSize: v }).posterSize).toBe(v);
    for (const v of ['big', 1, null, undefined]) expect(sanitizeSettings({ posterSize: v }).posterSize).toBe('standard');
  });

  test('followedTeams: strings only, trimmed, 1-40 chars, deduped ignoring case and accents, at most 50', () => {
    expect(sanitizeSettings({ followedTeams: ['  Northbridge FC ', 'northbridge fc', 'Éastport', 'Eastport', '', 3, null] }).followedTeams)
      .toEqual(['Northbridge FC', 'Éastport']);
    expect(sanitizeSettings({ followedTeams: ['x'.repeat(60)] }).followedTeams).toEqual(['x'.repeat(40)]);
    const many = Array.from({ length: 80 }, (_, i) => `Team ${i}`);
    expect(sanitizeSettings({ followedTeams: many }).followedTeams).toHaveLength(FOLLOWED_TEAMS_MAX);
    for (const v of ['x', 5, null, undefined, {}]) expect(sanitizeSettings({ followedTeams: v }).followedTeams).toEqual([]);
  });

  test('pinned and hidden competitions, match categories: folded, trimmed, 1-40 chars, deduped, capped', () => {
    expect(sanitizeSettings({ pinnedCompetitions: ['  Northern   Cüp ', 'northern cup', '', 3, null, 'Test Cup'] }).pinnedCompetitions)
      .toEqual(['northern cup', 'test cup']);
    expect(sanitizeSettings({ hiddenCompetitions: ['x'.repeat(60)] }).hiddenCompetitions).toEqual(['x'.repeat(40)]);
    const many = Array.from({ length: 80 }, (_, i) => `Cup ${i}`);
    expect(sanitizeSettings({ pinnedCompetitions: many }).pinnedCompetitions).toHaveLength(PINNED_COMPETITIONS_MAX);
    expect(sanitizeSettings({ hiddenCompetitions: many }).hiddenCompetitions).toHaveLength(HIDDEN_COMPETITIONS_MAX);
    expect(sanitizeSettings({ matchCategories: many }).matchCategories).toHaveLength(MATCH_CATEGORIES_MAX);
    expect(sanitizeSettings({ matchCategories: ['Fotboll'] }).matchCategories).toEqual(['fotboll']);
    for (const v of ['x', 5, null, undefined, {}]) expect(sanitizeSettings({ pinnedCompetitions: v }).pinnedCompetitions).toEqual([]);
  });

  test('audioLanguage keeps a listed language code or auto, else auto (never off)', () => {
    for (const v of ['en', 'sv', 'ar', 'auto']) expect(sanitizeSettings({ audioLanguage: v }).audioLanguage).toBe(v);
    for (const v of ['off', 'english', 'xx', 3, null, undefined]) expect(sanitizeSettings({ audioLanguage: v }).audioLanguage).toBe('auto');
  });

  test('subtitleLanguage keeps a listed language code, else off', () => {
    expect(SUBTITLE_LANGUAGES[0]).toBe('off');
    for (const v of ['en', 'sv', 'ar']) expect(sanitizeSettings({ subtitleLanguage: v }).subtitleLanguage).toBe(v);
    for (const v of ['english', 'xx', 3, null, undefined]) expect(sanitizeSettings({ subtitleLanguage: v }).subtitleLanguage).toBe('off');
  });

  test('subtitleExactMatch is a boolean, off by default (it reads a little of the video from the provider)', () => {
    expect(sanitizeSettings({ subtitleExactMatch: true }).subtitleExactMatch).toBe(true);
    for (const v of ['yes', 1, null, undefined]) expect(sanitizeSettings({ subtitleExactMatch: v }).subtitleExactMatch).toBe(false);
  });

  test('combineChannels is a boolean, off by default until the TV UI for sources lands', () => {
    expect(sanitizeSettings({ combineChannels: true }).combineChannels).toBe(true);
    expect(sanitizeSettings({ combineChannels: false }).combineChannels).toBe(false);
    for (const v of ['yes', 1, null, undefined]) expect(sanitizeSettings({ combineChannels: v }).combineChannels).toBe(false);
    expect(sanitizeSettings({}).combineChannels).toBe(false);
  });

  test('combineDuplicates is a boolean, on by default', () => {
    expect(sanitizeSettings({ combineDuplicates: false }).combineDuplicates).toBe(false);
    for (const v of ['no', 0, null, undefined]) expect(sanitizeSettings({ combineDuplicates: v }).combineDuplicates).toBe(true);
  });

  test('preferredLanguages keeps listed codes in order, deduped, at most 5', () => {
    expect(sanitizeSettings({ preferredLanguages: ['sv', 'en'] }).preferredLanguages).toEqual(['sv', 'en']);
    expect(sanitizeSettings({ preferredLanguages: ['sv', 'off', 'xx', 3, 'sv', 'en'] }).preferredLanguages).toEqual(['sv', 'en']);
    expect(sanitizeSettings({ preferredLanguages: ['en', 'sv', 'da', 'no', 'fi', 'de'] }).preferredLanguages).toHaveLength(5);
    for (const v of ['sv', null, undefined, {}]) expect(sanitizeSettings({ preferredLanguages: v }).preferredLanguages).toEqual([]);
  });

  test('liveDelay keeps known values and falls back to balanced', () => {
    for (const v of ['low', 'balanced', 'stable'] as const) expect(sanitizeSettings({ liveDelay: v }).liveDelay).toBe(v);
    for (const v of ['fast', 3, null, undefined]) expect(sanitizeSettings({ liveDelay: v }).liveDelay).toBe('balanced');
  });

  test('epgOffsetHours clamps to [-12, 12] in 0.5 steps', () => {
    expect(sanitizeSettings({ epgOffsetHours: 99 }).epgOffsetHours).toBe(12);
    expect(sanitizeSettings({ epgOffsetHours: -99 }).epgOffsetHours).toBe(-12);
    expect(sanitizeSettings({ epgOffsetHours: 1.3 }).epgOffsetHours).toBe(1.5);
    expect(sanitizeSettings({ epgOffsetHours: -2.2 }).epgOffsetHours).toBe(-2);
    expect(sanitizeSettings({ epgOffsetHours: Number.NaN }).epgOffsetHours).toBe(0);
    expect(sanitizeSettings({ epgOffsetHours: '3' }).epgOffsetHours).toBe(0);
  });

  test('autoRefreshHours and sleepTimerMinutes accept only exact allowed values', () => {
    expect(sanitizeSettings({ autoRefreshHours: 0 }).autoRefreshHours).toBe(0);
    expect(sanitizeSettings({ autoRefreshHours: 6 }).autoRefreshHours).toBe(6);
    expect(sanitizeSettings({ autoRefreshHours: 7 }).autoRefreshHours).toBe(12);
    expect(sanitizeSettings({ autoRefreshHours: 100 }).autoRefreshHours).toBe(12);
    expect(sanitizeSettings({ autoRefreshHours: -4 }).autoRefreshHours).toBe(12);
    expect(sanitizeSettings({ autoRefreshHours: 'x' }).autoRefreshHours).toBe(12);
    expect(sanitizeSettings({ sleepTimerMinutes: 40 }).sleepTimerMinutes).toBe(0);
    expect(sanitizeSettings({ sleepTimerMinutes: 500 }).sleepTimerMinutes).toBe(0);
    expect(sanitizeSettings({ sleepTimerMinutes: Number.NaN }).sleepTimerMinutes).toBe(0);
    expect(sanitizeSettings({ sleepTimerMinutes: 90 }).sleepTimerMinutes).toBe(90);
  });

  test('negative zero is normalised to 0', () => {
    expect(Object.is(sanitizeSettings({ epgOffsetHours: -0 }).epgOffsetHours, 0)).toBe(true);
    expect(Object.is(sanitizeSettings({ epgOffsetHours: -0.1 }).epgOffsetHours, 0)).toBe(true);
    expect(Object.is(sanitizeSettings({ autoRefreshHours: -0 }).autoRefreshHours, 0)).toBe(true);
    expect(Object.is(sanitizeSettings({ sleepTimerMinutes: -0 }).sleepTimerMinutes, 0)).toBe(true);
  });

  test('format and clock fall back; unknown keys are dropped', () => {
    expect(sanitizeSettings({ preferredFormat: 'm3u8', showClock: false })).toMatchObject({ preferredFormat: 'm3u8', showClock: false });
    expect(sanitizeSettings({ preferredFormat: 'mp4', showClock: 'no' })).toMatchObject({ preferredFormat: 'ts', showClock: true });
    expect(Object.keys(sanitizeSettings({ extra: 1, epgOffsetHours: 1 })).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  test('regions: codes normalised (UK → GB), lang keys kept, deduped, at most 10; mode off|first|only', () => {
    expect(sanitizeSettings({ regions: { codes: ['se', 'UK', 'GB', 'lang:en', 'lang:EN', 'XX', 'lang:', 3], mode: 'first' } }).regions)
      .toEqual({ codes: ['SE', 'GB', 'lang:en'], mode: 'first' });
    const many = ['SE', 'NO', 'DK', 'FI', 'IS', 'DE', 'AT', 'CH', 'FR', 'BE', 'NL', 'LU'];
    expect(sanitizeSettings({ regions: { codes: many, mode: 'only' } }).regions.codes).toHaveLength(REGIONS_MAX);
    expect(sanitizeSettings({ regions: { codes: ['SE'], mode: 'bogus' } }).regions).toEqual({ codes: ['SE'], mode: 'off' });
    for (const v of [null, 'SE', [], { codes: 'SE' }]) expect(sanitizeSettings({ regions: v }).regions).toEqual({ codes: [], mode: 'off' });
  });

  test('combineCategories is a boolean, off by default', () => {
    expect(sanitizeSettings({ combineCategories: true }).combineCategories).toBe(true);
    expect(sanitizeSettings({ combineCategories: 'yes' }).combineCategories).toBe(false);
  });
});
