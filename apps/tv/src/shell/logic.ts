/** Pure helpers for the shell widgets (unit-tested; the .tsx components stay thin). */

import { FULL_LAYOUT } from '../components/keyboardLogic.ts';
import { router, type ScreenId } from './router.ts';
import { LAYOUT } from './theme.ts';

const pad = (n: number) => String(n).padStart(2, '0');

/** Local time as 24 h `HH:MM`. */
export function formatClock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Milliseconds until the next minute boundary (a full minute when exactly on one). */
export function msToNextMinute(d: Date): number {
  return 60_000 - (d.getSeconds() * 1000 + d.getMilliseconds());
}

/**
 * Detects `count` taps within `windowMs` (e.g. Info, Info, Info within 2 s). Call with each tap's timestamp;
 * returns true on the tap that completes the sequence, then starts over.
 */
export function createTapSequence(count: number, windowMs: number): (at: number) => boolean {
  let taps: number[] = [];
  return (at) => {
    taps = [...taps.filter((t) => at - t < windowMs), at];
    if (taps.length >= count) {
      taps = [];
      return true;
    }
    return false;
  };
}

/** A toast message and its precedence (higher wins while it is visible). */
export interface ToastItem { text: string; priority: number }
/** What the toast area shows now, plus at most one lower-priority toast waiting for it to expire. */
export interface ToastState { current?: ToastItem; pending?: ToastItem }

/**
 * A new toast replaces the visible one unless the visible one has higher priority; then the new one waits
 * (only the newest waiting toast is kept) and is shown when the visible one expires.
 */
export function toastOnShow(s: ToastState, t: ToastItem): ToastState {
  if (s.current && s.current.priority > t.priority) return { current: s.current, pending: t };
  return s.pending ? { current: t, pending: s.pending } : { current: t };
}

/** The visible toast's time is up: show the waiting one, if any. */
export function toastOnExpiry(s: ToastState): ToastState {
  return s.pending ? { current: s.pending } : {};
}

/** Router overlay ids owned by the shell itself (not by a screen). */
export const TOAST_OVERLAY_ID = 'toast';
export const EXIT_OVERLAY_ID = 'exitConfirm';

/**
 * True while an overlay other than the shell's toast is on the router's overlay stack (defaults to the app router's):
 * a screen's keyboard, menu, picker or dialog, or the shell's exit question. A screen gates its keys and its focus
 * moves on this, and the shell hides its chrome (wordmark, clock, offline badge) on it. The toast is a Back layer
 * only: it has no focus and covers nothing, so it never counts (it would swallow Ok and the arrows for 4 s).
 */
export function screenOverlayOpen(overlayIds: readonly string[] = router.overlays()): boolean {
  return overlayIds.some((id) => id !== TOAST_OVERLAY_ID);
}

/** The routes that show fullscreen video: the shell's clock and offline badge stay off them. */
export function fullscreenVideoRoute(route: ScreenId | undefined): boolean {
  return route === 'player' || route === 'vodPlay' || route === 'multiview';
}

/**
 * The brand wordmark shows on every browsing screen (and before any screen exists: loading, init error). It
 * hides in the Player and whenever the video is fullscreen, so it never sits on top of the picture, and while a
 * screen overlay is open, because the shell draws the mark above the screen and so above the screen's overlays.
 */
export function showWordmark(route: ScreenId | undefined, rectIsFullscreen: boolean, overlayOpen: boolean): boolean {
  return !(route && NO_WORDMARK.has(route)) && !rectIsFullscreen && !overlayOpen;
}

/** Screens without the brand wordmark: the redesigned ones (spec §1.4) and the player and multiview. */
const NO_WORDMARK: ReadonlySet<ScreenId> = new Set(['home', 'countries', 'player', 'start', 'vod', 'vodGrid', 'search', 'settings', 'movieDetail', 'seriesDetail', 'multiview']);

/** Screens with the left rail; the rail draws the clock there, so the shell's top-right clock is off. */
export function railRoute(route: ScreenId | undefined): boolean {
  return route === 'home' || route === 'start' || route === 'vod' || route === 'vodGrid' || route === 'search' || route === 'settings';
}

/** The wordmark is drawn at the latest this long after the shell mounts, even if Home has not shown rows yet. */
export const WORDMARK_MAX_WAIT_MS = 2_000;

/**
 * Whether drawing the wordmark (a 2D canvas render and a PNG encode) should still wait, so it never competes with
 * the cold start. It waits while the boot (no screen yet) or Home has not marked the startup metric (first cached
 * rows on screen), up to WORDMARK_MAX_WAIT_MS (`waitedOut`). Screens that never mark startup (Add source on first
 * run, the init error, any other screen) draw it at once. The mark fades in, which hides the delay.
 */
export function deferWordmark(s: {
  route: ScreenId | undefined;
  initFailed: boolean;
  startupMarked: boolean;
  waitedOut: boolean;
}): boolean {
  if (s.startupMarked || s.waitedOut || s.initFailed) return false;
  return s.route === undefined || s.route === 'home';
}

/** The shell's pointer-mode Back button: the first button of the screen's bottom row. */
export const SHELL_BACK_LABEL = '← Back';
export const SHELL_BACK_W = 200;

/**
 * Pointer mode: the bottom row of buttons that replaces a screen's hint line (Home's size). Its bottom edge is the
 * overscan-safe line.
 */
export const BOTTOM_ROW_H = 48;
export const BOTTOM_ROW_Y = LAYOUT.height - LAYOUT.safeY - BOTTOM_ROW_H;

/**
 * The shell Back's x: the row start, except on Search and Settings. Search's full keyboard reaches down to just above
 * the row, so Back goes at the start of its results column (keyboard x + width + two gaps), on the same row. Settings
 * has the rail, so Back starts at the content edge (x 160), clear of it.
 */
export function shellBackX(route: ScreenId | undefined): number {
  if (route === 'search') return LAYOUT.contentX + FULL_LAYOUT.width + LAYOUT.gap * 2;
  return route === 'settings' ? LAYOUT.contentX : LAYOUT.safeX;
}
/** Where a screen's own bottom-row buttons start: after the shell's Back, one bar gap apart. */
export const SCREEN_ROW_X = LAYOUT.safeX + SHELL_BACK_W + LAYOUT.gap / 2;

/**
 * Every screen except Home (Back there is the exit question), the Player (its overlay has its own Back), VodPlay
 * (its action bar starts with Back in pointer mode; the pill would cover Pause), multiview (its own Back) and the
 * first-run countries step (its own Skip).
 */
export function shellBackShown(route: ScreenId | undefined): boolean {
  return route !== undefined && route !== 'home' && route !== 'player' && route !== 'vodPlay' && route !== 'multiview'
    && route !== 'countries';
}

/** Debug HUD: the longest gap between consecutive animation-frame times (ms), i.e. the worst frame in the window. */
export function slowestFrameMs(times: readonly number[]): number {
  let worst = 0;
  for (let i = 1; i < times.length; i++) worst = Math.max(worst, (times[i] ?? 0) - (times[i - 1] ?? 0));
  return worst;
}
