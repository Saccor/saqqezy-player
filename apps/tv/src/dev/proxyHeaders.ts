/**
 * Request headers the dev proxy sends upstream: the browser's `user-agent` (some providers reject Node's
 * default one) and, when `forwardRange` is true, `range`. Nothing else (no cookies, origin or referer).
 */
export function upstreamHeaders(
  req: Record<string, string | string[] | undefined>,
  forwardRange: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  const ua = req['user-agent'];
  if (typeof ua === 'string' && ua) out['user-agent'] = ua;
  const range = req.range;
  if (forwardRange && typeof range === 'string' && range) out.range = range;
  return out;
}
