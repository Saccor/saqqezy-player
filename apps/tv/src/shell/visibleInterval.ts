/**
 * `setInterval` that sleeps while the page is hidden. TV web apps keep running JavaScript in the background, so a
 * screen's refresh tick would otherwise fire every N seconds for nothing. When the page becomes visible again the
 * callback runs once at once (the screen catches up), then the cadence resumes.
 *
 * Returns a stop function. `doc` is injectable for tests.
 */
export interface VisibilityDoc {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export function visibleInterval(fn: () => void, ms: number, doc: VisibilityDoc = document): () => void {
  const tick = (): void => { if (!doc.hidden) fn(); };
  const timer = setInterval(tick, ms);
  const onVisible = (): void => { if (!doc.hidden) fn(); };
  doc.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(timer);
    doc.removeEventListener('visibilitychange', onVisible);
  };
}
