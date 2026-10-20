import { headerQuery, type RouteHeaders } from './headerParams.ts';

/** Host of the local fake provider (tools/fake-xtream), which already sends CORS headers. */
const FAKE_PROVIDER_HOST = '127.0.0.1:8899';

/** True when `h` has a header to send: only the proxy can send it, so even the fake provider goes through it then. */
const hasHeaders = (h: RouteHeaders | undefined): boolean => Boolean(h?.userAgent || h?.referrer);

function proxiable(url: string, headers: RouteHeaders | undefined): URL | undefined {
  if (!import.meta.env.DEV) return undefined;
  let target: URL;
  try {
    target = new URL(url, self.location.href);
  } catch {
    return undefined;
  }
  if (target.origin === self.location.origin || (target.host === FAKE_PROVIDER_HOST && !hasHeaders(headers))) return undefined;
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return undefined;
  return target;
}

/**
 * In `vite dev` only: routes a cross-origin fetch of the worker (playlists, EPG, API) through the dev proxy's
 * `/__proxy/raw` route, which never rewrites the body. In production builds `import.meta.env.DEV` is `false`,
 * so this is the identity function and the proxy path is tree-shaken away: TVs fetch directly (and `headers`
 * are dropped: a page cannot set them). `headers`: the source's User-Agent and Referer (`&ua=`, `&ref=`).
 */
export function rawViaDevProxy(url: string, headers?: RouteHeaders): string {
  const target = proxiable(url, headers);
  return target ? `/__proxy/raw?u=${encodeURIComponent(target.toString())}${headerQuery(headers)}` : url;
}

/**
 * Same, for player URLs: the `/__proxy/hls/<file name>?u=` route rewrites HLS playlists so segments and keys
 * also go through the proxy. The file-name segment keeps the extension visible to native HLS, which sniffs URLs.
 */
export function hlsViaDevProxy(url: string, headers?: RouteHeaders): string {
  const target = proxiable(url, headers);
  if (!target) return url;
  const name = target.pathname.split('/').pop() ?? '';
  return `/__proxy/hls${name ? `/${encodeURIComponent(name)}` : ''}?u=${encodeURIComponent(target.toString())}${headerQuery(headers)}`;
}

/** Set by the dev proxy on its 502 when the upstream could not be reached at all. */
export const UNREACHABLE_HEADER = 'x-dev-proxy-unreachable';

/**
 * In `vite dev` only: a proxied fetch whose upstream was unreachable throws like a direct fetch would
 * (`TypeError`), so core reports "Could not reach the provider." instead of an HTTP 502. Identity in production.
 */
export function unwrapDevProxyResponse(res: Response): Response {
  if (import.meta.env.DEV && res.status === 502 && res.headers.get(UNREACHABLE_HEADER) === '1') {
    throw new TypeError('Failed to fetch');
  }
  return res;
}
