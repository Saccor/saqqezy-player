import { describe, expect, test } from 'vitest';
import { parseRetryAfter } from '../src/net/retryAfter.ts';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

describe('parseRetryAfter', () => {
  test('delay-seconds', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120_000);
    expect(parseRetryAfter(' 0 ', NOW)).toBe(0);
  });

  test('an HTTP-date, relative to now', () => {
    expect(parseRetryAfter('Fri, 16 Oct 2026 12:05:00 GMT', NOW)).toBe(5 * 60_000);
  });

  test('the obsolete RFC 850 form', () => {
    expect(parseRetryAfter('Friday, 16-Oct-26 12:05:00 GMT', NOW)).toBe(5 * 60_000);
  });

  test('the asctime form has no zone and is GMT', () => {
    expect(parseRetryAfter('Fri Oct 16 12:05:00 2026', NOW)).toBe(5 * 60_000);
    expect(parseRetryAfter('Tue Oct  6 12:00:00 2026', Date.UTC(2026, 9, 6, 11, 59, 0))).toBe(60_000);
  });

  test('a date in the past is 0', () => {
    expect(parseRetryAfter('Fri, 16 Oct 2026 11:00:00 GMT', NOW)).toBe(0);
  });

  test.each([null, undefined, '', 'soon', '-5', '1.5', '12abc', 'Fri, 99 Foo 2026 GMT'])('%s is ignored', (v) => {
    expect(parseRetryAfter(v, NOW)).toBeUndefined();
  });
});
