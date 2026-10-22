/**
 * The app's playback slots (spec 2026-10-20-multiview §7.1). Slot 0 is the single-view stack, unchanged; slots
 * 1..max-1 are multiview tiles, made on first use and freed when multiview ends. Layout changes never move a player
 * between slots: they only change rects and mute flags.
 */
export interface PoolSlot {
  stop(): void;
  dispose?(): void;
}

export interface PlaybackPool<S extends PoolSlot> {
  /** Slots this device may have, slot 0 included (1: no multiview). */
  readonly max: number;
  readonly slot0: S;
  /** Slot `n` (0..max-1); an extra slot is made on first use. Throws RangeError outside that range. */
  slot(n: number): S;
  /** The slots that exist, slot 0 first. */
  slots(): S[];
  /** Stops every slot (leaving the player, `parkLive('stop')`, the sleep timer). */
  stopAll(): void;
  /** Stops and frees slots 1..max-1 (leaving multiview); slot 0 keeps playing. */
  release(): void;
}

export function createPlaybackPool<S extends PoolSlot>(slot0: S, make: (n: number) => S, max = 4): PlaybackPool<S> {
  const extra = new Map<number, S>();
  const ordered = () => [...extra.entries()].sort(([a], [b]) => a - b).map(([, s]) => s);
  return {
    max,
    slot0,
    slot(n) {
      if (!Number.isInteger(n) || n < 0 || n >= max) throw new RangeError(`No playback slot ${n}`);
      if (n === 0) return slot0;
      let s = extra.get(n);
      if (!s) extra.set(n, (s = make(n)));
      return s;
    },
    slots: () => [slot0, ...ordered()],
    stopAll() {
      slot0.stop();
      for (const s of ordered()) s.stop();
    },
    release() {
      for (const s of ordered()) {
        s.stop();
        s.dispose?.();
      }
      extra.clear();
    },
  };
}
