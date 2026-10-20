import { describe, expect, test } from 'vitest';
import { parseXcLiveUrl, xcDurationMin, xcStart, xcTimeshiftPhpUrl, xcTimeshiftUrl } from '../src/catchup/xc.ts';
import type { CatchupZone } from '../src/catchup/zone.ts';

const STHLM: CatchupZone = { kind: 'iana', name: 'Europe/Stockholm' };
const UTC: CatchupZone = { kind: 'fixed', offsetMin: 0 };
const start = Date.UTC(2026, 9, 20, 18, 0, 40);
const stop = Date.UTC(2026, 9, 20, 18, 30);

describe('parseXcLiveUrl', () => {
  test('long live form, with a path prefix and encoded credentials', () => {
    expect(parseXcLiveUrl('http://h.test:8080/live/al%20ice/p%2Fss/5.ts')).toEqual({ server: 'http://h.test:8080', user: 'al ice', pass: 'p/ss', streamId: '5', ext: 'ts' });
    expect(parseXcLiveUrl('https://h.test/panel/live/u/p/77.m3u8?x=1')).toEqual({ server: 'https://h.test/panel', user: 'u', pass: 'p', streamId: '77', ext: 'm3u8' });
  });
  test('short form, extensionless or not', () => {
    expect(parseXcLiveUrl('http://h.test/u/p/5')).toEqual({ server: 'http://h.test', user: 'u', pass: 'p', streamId: '5', ext: 'ts' });
    expect(parseXcLiveUrl('http://h.test/u/p/5.m3u8')).toEqual({ server: 'http://h.test', user: 'u', pass: 'p', streamId: '5', ext: 'm3u8' });
  });
  test('other shapes are not xc', () => {
    for (const u of ['http://h.test/movie/u/p/5.mkv', 'http://h.test/a/b/c/5', 'http://h.test/live/u/p/x.ts', 'http://h.test/ch1/index.m3u8', 'not a url']) {
      expect(parseXcLiveUrl(u), u).toBeUndefined();
    }
  });
});

describe('timeshift URLs', () => {
  test('start floored to the minute in the panel zone; duration covers the floor', () => {
    expect(xcStart(start, STHLM)).toBe('2026-10-20:20-00');
    expect(xcStart(start, UTC)).toBe('2026-10-20:18-00');
    expect(xcDurationMin(start, stop)).toBe(31);
    expect(xcDurationMin(Date.UTC(2026, 9, 20, 18), Date.UTC(2026, 9, 20, 19))).toBe(61);
  });
  test('primary path form and the php alternate, credentials encoded', () => {
    const p = { server: 'http://h.test', user: 'a b', pass: 'p/s&', streamId: '5', ext: 'ts' as const };
    expect(xcTimeshiftUrl(p, start, stop, STHLM)).toBe('http://h.test/timeshift/a%20b/p%2Fs%26/31/2026-10-20:20-00/5.ts');
    expect(xcTimeshiftPhpUrl(p, start, stop, STHLM))
      .toBe('http://h.test/streaming/timeshift.php?username=a+b&password=p%2Fs%26&stream=5&start=2026-10-20%3A20-00&duration=31');
  });
  test('across the DST end the wall clock follows the zone', () => {
    const p = { server: 'http://h.test', user: 'u', pass: 'p', streamId: '5', ext: 'm3u8' as const };
    expect(xcTimeshiftUrl(p, Date.UTC(2026, 9, 25, 2), Date.UTC(2026, 9, 25, 3), STHLM)).toBe('http://h.test/timeshift/u/p/61/2026-10-25:03-00/5.m3u8');
    expect(xcTimeshiftUrl(p, Date.UTC(2026, 9, 25, 0), Date.UTC(2026, 9, 25, 1), STHLM)).toBe('http://h.test/timeshift/u/p/61/2026-10-25:02-00/5.m3u8');
  });
});
