export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined =>
  v === null || v === undefined || String(v).trim() === '' ? undefined : String(v).trim();
export const nonNegInt = (v: unknown): number | undefined => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
export const posInt = (v: unknown): number | undefined => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
