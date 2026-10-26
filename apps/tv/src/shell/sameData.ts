/**
 * Structural equality for plain, JSON-like data (what the worker sends: primitives, arrays and plain objects). A
 * screen compares a re-read with what it shows before setting it, so a periodic refresh that changed nothing
 * rebuilds no memo and remounts no text (spec 2026-10-26 §0.3).
 */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], bb[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k) || !sameData(ao[k], bo[k])) return false;
  }
  return true;
}
