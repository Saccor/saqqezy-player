import { SourceNetworkError } from '../errors.ts';
import type { FetchFn } from '../types.ts';

/**
 * Rejects when response headers have not arrived within `ms`. The body is not timed out
 * once headers are in, so long EPG downloads are unaffected.
 */
export function withTimeout(fetchFn: FetchFn, ms = 10_000): FetchFn {
  return (url, init) => {
    const controller = new AbortController();
    const outer = init?.signal;
    const onOuterAbort = () => controller.abort();
    if (outer) {
      if (outer.aborted) controller.abort();
      else outer.addEventListener('abort', onOuterAbort, { once: true });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new SourceNetworkError('The provider did not respond in time.'));
      }, ms);
    });
    const request = fetchFn(url, { ...init, signal: controller.signal });
    // If the timeout wins, a later rejection of `request` must not become unhandled.
    request.catch(() => {});
    return Promise.race([request, timeout])
      .catch((err: unknown) => {
        throw timedOut ? new SourceNetworkError('The provider did not respond in time.') : err;
      })
      .finally(() => {
        clearTimeout(timer);
        outer?.removeEventListener('abort', onOuterAbort);
      });
  };
}
