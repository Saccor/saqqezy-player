/**
 * Held-key gate for TVs: a remote repeats keydown while a key is held, and a TV CPU can take longer per focus step than
 * the repeat interval. The repeats then queue up and are handled back to back, so focus keeps moving after the key is
 * released. The gate lets a repeat through only when `gapMs` has passed since the last step it let through; the first
 * press of a key always passes. Remotes do not always set `repeat`, so a repeat is a second keydown of the same key with
 * no keyup in between.
 */
export interface RepeatGate {
  /** A keydown of `key` (a navigation key): true when it should move focus. */
  down(key: string, now: number): boolean;
  /** A keyup of `key`, or a blur (no key: every key is released). */
  up(key?: string): void;
}

/** TVs only: their repeat interval is about 100 ms or slower, so this drops only queued bursts, never a normal repeat. */
export const TV_REPEAT_GAP_MS = 80;

export function createRepeatGate(gapMs: number): RepeatGate {
  const held = new Set<string>();
  let lastStep = Number.NEGATIVE_INFINITY;
  return {
    down(key, now) {
      if (held.has(key) && now - lastStep < gapMs) return false;
      held.add(key);
      lastStep = now;
      return true;
    },
    up(key) {
      if (key === undefined) held.clear();
      else held.delete(key);
    },
  };
}
