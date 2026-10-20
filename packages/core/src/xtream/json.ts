import { capName } from '../text/normalize.ts';

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined =>
  v === null || v === undefined || String(v).trim() === '' ? undefined : String(v).trim();
/** `str` for a name or title: capped at INGEST_NAME_MAX. Not for urls or plots. */
export const nameStr = (v: unknown): string | undefined => {
  const s = str(v);
  return s === undefined ? undefined : capName(s);
};
export const nonNegInt = (v: unknown): number | undefined => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
export const posInt = (v: unknown): number | undefined => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
