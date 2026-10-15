import type { SourceCooldown } from '@iptv/app-api';

/** Same words as core's `SOURCE_REFUSING_MESSAGE` (core stays out of the main-thread bundle). */
export const COOLDOWN_TEXT = "Your source is refusing connections. The app is waiting so you don't get blocked.";

/** What Home's preview box and the Player show while the active source is cooling down, or undefined when clear. */
export function cooldownCopy(c: SourceCooldown, now: number, pointer: boolean): { text: string; hint: string } | undefined {
  if (c.state === 'clear') return undefined;
  if (c.state === 'manual') return { text: COOLDOWN_TEXT, hint: pointer ? 'Click to retry' : 'OK: Retry' };
  const min = Math.max(1, Math.ceil((c.until - now) / 60_000));
  return { text: COOLDOWN_TEXT, hint: `Trying again in ${min} min · ${pointer ? 'Click to retry now' : 'OK: Retry now'}` };
}

/**
 * The screens' clock ticks every 30 s; the countdown needs the time of this render. Pass the tick (read for its
 * reactivity) and get the current time.
 */
export function freshNow(_tick: number): number {
  return Date.now();
}
