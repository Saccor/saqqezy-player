type Target = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * Calls `fn` each time the device comes back online (the browser's `online` event). The shell uses it to end an
 * unreachable wait of the active source, so an outage on our side never looks like a dead source. Returns the
 * unsubscribe function.
 */
export function onBackOnline(target: Target | undefined, fn: () => void): () => void {
  if (!target) return () => undefined;
  const handler = () => {
    try {
      fn();
    } catch (err) {
      console.warn('Back-online handler failed', err instanceof Error ? err.name : 'Error');
    }
  };
  target.addEventListener('online', handler);
  return () => target.removeEventListener('online', handler);
}
