import { clock } from './vodPlayerLogic.ts';

export const SEEK_STEP_MS = 10_000;

/** Step for a press while the key has been held `heldMs`. */
export function seekStep(heldMs: number): number {
  if (heldMs >= 6000) return 120_000;
  if (heldMs >= 3000) return 60_000;
  if (heldMs >= 1000) return 30_000;
  return SEEK_STEP_MS;
}

/** What moved the scrub last: Left/Right on the timeline, the ±10 buttons, or a pointer drag. */
export type ScrubSource = 'keys' | 'skip' | 'drag';

/** A pending seek: where it will land, where it started (for the jump label), and what moved it last. */
export interface Scrub {
  targetMs: number;
  fromMs: number;
  source: ScrubSource;
}

/** A target clamped to [0, duration - 1000] (the supervisor's own clamp). */
const clampTarget = (ms: number, durationMs: number) => Math.max(0, Math.min(Math.max(0, durationMs - 1000), ms));

/** A press (Left/Right or ±10): moves the target from the running scrub, else from the current position. */
export function pressScrub(
  s: Scrub | undefined,
  positionMs: number,
  durationMs: number,
  dir: 1 | -1,
  stepMs: number,
  source: 'keys' | 'skip',
): Scrub {
  const from = s?.targetMs ?? positionMs;
  return { targetMs: clampTarget(from + dir * stepMs, durationMs), fromMs: s?.fromMs ?? positionMs, source };
}

/** A pointer drag at `fraction` (0..1, clamped) of the timeline. */
export function dragScrub(s: Scrub | undefined, positionMs: number, durationMs: number, fraction: number): Scrub {
  const f = Math.max(0, Math.min(1, fraction));
  return { targetMs: clampTarget(f * durationMs, durationMs), fromMs: s?.fromMs ?? positionMs, source: 'drag' };
}

/**
 * How long a scrub waits after its last move before it commits by itself: key scrubs give time to look (OK commits at
 * once), repeated ±10 presses add up briefly, and a drag commits on release (undefined: no timer).
 */
export function commitDelayMs(source: ScrubSource): number | undefined {
  if (source === 'keys') return 2000;
  if (source === 'skip') return 700;
  return undefined;
}

/** "+2:30" / "−0:10" (a real minus sign). */
export function jumpLabel(deltaMs: number): string {
  return `${deltaMs < 0 ? '−' : '+'}${clock(Math.abs(deltaMs))}`;
}

/** A remote repeats a held key at least this often (the first repeat comes after ~500 ms). */
export const HOLD_GAP_MS = 600;

export interface HoldRun {
  key: string;
  since: number;
  lastAt: number;
}

/**
 * A Left/Right press: continues the hold run while the same key repeats (no release, no gap over `HOLD_GAP_MS`),
 * otherwise starts a new one. `heldMs` feeds `seekStep`. The screen drops the run on the key's release.
 */
export function holdPress(run: HoldRun | undefined, key: string, now: number): { run: HoldRun; heldMs: number } {
  const since = run && run.key === key && now - run.lastAt <= HOLD_GAP_MS ? run.since : now;
  return { run: { key, since, lastAt: now }, heldMs: now - since };
}
