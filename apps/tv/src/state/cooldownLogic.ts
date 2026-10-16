import type { SourceCooldown } from '@iptv/app-api';

/** Same words as core's `SOURCE_REFUSING_MESSAGE` (core stays out of the main-thread bundle). */
export const COOLDOWN_TEXT = "Your source is refusing connections. The app is waiting so you don't get blocked.";
/** Same words as core's `SOURCE_UNREACHABLE_MESSAGE`: the source stopped answering (spec §2.4). */
export const UNREACHABLE_TEXT = "Your source isn't answering. The app is waiting so it doesn't flood it.";

/**
 * What Home's preview box and the Player show while the current stream (its host or source) cools down, or undefined when
 * clear. The text says why: a refusal, or a source that stopped answering.
 */
export function cooldownCopy(c: SourceCooldown, now: number, pointer: boolean): { text: string; hint: string } | undefined {
  if (c.state === 'clear') return undefined;
  const min = Math.max(1, Math.ceil((c.until - now) / 60_000));
  const text = c.reason === 'unreachable' ? UNREACHABLE_TEXT : COOLDOWN_TEXT;
  return { text, hint: `Trying again in ${min} min · ${pointer ? 'Click to retry now' : 'OK: Retry now'}` };
}

/**
 * The screens' clock ticks every 30 s; the countdown needs the time of this render. Pass the tick (read for its
 * reactivity) and get the current time.
 */
export function freshNow(_tick: number): number {
  return Date.now();
}
