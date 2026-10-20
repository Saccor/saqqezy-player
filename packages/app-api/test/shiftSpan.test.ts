import { describe, expect, test } from 'vitest';
import type { Channel } from '@iptv/core';
import { maxShiftMs, shiftSpan } from '../src/shiftSpan.ts';

const HOUR = 3600_000;
const ch = (n: number, epgShift?: number): Channel => {
  const c: Channel = { id: `s:${n}`, sourceId: 's', name: `C${n}`, url: `http://example.test/${n}.ts`, group: 'G', number: n };
  if (epgShift !== undefined) c.epgShift = epgShift;
  return c;
};
/** The per-keystroke scan this replaces. */
const brute = (channels: Channel[], offset: number) => {
  let m = Math.abs(offset) * HOUR;
  for (const c of channels) m = Math.max(m, Math.abs((offset + (c.epgShift ?? 0)) * HOUR));
  return m;
};

describe('shiftSpan / maxShiftMs', () => {
  test('no channels, or none shifted: the global offset alone', () => {
    expect(maxShiftMs(shiftSpan([]), 0)).toBe(0);
    expect(maxShiftMs(shiftSpan([]), -3)).toBe(3 * HOUR);
    expect(maxShiftMs(shiftSpan([ch(1), ch(2)]), 2)).toBe(2 * HOUR);
  });
  test('shifts on both sides of the offset', () => {
    const cs = [ch(1, -5), ch(2, 1.5), ch(3)];
    expect(shiftSpan(cs)).toEqual({ min: -5, max: 1.5 });
    expect(maxShiftMs(shiftSpan(cs), 0)).toBe(5 * HOUR);
    expect(maxShiftMs(shiftSpan(cs), 4)).toBe(5.5 * HOUR);
  });
  test('matches the full scan for any offset', () => {
    let r = 7;
    const rnd = () => (r = (r * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let k = 0; k < 200; k++) {
      const cs = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, i) => ch(i, rnd() < 0.3 ? undefined : Math.round((rnd() - 0.5) * 24) / 2));
      const offset = Math.round((rnd() - 0.5) * 24) / 2;
      expect(maxShiftMs(shiftSpan(cs), offset)).toBe(brute(cs, offset));
    }
  });
});
