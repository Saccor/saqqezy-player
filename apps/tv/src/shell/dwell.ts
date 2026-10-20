import { createEffect, createSignal, on, onCleanup, type Accessor } from 'solid-js';
import { MOTION } from './theme.ts';

/**
 * "Follow focus once it rests" (spec §1.3, InfoStrip and Backdrop): the first value applies at once (a screen opens
 * with its info filled). `undefined` (a source still loading) applies at once too but does not use up that first
 * chance, so the first real value is also immediate. After that a value applies only when no newer one came for `ms`, so holding a key never
 * loads backdrops or rewrites text on every step.
 */
export function createDweller<T>(ms: number, set: (v: T) => void): { push(v: T): void; cancel(): void } {
  let first = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  return {
    push(v) {
      if (first) {
        cancel();
        if (v !== undefined) first = false;
        set(v);
        return;
      }
      cancel();
      timer = setTimeout(() => { timer = undefined; set(v); }, ms);
    },
    cancel,
  };
}

/** A signal that follows `source` after it rests for `ms` (default MOTION.dwell). */
export function dwellSignal<T>(source: () => T, ms: number = MOTION.dwell): Accessor<T> {
  const [value, setValue] = createSignal<T>(source());
  const d = createDweller<T>(ms, (v) => setValue(() => v));
  d.push(source());
  createEffect(on(source, (s) => d.push(s), { defer: true }));
  onCleanup(d.cancel);
  return value;
}
