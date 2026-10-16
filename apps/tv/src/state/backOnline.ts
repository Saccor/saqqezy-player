type Target = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** How long the network must stay up after an `online` event before we act on it (flapping Wi-Fi fires many). */
export const BACK_ONLINE_SETTLE_MS = 2000;

/**
 * Calls `fn` when the device comes back online (the browser's `online` event) and stays online for
 * `BACK_ONLINE_SETTLE_MS`: repeated events collapse into one call, and an `offline` event meanwhile cancels it. The
 * shell uses it to end an unreachable wait of the active source, so an outage on our side never looks like a dead
 * source. Returns the unsubscribe function (which also drops a pending call).
 */
export function onBackOnline(target: Target | undefined, fn: () => void): () => void {
  if (!target) return () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const fire = () => {
    timer = undefined;
    try {
      fn();
    } catch (err) {
      console.warn('Back-online handler failed', err instanceof Error ? err.name : 'Error');
    }
  };
  const online = () => {
    cancel();
    timer = setTimeout(fire, BACK_ONLINE_SETTLE_MS);
  };
  target.addEventListener('online', online);
  target.addEventListener('offline', cancel);
  return () => {
    cancel();
    target.removeEventListener('online', online);
    target.removeEventListener('offline', cancel);
  };
}
