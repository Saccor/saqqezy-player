/**
 * The identity the dev proxy sends upstream. The proxy fetches from Node, so it must not present the browser's
 * user-agent: a browser label on a non-browser client, in bursts, is what sources flag and ban. It identifies
 * as our player, honestly and stably (Node's default user-agent is rejected by some sources).
 */
export const DEV_USER_AGENT = 'SaqqezyPlayer/0.0.0 (dev)';

/**
 * Request headers the dev proxy sends upstream: our own `user-agent` and, when `forwardRange` is true, `range`.
 * Nothing from the browser is forwarded (no user-agent, cookies, origin or referer).
 */
export function upstreamHeaders(
  req: Record<string, string | string[] | undefined>,
  forwardRange: boolean,
): Record<string, string> {
  const out: Record<string, string> = { 'user-agent': DEV_USER_AGENT };
  const range = req.range;
  if (forwardRange && typeof range === 'string' && range) out.range = range;
  return out;
}
