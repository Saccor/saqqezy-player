/**
 * Text folded for comparing words people type or guides write: compatibility-decomposed (NFKD), marks dropped, lower
 * case ("Café" and "CAFE" both give "cafe"). The one folding for sports sides, categories, teams, track language
 * names and regions. Search keys (`searchKey`) and guide ids (`normalize`) have their own forms.
 */
export function foldText(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}
