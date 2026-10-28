import type { SourceCooldown } from '@iptv/app-api';
import { COOLDOWN_COPY } from '../copy/failure.ts';

/** The cooldown's main line. Core's SOURCE_REFUSING/UNREACHABLE messages are diagnostics now; the UI says this. */
export const COOLDOWN_TEXT = COOLDOWN_COPY.refused;
export const UNREACHABLE_TEXT = COOLDOWN_COPY.unreachable;

/**
 * What Home's preview box and the Player show while the current stream (its host or source) cools down, or undefined when
 * clear. The text says why: a refusal, or a source that stopped answering.
 */
export function cooldownCopy(c: SourceCooldown, now: number): { text: string; hint: string } | undefined {
  if (c.state === 'clear') return undefined;
  const text = c.reason === 'unreachable' ? UNREACHABLE_TEXT : COOLDOWN_TEXT;
  return { text, hint: tryingAgainIn(c, now) };
}

/** "Trying again in N min" (at least 1) for a cooldown that waits. */
export function tryingAgainIn(c: { until: number }, now: number): string {
  return COOLDOWN_COPY.tryingAgainIn(Math.max(1, Math.ceil((c.until - now) / 60_000)));
}

/**
 * The screens' clock ticks every 30 s; the countdown needs the time of this render. Pass the tick (read for its
 * reactivity) and get the current time.
 */
export function freshNow(_tick: number): number {
  return Date.now();
}
