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
