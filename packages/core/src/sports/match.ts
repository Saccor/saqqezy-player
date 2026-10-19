/** Team-side text for grouping one match across channels. Pure. */

/** Tokens that say "club", not which club; dropped from a side before comparing. */
const DROP = new Set(['fc', 'afc', 'cf', 'sc', 'sv', 'bk', 'if', 'ff', 'ac', 'as', 'fk', '1']);
export const SIDE_MATCH = 0.85;

export function foldText(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

export function normSide(s: string): string {
  const t = foldText(s)
    .replace(/&/g, ' and ')
    .replace(/\bst\.\s*/g, 'saint ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return t.split(/\s+/).filter((w) => w && !DROP.has(w)).map((w) => (w === 'utd' ? 'united' : w)).join(' ');
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

/** Both sides normalised (and alias-resolved) already. */
export function sideMatch(a: string, b: string): 'exact' | 'fuzzy' | undefined {
  if (a === b) return 'exact';
  return jaroWinkler(a, b) >= SIDE_MATCH ? 'fuzzy' : undefined;
}
