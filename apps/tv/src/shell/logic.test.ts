import { describe, expect, it, vi } from 'vitest';
import { createTapSequence, formatClock, msToNextMinute, toastOnExpiry, toastOnShow } from './logic.ts';
import { exitApp } from './platformExit.ts';

describe('formatClock', () => {
  it('formats HH:MM with leading zeros, 24 h', () => {
    expect(formatClock(new Date(2026, 0, 1, 7, 5))).toBe('07:05');
    expect(formatClock(new Date(2026, 0, 1, 23, 59))).toBe('23:59');
    expect(formatClock(new Date(2026, 0, 1, 0, 0))).toBe('00:00');
  });

  it('msToNextMinute aligns to the next minute boundary', () => {
    expect(msToNextMinute(new Date(2026, 0, 1, 7, 5, 30, 250))).toBe(29_750);
    expect(msToNextMinute(new Date(2026, 0, 1, 7, 5, 0, 0))).toBe(60_000);
  });
});

describe('createTapSequence', () => {
  it('fires on the third tap within the window', () => {
    const seq = createTapSequence(3, 2000);
    expect(seq(0)).toBe(false);
    expect(seq(500)).toBe(false);
    expect(seq(1999)).toBe(true);
  });

  it('does not fire when taps are spread over more than the window', () => {
    const seq = createTapSequence(3, 2000);
    seq(0);
    seq(1500);
    expect(seq(2100)).toBe(false);
    expect(seq(2500)).toBe(true); // 1500, 2100, 2500
  });

  it('resets after firing', () => {
    const seq = createTapSequence(3, 2000);
    seq(0); seq(1); expect(seq(2)).toBe(true);
    expect(seq(3)).toBe(false);
    expect(seq(4)).toBe(false);
    expect(seq(5)).toBe(true);
  });
});

describe('exitApp', () => {
  it('Tizen exits the current application', () => {
    const exit = vi.fn();
    const g = { tizen: { application: { getCurrentApplication: () => ({ exit }) } }, close: vi.fn() };
    exitApp('tizen', g);
    expect(exit).toHaveBeenCalledOnce();
    expect(g.close).not.toHaveBeenCalled();
  });

  it('webOS closes the window', () => {
    const g = { close: vi.fn() };
    exitApp('webos', g);
    expect(g.close).toHaveBeenCalledOnce();
  });

  it('the browser does nothing', () => {
    const g = { close: vi.fn() };
    exitApp('browser', g);
    expect(g.close).not.toHaveBeenCalled();
  });

  it('a missing Tizen API does not throw', () => {
    expect(() => exitApp('tizen', {})).not.toThrow();
  });
});

describe('toast precedence', () => {
  const low = (text: string) => ({ text, priority: 0 });
  const high = (text: string) => ({ text, priority: 1 });

  it('shows a toast when none is visible', () => {
    expect(toastOnShow({}, low('a'))).toEqual({ current: low('a') });
  });

  it('a newer toast of equal or higher priority replaces the visible one', () => {
    expect(toastOnShow({ current: low('a') }, low('b'))).toEqual({ current: low('b') });
    expect(toastOnShow({ current: low('a') }, high('b'))).toEqual({ current: high('b') });
    expect(toastOnShow({ current: high('a') }, high('b'))).toEqual({ current: high('b') });
  });

  it('a lower-priority toast waits until the visible higher one expires', () => {
    const s = toastOnShow({ current: high('playlist') }, low('epg'));
    expect(s).toEqual({ current: high('playlist'), pending: low('epg') });
    expect(toastOnExpiry(s)).toEqual({ current: low('epg') });
  });

  it('keeps only the newest waiting toast and keeps it pending across a higher replacement', () => {
    let s = toastOnShow({ current: high('p1') }, low('e1'));
    s = toastOnShow(s, low('e2'));
    expect(s.pending).toEqual(low('e2'));
    s = toastOnShow(s, high('p2'));
    expect(s).toEqual({ current: high('p2'), pending: low('e2') });
  });

  it('expiry with nothing waiting clears the toast', () => {
    expect(toastOnExpiry({ current: low('a') })).toEqual({});
  });
});
