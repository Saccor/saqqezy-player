/** Team-side text for grouping one match across channels. Pure. */

/** Tokens that say "club", not which club; dropped from a side before comparing. */
const DROP = new Set(['fc', 'afc', 'cf', 'sc', 'sv', 'bk', 'if', 'ff', 'ac', 'as', 'fk', '1']);
export const SIDE_MATCH = 0.85;

export function foldText(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * The stored and compared form of a guide category text: folded, inner spaces collapsed, trimmed (the settings'
 * normaliser), so a chosen chip id survives `sanitizeSettings` and detection sees "Ice  Hockey" as "ice hockey".
 */
export function categoryKey(s: string): string {
  return foldText(s).replace(/\s+/g, ' ').trim();
}

export function normSide(s: string): string {
  const t = foldText(s)
    // A written date the guide glued on ("24/10/26", "24.10.2026", "2026-10-24", or a JSON-escaped "24\/10\/26") is
    // not part of the name.
    .replace(/(?<![\p{L}\p{N}])\d{1,4}\\?[./-]\d{1,2}\\?[./-]\d{2,4}(?![\p{L}\p{N}])/gu, ' ')
    .replace(/&/g, ' and ')
    .replace(/\bst\.\s*/g, 'saint ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
  // A 6- or 8-digit token is a date the guide glued on ("Eastport 241026"), never part of a name.
  return t.split(/\s+/).filter((w) => w && !DROP.has(w) && !/^\d{6}(?:\d{2})?$/.test(w)).map((w) => (w === 'utd' ? 'united' : w)).join(' ');
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false);
  const bm = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(b.length - 1, i + range);
    for (let j = lo; j <= hi; j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = true;
      bm[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0;
  for (let i = 0, j = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[j]) j++;
    if (a[i] !== b[j]) t++;
    j++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

export function resolveAlias(s: string, aliases: ReadonlyMap<string, string>): string {
  return aliases.get(s) ?? s;
}

/** Both sides normalised (and alias-resolved) already. Empty sides never match. */
export function sideMatch(a: string, b: string): 'exact' | 'fuzzy' | undefined {
  if (a === '' || b === '') return undefined;
  if (a === b) return 'exact';
  return jaroWinkler(a, b) >= SIDE_MATCH ? 'fuzzy' : undefined;
}
