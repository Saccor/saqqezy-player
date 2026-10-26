/** What the scheduler needs from the page; injected so the logic is testable without timers. */
export interface AfterFrameEnv {
  hidden(): boolean;
  raf(cb: () => void): void;
  setTimer(cb: () => void, ms: number): void;
}

/**
 * Runs `fn` after the frame that shows the key press (rAF, then a macrotask). A hidden page presents no frames and
 * rAF never fires there, so `fn` runs at once; a stalled frame loop is covered by a fallback timer. `fn` runs once.
 */
export function createAfterFrame(env: AfterFrameEnv, fallbackMs = 250): (fn: () => void) => void {
  return (fn) => {
    if (env.hidden()) {
      fn();
      return;
    }
    let done = false;
    const once = (): void => {
      if (done) return;
      done = true;
      fn();
    };
    env.raf(() => { env.setTimer(once, 0); });
    env.setTimer(once, fallbackMs);
  };
}

export const afterFrame = createAfterFrame({
  hidden: () => document.hidden,
  raf: (cb) => { requestAnimationFrame(cb); },
  setTimer: (cb, ms) => { setTimeout(cb, ms); },
});
