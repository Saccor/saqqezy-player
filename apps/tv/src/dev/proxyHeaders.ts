import type { RouteHeaders } from '../net/headerParams.ts';

/**
 * The identity the dev proxy sends upstream. The proxy fetches from Node, so it must not present the browser's
 * user-agent: a browser label on a non-browser client, in bursts, is what sources flag and ban. It identifies
 * as our player, honestly and stably (Node's default user-agent is rejected by some sources).
 */
export const DEV_USER_AGENT = 'SaqqezyPlayer/0.0.0 (dev)';

/**
 * Request headers the dev proxy sends upstream: our own `user-agent` and, when `forwardRange` is true, `range`.
 * Nothing from the browser is forwarded (no user-agent, cookies, origin or referer). `source`: the source's
 * User-Agent and Referer from the route URL's `ua` and `ref` (already checked by `readHeaderParams`); its
 * User-Agent replaces ours, and its Referer is the only referer ever sent. Never log them.
 */
export function upstreamHeaders(
  req: Record<string, string | string[] | undefined>,
  forwardRange: boolean,
  source?: RouteHeaders,
): Record<string, string> {
  const out: Record<string, string> = { 'user-agent': source?.userAgent || DEV_USER_AGENT };
  if (source?.referrer) out.referer = source.referrer;
  const range = req.range;
  if (forwardRange && typeof range === 'string' && range) out.range = range;
  return out;
}
