import { describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS, SUBTITLE_LANGUAGES, sanitizeSettings } from '../src/settings.ts';

describe('sanitizeSettings', () => {
  test('non-objects give defaults', () => {
    for (const v of [undefined, null, 5, 'x', []]) expect(sanitizeSettings(v)).toEqual(DEFAULT_SETTINGS);
  });

  test('defaults are as specified', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      epgOffsetHours: 0, preferredFormat: 'ts', autoRefreshHours: 12, sleepTimerMinutes: 0, showClock: true,
      liveDelay: 'balanced', subtitleLanguage: 'off', subtitleExactMatch: false,
    });
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
});
