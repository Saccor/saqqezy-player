import { describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/settings.ts';

describe('sanitizeSettings', () => {
  test('non-objects give defaults', () => {
    for (const v of [undefined, null, 5, 'x', []]) expect(sanitizeSettings(v)).toEqual(DEFAULT_SETTINGS);
  });

  test('defaults are as specified', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      epgOffsetHours: 0, preferredFormat: 'ts', autoRefreshHours: 12, sleepTimerMinutes: 0, showClock: true,
    });
  });

  test('epgOffsetHours clamps to [-12, 12] in 0.5 steps', () => {
    expect(sanitizeSettings({ epgOffsetHours: 99 }).epgOffsetHours).toBe(12);
    expect(sanitizeSettings({ epgOffsetHours: -99 }).epgOffsetHours).toBe(-12);
    expect(sanitizeSettings({ epgOffsetHours: 1.3 }).epgOffsetHours).toBe(1.5);
    expect(sanitizeSettings({ epgOffsetHours: -2.2 }).epgOffsetHours).toBe(-2);
    expect(sanitizeSettings({ epgOffsetHours: Number.NaN }).epgOffsetHours).toBe(0);
    expect(sanitizeSettings({ epgOffsetHours: '3' }).epgOffsetHours).toBe(0);
  });

  test('autoRefreshHours and sleepTimerMinutes snap to allowed values', () => {
    expect(sanitizeSettings({ autoRefreshHours: 0 }).autoRefreshHours).toBe(0);
    expect(sanitizeSettings({ autoRefreshHours: 7 }).autoRefreshHours).toBe(6);
    expect(sanitizeSettings({ autoRefreshHours: 100 }).autoRefreshHours).toBe(24);
    expect(sanitizeSettings({ autoRefreshHours: -4 }).autoRefreshHours).toBe(0);
    expect(sanitizeSettings({ autoRefreshHours: 'x' }).autoRefreshHours).toBe(12);
    expect(sanitizeSettings({ sleepTimerMinutes: 40 }).sleepTimerMinutes).toBe(30);
    expect(sanitizeSettings({ sleepTimerMinutes: 500 }).sleepTimerMinutes).toBe(120);
    expect(sanitizeSettings({ sleepTimerMinutes: 90 }).sleepTimerMinutes).toBe(90);
  });

  test('format and clock fall back; unknown keys are dropped', () => {
    expect(sanitizeSettings({ preferredFormat: 'm3u8', showClock: false })).toMatchObject({ preferredFormat: 'm3u8', showClock: false });
    expect(sanitizeSettings({ preferredFormat: 'mp4', showClock: 'no' })).toMatchObject({ preferredFormat: 'ts', showClock: true });
    expect(Object.keys(sanitizeSettings({ extra: 1, epgOffsetHours: 1 })).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });
});
