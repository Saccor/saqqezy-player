import type { FetchInit } from '@iptv/core';
import type { RouteHeaders } from './headerParams.ts';

/**
 * The worker's fetch: core's `FetchInit.sourceHeaders` (a source's User-Agent and Referer on list requests) become
 * part of the route URL, since a page cannot set those headers itself, and the field is stripped before `fetch`.
 * `route` is the dev proxy today (`rawViaDevProxy`, the identity in production builds) and the host route later.
 */
export function routedFetch(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  route: (url: string, headers?: RouteHeaders) => string,
): (url: string, init?: FetchInit) => Promise<Response> {
  return (url, init) => {
    if (!init) return fetchImpl(route(url));
    const { sourceHeaders, timeoutMs: _timeout, ...rest } = init;
    return fetchImpl(route(url, sourceHeaders), rest);
  };
}
