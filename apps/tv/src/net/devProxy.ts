/** Host of the local fake provider (tools/fake-xtream), which already sends CORS headers. */
const FAKE_PROVIDER_HOST = '127.0.0.1:8899';

function proxiable(url: string): URL | undefined {
  if (!import.meta.env.DEV) return undefined;
  let target: URL;
  try {
    target = new URL(url, self.location.href);
  } catch {
    return undefined;
  }
  if (target.origin === self.location.origin || target.host === FAKE_PROVIDER_HOST) return undefined;
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return undefined;
  return target;
}

/**
 * In `vite dev` only: routes a cross-origin fetch of the worker (playlists, EPG, API) through the dev proxy's
 * `/__proxy/raw` route, which never rewrites the body. In production builds `import.meta.env.DEV` is `false`,
 * so this is the identity function and the proxy path is tree-shaken away: TVs fetch directly.
 */
export function rawViaDevProxy(url: string): string {
  const target = proxiable(url);
  return target ? `/__proxy/raw?u=${encodeURIComponent(target.toString())}` : url;
}

/**
 * Same, for player URLs: the `/__proxy/hls/<file name>?u=` route rewrites HLS playlists so segments and keys
 * also go through the proxy. The file-name segment keeps the extension visible to native HLS, which sniffs URLs.
 */
export function hlsViaDevProxy(url: string): string {
  const target = proxiable(url);
  if (!target) return url;
  const name = target.pathname.split('/').pop() ?? '';
  return `/__proxy/hls${name ? `/${encodeURIComponent(name)}` : ''}?u=${encodeURIComponent(target.toString())}`;
}
