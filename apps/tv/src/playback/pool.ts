/**
 * The app's playback slots (spec 2026-10-20-multiview §7.1). Every slot is a full playback stack; slot 0 exists from
 * the start and the others are made on first use. The **primary** slot is the one with sound: outside multiview it is
 * the single-view player, which the app-wide `playback` exports follow. Moving the sound moves the primary, so leaving
 * multiview keeps that window playing with no reconnect. Layout changes never move a stream between slots.
 */
export interface PoolSlot {
  stop(): void;
  dispose?(): void;
}

export interface PlaybackPool<S extends PoolSlot> {
  /** Slots this device may have (1: no multiview). */
  readonly max: number;
  /** Slot `n` (0..max-1), made on first use. Throws RangeError outside that range. */
  slot(n: number): S;
  /** The slots that exist, the primary first, then by index. */
  slots(): S[];
  /** The index of the slot with sound (single view: the one on screen). */
  primary(): number;
  /** Moves the sound and the single-view role to slot `n`, which must exist. */
  setPrimary(n: number): void;
  onPrimary(fn: (n: number, prev: number) => void): () => void;
  /** A slot was made, or `release` freed some. */
  onSlots(fn: () => void): () => void;
  /** Stops every slot (leaving the player, `parkLive('stop')`, the sleep timer). */
  stopAll(): void;
  /** Stops and frees every slot but the primary, which keeps playing (leaving multiview). */
  release(): void;
}

export function createPlaybackPool<S extends PoolSlot>(first: S, make: (n: number) => S, max = 4): PlaybackPool<S> {
  const made = new Map<number, S>([[0, first]]);
  const listeners = new Set<(n: number, prev: number) => void>();
  const slotListeners = new Set<() => void>();
  const changed = () => { for (const fn of [...slotListeners]) fn(); };
  let primary = 0;
  const inRange = (n: number) => {
    if (!Number.isInteger(n) || n < 0 || n >= max) throw new RangeError(`No playback slot ${n}`);
  };
  const others = () => [...made.entries()].filter(([n]) => n !== primary).sort(([a], [b]) => a - b);
  return {
    max,
    slot(n) {
      inRange(n);
      let s = made.get(n);
      if (!s) {
        made.set(n, (s = make(n)));
        changed();
      }
      return s;
    },
    slots: () => [made.get(primary)!, ...others().map(([, s]) => s)],
    primary: () => primary,
    setPrimary(n) {
      inRange(n);
      if (!made.has(n)) throw new RangeError(`Playback slot ${n} does not exist`);
      if (n === primary) return;
      const prev = primary;
      primary = n;
      for (const fn of [...listeners]) fn(n, prev);
    },
    onPrimary(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onSlots(fn) {
      slotListeners.add(fn);
      return () => slotListeners.delete(fn);
    },
    stopAll() {
      made.get(primary)!.stop();
      for (const [, s] of others()) s.stop();
    },
    release() {
      const freed = others();
      for (const [n, s] of freed) {
        s.stop();
        s.dispose?.();
        made.delete(n);
      }
      if (freed.length) changed();
    },
  };
}
