/**
 * Build-time only (vite.config.ts): the Cloudflare Pages `_headers` file for the companion, generated from
 * `VITE_RELAY_URL` so the CSP's `connect-src` always allows the relay this build talks to. Never imported by the app.
 */

/** The local dev relay (`pnpm relay:dev`), used when VITE_RELAY_URL is not set (same default as the app). */
export const DEV_RELAY_URL = 'ws://127.0.0.1:8787';

/** `ws(s)://host[:port]` of a relay URL. Throws for anything that is not a ws: or wss: URL. */
export function relayOrigin(url: string): string {
  const u = new URL(url);
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new Error(`VITE_RELAY_URL must be a ws: or wss: URL, got ${u.protocol}`);
  }
  return `${u.protocol}//${u.host}`;
}

/**
 * The `_headers` text. `img-src https:` is needed because channel logos come from the user's own playlist and guide
 * URLs. The build has no inline scripts or styles, so `script-src 'self'` and `style-src 'self'` hold.
 */
export function buildHeaders(relayUrl: string | undefined): string {
  const relay = relayOrigin(relayUrl || DEV_RELAY_URL);
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src 'self' ${relay}`,
    "img-src 'self' data: https:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return [
    '# Generated at build time from VITE_RELAY_URL (apps/companion/src/build/headers.ts). Do not edit dist/_headers.',
    '/*',
    `  Content-Security-Policy: ${csp}`,
    '  Referrer-Policy: no-referrer',
    '  X-Content-Type-Options: nosniff',
    '',
  ].join('\n');
}
