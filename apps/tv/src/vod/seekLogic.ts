export const SEEK_STEP_MS = 10_000;
export const SEEK_COMMIT_MS = 500;

/** Step for a press while the key has been held `heldMs`. */
export function seekStep(heldMs: number): number {
  if (heldMs >= 3000) return 60_000;
  if (heldMs >= 1000) return 30_000;
  return SEEK_STEP_MS;
}

export interface SeekMarker {
  targetMs: number;
  dir: 1 | -1;
}

/** A press: move the marker (from the current position when none) and clamp to [0, duration - 1000]. */
export function pressSeek(
  marker: SeekMarker | undefined,
  positionMs: number,
  durationMs: number,
  dir: 1 | -1,
  stepMs: number,
): SeekMarker {
  const from = marker?.targetMs ?? positionMs;
  const max = Math.max(0, durationMs - 1000);
  return { targetMs: Math.max(0, Math.min(max, from + dir * stepMs)), dir };
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
