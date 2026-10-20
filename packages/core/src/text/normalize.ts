import { INGEST_NAME_MAX } from '../constants.ts';

/** `s` cut to INGEST_NAME_MAX UTF-16 units, never between the two halves of a surrogate pair, and trimmed again. */
export function capName(s: string): string {
  if (s.length <= INGEST_NAME_MAX) return s;
  const hi = s.charCodeAt(INGEST_NAME_MAX - 1);
  return s.slice(0, hi >= 0xd800 && hi <= 0xdbff ? INGEST_NAME_MAX - 1 : INGEST_NAME_MAX).trimEnd();
}

export function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
