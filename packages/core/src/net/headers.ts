import type { SourceHttpSettings, StreamHeaders } from '../types.ts';

/** Longest header value kept (playlist headers and the source's User-Agent and Referer settings). */
export const HEADER_VALUE_MAX = 512;

// Control characters (a CR/LF would end the header line).
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

/** A header value without control characters, trimmed and capped at `HEADER_VALUE_MAX`; undefined when empty or not a string. */
export function cleanHeaderValue(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const out = v.replace(CONTROL_RE, '').trim().slice(0, HEADER_VALUE_MAX).trim();
  return out || undefined;
}

/** `over`'s headers win field by field over `base`'s; undefined when neither has one. */
export function mergeHeaders(base: StreamHeaders | undefined, over: StreamHeaders | undefined): StreamHeaders | undefined {
  const userAgent = over?.userAgent ?? base?.userAgent;
  const referrer = over?.referrer ?? base?.referrer;
  if (!userAgent && !referrer) return undefined;
  const out: StreamHeaders = {};
  if (userAgent) out.userAgent = userAgent;
  if (referrer) out.referrer = referrer;
  return out;
}

/** A copy of `source` whose `userAgent` and `referrer` are cleaned (`cleanHeaderValue`), and absent when empty. */
export function withCleanHttpSettings<T extends SourceHttpSettings>(source: T): T {
  const { userAgent, referrer, ...rest } = source;
  const out = { ...rest } as T;
  const ua = cleanHeaderValue(userAgent);
  const ref = cleanHeaderValue(referrer);
  if (ua) out.userAgent = ua;
  if (ref) out.referrer = ref;
  return out;
}
