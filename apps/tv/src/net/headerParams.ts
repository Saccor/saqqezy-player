// The route-URL form of a source's User-Agent and Referer (spec 2026-10-20-source-headers §4.1): `&ua=` and `&ref=`
// after `u`. Shared by the app (which builds dev proxy URLs) and the dev proxy (which reads them). Pure, no DOM or
// Node APIs. The values are secrets in the same sense as `u`: never log them.

/**
 * Longest accepted value; the same cap as the stored settings (core `HEADER_VALUE_MAX`). A number, not an import:
 * the Vite config (vite.proxy.ts) loads this file in Node, which cannot load core's TypeScript sources.
 */
export const HEADER_PARAM_MAX = 512;

/** The headers a route URL can carry (structurally core's `StreamHeaders`). */
export interface RouteHeaders {
  userAgent?: string;
  referrer?: string;
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** `&ua=<enc>&ref=<enc>` for the headers that are set; empty when none is, so URLs without headers are unchanged. */
export function headerQuery(h: RouteHeaders | undefined): string {
  let out = '';
  if (h?.userAgent) out += `&ua=${encodeURIComponent(h.userAgent)}`;
  if (h?.referrer) out += `&ref=${encodeURIComponent(h.referrer)}`;
  return out;
}

/**
 * The `ua` and `ref` parameters of a route request; `'invalid'` when one has a control character or is longer than
 * HEADER_PARAM_MAX (the route answers 400). Empty values count as absent.
 */
export function readHeaderParams(params: URLSearchParams): RouteHeaders | 'invalid' {
  const out: RouteHeaders = {};
  for (const [key, field] of [['ua', 'userAgent'], ['ref', 'referrer']] as const) {
    const v = params.get(key);
    if (!v) continue;
    if (v.length > HEADER_PARAM_MAX || CONTROL_RE.test(v)) return 'invalid';
    out[field] = v;
  }
  return out;
}
