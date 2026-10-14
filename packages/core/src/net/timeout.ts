import { SourceNetworkError } from '../errors.ts';
import type { FetchFn } from '../types.ts';

/** `player_api.php` calls: small JSON answers. */
export const API_TIMEOUT_MS = 15_000;
/** Playlist and XMLTV downloads, to first byte: providers often build these on demand. */
export const DOWNLOAD_TIMEOUT_MS = 90_000;
/** Playlist and XMLTV bodies: abort when no chunk arrives for this long (see `responseText`). */
export const BODY_IDLE_MS = 30_000;

/**
 * Rejects when response headers have not arrived within `init.timeoutMs` (per call) or `ms`. The body is not
 * timed out here once headers are in (`responseText` has its own inactivity timeout), so long EPG downloads
 * are unaffected.
 */
export function withTimeout(fetchFn: FetchFn, ms = API_TIMEOUT_MS): FetchFn {
  return (url, fullInit) => {
    const { timeoutMs, ...init } = fullInit ?? {};
    const limit = timeoutMs ?? ms;
    const controller = new AbortController();
    const outer = init.signal;
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
      }, limit);
    });
    const request = fetchFn(url, { ...init, signal: controller.signal });
    // If the timeout wins, a later rejection of `request` must not become unhandled.
    request.catch(() => {});
    return Promise.race([request, timeout])
      .catch((err: unknown) => {
        throw timedOut ? new SourceNetworkError('The provider did not respond in time.') : err;
      })
      .then(
        (res) => {
          // Headers are in: stop only the timer. The caller's abort stays linked so it can
          // still cancel the body download (one small listener per request is acceptable).
          clearTimeout(timer);
          return res;
        },
        (err: unknown) => {
          clearTimeout(timer);
          outer?.removeEventListener('abort', onOuterAbort);
          throw err;
        },
      );
  };
}
