import { parseRetryAfter } from '@iptv/core';
import { rawViaDevProxy, unwrapDevProxyResponse } from '../net/devProxy.ts';

/** The probe's own cap: past it the status is unknown. */
export const PROBE_TIMEOUT_MS = 5000;

export interface ProbeAnswer {
  status?: number;
  retryAfterMs?: number;
}

export interface StreamProbeDeps {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Dev builds route the probe through the same dev proxy as the worker's fetches; identity in production. */
  route?: (url: string) => string;
  /** Turns a dev-proxy "unreachable" 502 back into a network failure; identity in production. */
  unwrap?: (res: Response) => Response;
  now?: () => number;
}

/**
 * The supervisor's status probe (spec 2026-10-16-source-retry): one `GET` with `Range: bytes=0-0`, aborted as soon
 * as the headers arrive (no body is read), with a 5 s cap. Answers the HTTP status and a parsed `Retry-After`, or `{}`
 * when there was no answer (network error, timeout, the caller's abort). Never logs: the URL may carry credentials.
 */
export function createStreamProbe(deps: StreamProbeDeps = {}): (url: string, signal: AbortSignal) => Promise<ProbeAnswer> {
  const fetchFn = deps.fetch ?? ((u: string, i?: RequestInit) => globalThis.fetch(u, i));
  const route = deps.route ?? rawViaDevProxy;
  const unwrap = deps.unwrap ?? unwrapDevProxyResponse;
  const now = deps.now ?? Date.now;
  return async (url, signal) => {
    if (signal.aborted) return {};
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = unwrap(await fetchFn(route(url), { method: 'GET', headers: { Range: 'bytes=0-0' }, cache: 'no-store', signal: ctl.signal }));
      const out: ProbeAnswer = { status: res.status };
      const retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'), now());
      if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs;
      return out;
    } catch {
      return {};
    } finally {
      // Headers are in (or there is no answer): drop the body and the connection.
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      ctl.abort();
    }
  };
}
