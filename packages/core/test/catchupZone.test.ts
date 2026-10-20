import { describe, expect, test } from 'vitest';
import { formatOffset, intlZonesWork, pickZone, serverOffsetFrom, wallClock, zoneLabel, type CatchupZone } from '../src/catchup/zone.ts';

const STHLM: CatchupZone = { kind: 'iana', name: 'Europe/Stockholm' };
const hm = (ms: number, z: CatchupZone) => {
  const w = wallClock(ms, z);
  return `${w.Y}-${w.m}-${w.d} ${w.H}:${w.M}:${w.S}`;
};

describe('wallClock', () => {
  test('IANA across the DST end on 2026-10-25 (Europe/Stockholm)', () => {
    // 00:30 UTC is 02:30 CEST, 01:30 UTC is 02:30 CET (the repeated hour), 02:00 UTC is 03:00 CET.
    expect(hm(Date.UTC(2026, 9, 25, 0, 30), STHLM)).toBe('2026-10-25 2:30:0');
    expect(hm(Date.UTC(2026, 9, 25, 1, 30), STHLM)).toBe('2026-10-25 2:30:0');
    expect(hm(Date.UTC(2026, 9, 25, 2, 0), STHLM)).toBe('2026-10-25 3:0:0');
  });

  test('fixed offsets, negative and quarter hours, across a day boundary', () => {
    expect(hm(Date.UTC(2026, 9, 20, 23, 30, 15), { kind: 'fixed', offsetMin: 60 })).toBe('2026-10-21 0:30:15');
    expect(hm(Date.UTC(2026, 0, 1, 2, 0), { kind: 'fixed', offsetMin: -180 })).toBe('2025-12-31 23:0:0');
    expect(hm(Date.UTC(2026, 0, 1, 0, 0), { kind: 'fixed', offsetMin: 345 })).toBe('2026-1-1 5:45:0');
    expect(hm(Date.UTC(2026, 0, 1, 0, 0), { kind: 'fixed', offsetMin: 0 })).toBe('2026-1-1 0:0:0');
  });

  test('an unknown IANA name falls back to UTC rather than throwing', () => {
    expect(hm(Date.UTC(2026, 0, 1, 12, 0), { kind: 'iana', name: 'Not/AZone' })).toBe('2026-1-1 12:0:0');
  });
});

describe('pickZone (spec §4 order)', () => {
  const server = { serverTimeZone: 'Europe/Stockholm', serverOffsetMin: 120 };
  test('the user correction wins over everything', () => {
    expect(pickZone({ ...server, userOffsetMin: -60, playlistCorrMin: 30 })).toEqual({ zone: { kind: 'fixed', offsetMin: -60 }, how: 'manual' });
  });
  test('then the playlist correction', () => {
    expect(pickZone({ ...server, playlistCorrMin: 30 })).toEqual({ zone: { kind: 'fixed', offsetMin: 30 }, how: 'playlist' });
  });
  test('then the server zone when Intl can format it', () => {
    expect(pickZone(server)).toEqual({ zone: STHLM, how: 'iana' });
  });
  test('the feature-check failure falls back to the fixed server offset, then UTC', () => {
    expect(pickZone({ ...server, zonesWork: false })).toEqual({ zone: { kind: 'fixed', offsetMin: 120 }, how: 'fixed' });
    expect(pickZone({ serverTimeZone: 'Europe/Stockholm', zonesWork: false })).toEqual({ zone: { kind: 'fixed', offsetMin: 0 }, how: 'utc' });
    expect(pickZone({ serverTimeZone: 'Not/AZone', serverOffsetMin: 60 })).toEqual({ zone: { kind: 'fixed', offsetMin: 60 }, how: 'fixed' });
    expect(pickZone({})).toEqual({ zone: { kind: 'fixed', offsetMin: 0 }, how: 'utc' });
  });
  test('the feature check passes on Node (full ICU)', () => {
    expect(intlZonesWork()).toBe(true);
  });
});

test('labels for Diagnostics', () => {
  expect(formatOffset(60)).toBe('+1:00');
  expect(formatOffset(-210)).toBe('-3:30');
  expect(formatOffset(0)).toBe('+0:00');
  expect(zoneLabel({ zone: STHLM, how: 'iana' })).toBe('Europe/Stockholm');
  expect(zoneLabel({ zone: { kind: 'fixed', offsetMin: 60 }, how: 'fixed' })).toBe('UTC+1:00 (fixed offset)');
  expect(zoneLabel({ zone: { kind: 'fixed', offsetMin: 0 }, how: 'utc' })).toBe('UTC');
  expect(zoneLabel({ zone: { kind: 'fixed', offsetMin: 60 }, how: 'manual' })).toBe('manual +1:00');
  expect(zoneLabel({ zone: { kind: 'fixed', offsetMin: -60 }, how: 'playlist' })).toBe('playlist -1:00');
});

test('server offset from time_now and timestamp_now, rounded to 15 min', () => {
  const ts = Date.UTC(2026, 9, 20, 18, 10) / 1000;
  expect(serverOffsetFrom('2026-10-20 20:10:00', ts)).toBe(120);
  expect(serverOffsetFrom('2026-10-20 20:11:41', String(ts))).toBe(120);
  expect(serverOffsetFrom('2026-10-20 13:40:00', ts)).toBe(-270);
  expect(serverOffsetFrom('2026-10-20 18:10', ts)).toBe(0);
  expect(serverOffsetFrom(undefined, ts)).toBeUndefined();
  expect(serverOffsetFrom('soon', ts)).toBeUndefined();
  expect(serverOffsetFrom('2026-10-20 20:10:00', 'x')).toBeUndefined();
  expect(serverOffsetFrom('2026-10-25 20:10:00', ts)).toBeUndefined(); // a clock days off is no zone
});
