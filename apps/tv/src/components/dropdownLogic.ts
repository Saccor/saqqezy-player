/** Lightning measures text late, so a header's width is estimated: 0.6 em a character, plus chevron and padding. */
const CHAR_EM = 0.6;
const CHEVRON = 28;
const GAP = 12;
const PAD_X = 20;
const MAX_W = 900;

export function dropdownWidth(label: string, size: number): number {
  return Math.min(MAX_W, Math.ceil(label.length * size * CHAR_EM) + GAP + CHEVRON + PAD_X * 2);
}
