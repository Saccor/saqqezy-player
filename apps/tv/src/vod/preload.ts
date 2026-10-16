/**
 * Warms the Movies tab: the first time live playback reaches `playing` for a source, asks the worker (in idle
 * time) to load the stored movie catalogue into memory. The worker never fetches for this, and skips it when a
 * catalogue is already resident.
 */
export function createVodPreloader(deps: { preload(): Promise<unknown>; schedule(run: () => void): void }) {
  let handled: string | undefined;
  return (status: string | undefined, sourceId: string | undefined): void => {
    if (status !== 'playing' || !sourceId || handled === sourceId) return;
    handled = sourceId;
    deps.schedule(() => {
      void deps.preload().catch(() => {
        // Best effort: the tab loads on open anyway.
      });
    });
  };
}

/** Runs `run` when the page is idle (at most 5 s later), or after 2 s where requestIdleCallback is missing (older TVs). */
export function idleSchedule(run: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(run, { timeout: 5000 });
  else setTimeout(run, 2000);
}
