/** An HTTP-date (RFC 9110 §5.6.7) starts with a day name: IMF-fixdate, the obsolete RFC 850 form, or asctime. */
const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s/i;
/** asctime (`Sun Nov  6 08:49:37 1994`) carries no zone; HTTP dates are always GMT. */
const ASCTIME = /^[a-z]{3} [a-z]{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/i;

/**
 * A `Retry-After` header value (RFC 9110 §10.2.3) as milliseconds from `now`: delay-seconds or an HTTP-date. A date in
 * the past is 0; anything else (missing, empty, fractional, negative, unparsable) is undefined.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  if (!HTTP_DATE.test(v)) return undefined;
  const at = Date.parse(ASCTIME.test(v) ? `${v} GMT` : v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
