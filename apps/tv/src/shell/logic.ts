/** Pure helpers for the shell widgets (unit-tested; the .tsx components stay thin). */

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
