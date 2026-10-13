/** Host of the local fake provider (tools/fake-xtream), which already sends CORS headers. */
const FAKE_PROVIDER_HOST = '127.0.0.1:8899';

/**
 * In `vite dev` only, routes cross-origin requests through the dev proxy (`vite.proxy.ts`).
 * In production builds `import.meta.env.DEV` is `false`, so this is the identity function and the proxy
 * path is tree-shaken away: TVs fetch directly.
 */
export function viaDevProxy(url: string): string {
  if (!import.meta.env.DEV) return url;
  let target: URL;
  try {
    target = new URL(url, self.location.href);
  } catch {
    return url;
  }
  if (target.origin === self.location.origin || target.host === FAKE_PROVIDER_HOST) return url;
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return url;
  // The file-name segment keeps the extension visible to native HLS, which sniffs URLs (see vite.proxy.ts).
  const name = target.pathname.split('/').pop() ?? '';
  return `/__proxy${name ? `/${encodeURIComponent(name)}` : ''}?u=${encodeURIComponent(target.toString())}`;
}
