/**
 * Gives the thread back to other tasks (worker requests) for one turn of the event loop.
 *
 * A `setTimeout(0)` pause is clamped: to 4 ms once timers nest in browser workers, and to the system tick (about
 * 15 ms) on Windows Node. That makes a guide import with a pause every 8 ms up to 1.5x slower on a TV. A
 * `MessageChannel` message is a task without that clamp. Every `TIMER_YIELD_EVERY`th pause is still a timer, so a
 * pending timer (the 400 ms lite-row race) gets its turn even where message tasks run ahead of timers.
 *
 * Node (tests, perf) has `setImmediate`, which is used first: Node delivers a port's queued messages in one go, so a
 * chain of message pauses there holds back I/O and `setImmediate` work for several slices (measured: probe p95 from
 * 7 ms to over 20 ms in `guideImport.perf.ts`). `setImmediate` runs once per loop turn, after timers and I/O.
 */
export const TIMER_YIELD_EVERY = 8;

interface PortLike {
  onmessage: ((ev: unknown) => void) | null;
  postMessage(msg: unknown): void;
  /** Node only: a port with a handler keeps the process alive, so it is held only while a pause waits. */
  ref?(): void;
  unref?(): void;
}
export interface YieldDeps {
  /** Default: the global one (Node); pass undefined to leave it out. */
  setImmediate?: ((fn: () => void) => unknown) | undefined;
  /** Default: the global one; without it (and without `setImmediate`) every pause is a timer. */
  MessageChannel?: (new () => { port1: PortLike; port2: PortLike }) | undefined;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  timerEvery?: number;
}

const globals = globalThis as { setImmediate?: YieldDeps['setImmediate']; MessageChannel?: YieldDeps['MessageChannel'] };

/** A pause function as described above; one message channel per pause function, made on its first pause. */
export function createYield(deps: YieldDeps = {}): () => Promise<void> {
  const immediate = 'setImmediate' in deps ? deps.setImmediate : globals.setImmediate;
  if (typeof immediate === 'function') return () => new Promise<void>((resolve) => { immediate(resolve); });
  const MC = 'MessageChannel' in deps ? deps.MessageChannel : globals.MessageChannel;
  const timer = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const every = Math.max(1, deps.timerEvery ?? TIMER_YIELD_EVERY);
  const viaTimer = () => new Promise<void>((resolve) => { timer(resolve, 0); });
  if (typeof MC !== 'function') return viaTimer;
  let ports: { port1: PortLike; port2: PortLike } | undefined;
  const waiting: (() => void)[] = [];
  let count = 0;
  return () => {
    if (++count % every === 0) return viaTimer();
    if (!ports) {
      const made = new MC();
      made.port1.onmessage = () => {
        waiting.shift()?.();
        if (waiting.length === 0) made.port1.unref?.();
      };
      ports = made;
    }
    const p = ports;
    return new Promise<void>((resolve) => {
      waiting.push(resolve);
      p.port1.ref?.();
      p.port2.postMessage(null);
    });
  };
}
