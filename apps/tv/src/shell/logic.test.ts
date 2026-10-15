import { describe, expect, it, vi } from 'vitest';
import {
  createTapSequence, deferWordmark, EXIT_OVERLAY_ID, formatClock, msToNextMinute, screenOverlayOpen, showWordmark, TOAST_OVERLAY_ID, toastOnExpiry,
  BOTTOM_ROW_H, BOTTOM_ROW_Y, SCREEN_ROW_X, SHELL_BACK_LABEL, SHELL_BACK_W, shellBackShown, toastOnShow,
} from './logic.ts';
import { LAYOUT } from './theme.ts';
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

describe('showWordmark', () => {
  it('shows on every browsing screen while the video is not fullscreen', () => {
    for (const route of ['home', 'guide', 'search', 'settings', 'addSource'] as const) {
      expect(showWordmark(route, false, false)).toBe(true);
    }
  });

  it('shows before any screen is open (loading, init error)', () => {
    expect(showWordmark(undefined, false, false)).toBe(true);
  });

  it('hides in the Player', () => {
    expect(showWordmark('player', false, false)).toBe(false);
    expect(showWordmark('player', true, false)).toBe(false);
  });

  it('hides whenever the video rect is fullscreen, whatever the screen', () => {
    expect(showWordmark('home', true, false)).toBe(false);
    expect(showWordmark('search', true, false)).toBe(false);
    expect(showWordmark(undefined, true, false)).toBe(false);
  });

  it('hides while an in-screen overlay (keyboard, menu, picker, dialog) is open', () => {
    expect(showWordmark('addSource', false, true)).toBe(false);
    expect(showWordmark('home', false, true)).toBe(false);
  });
});

describe('screenOverlayOpen', () => {
  it("counts the screens' own overlays from the router stack, not the shell's toast or exit question", () => {
    expect(screenOverlayOpen([])).toBe(false);
    expect(screenOverlayOpen([TOAST_OVERLAY_ID])).toBe(false);
    expect(screenOverlayOpen([EXIT_OVERLAY_ID, TOAST_OVERLAY_ID])).toBe(false);
    expect(screenOverlayOpen(['keyboard'])).toBe(true);
    expect(screenOverlayOpen([TOAST_OVERLAY_ID, 'menu'])).toBe(true);
  });
});

describe('deferWordmark', () => {
  const base = { route: undefined, initFailed: false, startupMarked: false, waitedOut: false } as const;

  it('waits while Home (or the boot before it) has not painted its first rows', () => {
    expect(deferWordmark(base)).toBe(true);
    expect(deferWordmark({ ...base, route: 'home' })).toBe(true);
  });

  it('draws once the startup metric is marked', () => {
    expect(deferWordmark({ ...base, route: 'home', startupMarked: true })).toBe(false);
  });

  it('draws at once on screens that never mark startup (first run, init error)', () => {
    expect(deferWordmark({ ...base, route: 'addSource' })).toBe(false);
    expect(deferWordmark({ ...base, initFailed: true })).toBe(false);
    expect(deferWordmark({ ...base, route: 'settings' })).toBe(false);
  });

  it('draws after the safety wait even if Home never shows rows', () => {
    expect(deferWordmark({ ...base, route: 'home', waitedOut: true })).toBe(false);
  });
});

describe('shell Back button (pointer mode)', () => {
  it('shows on every screen except Home (Back there is the exit question) and the Player (it has its own)', () => {
    expect(shellBackShown('addSource')).toBe(true);
    expect(shellBackShown('guide')).toBe(true);
    expect(shellBackShown('search')).toBe(true);
    expect(shellBackShown('settings')).toBe(true);
    expect(shellBackShown('home')).toBe(false);
    expect(shellBackShown('player')).toBe(false);
    expect(shellBackShown(undefined)).toBe(false);
  });

  it('uses the spec copy', () => {
    expect(SHELL_BACK_LABEL).toBe('← Back');
  });

  it("sits at the start of the bottom row, inside the safe area, with Home's button size", () => {
    expect([BOTTOM_ROW_Y, BOTTOM_ROW_H, SHELL_BACK_W]).toEqual([978, 48, 200]);
    expect(BOTTOM_ROW_Y + BOTTOM_ROW_H).toBe(LAYOUT.height - LAYOUT.safeY);
  });

  it("leaves room for it: a screen's own bottom-row buttons start one gap after it", () => {
    expect(SCREEN_ROW_X).toBe(LAYOUT.safeX + SHELL_BACK_W + LAYOUT.gap / 2);
    expect(SCREEN_ROW_X).toBe(308);
  });
});
