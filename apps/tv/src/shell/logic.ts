/** Pure helpers for the shell widgets (unit-tested; the .tsx components stay thin). */

import type { ScreenId } from './router.ts';

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
const SHELL_OVERLAYS: ReadonlySet<string> = new Set([TOAST_OVERLAY_ID, EXIT_OVERLAY_ID]);

/**
 * True while a screen's own overlay (keyboard, menu, picker, dialog) is on the router's overlay stack. The shell's
 * toast and exit question do not count: they never sit under the wordmark.
 */
export function screenOverlayOpen(overlayIds: readonly string[]): boolean {
  return overlayIds.some((id) => !SHELL_OVERLAYS.has(id));
}

/**
 * The brand wordmark shows on every browsing screen (and before any screen exists: loading, init error). It
 * hides in the Player and whenever the video is fullscreen, so it never sits on top of the picture, and while a
 * screen overlay is open, because the shell draws the mark above the screen and so above the screen's overlays.
 */
export function showWordmark(route: ScreenId | undefined, rectIsFullscreen: boolean, overlayOpen: boolean): boolean {
  return route !== 'player' && !rectIsFullscreen && !overlayOpen;
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
