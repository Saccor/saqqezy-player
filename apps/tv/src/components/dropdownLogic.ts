import { SPACE } from '../shell/theme.ts';

/** Lightning measures text late, so a header's width is estimated: 0.6 em a character, plus chevron and padding. */
const CHAR_EM = 0.6;
/** The chevron's box. */
export const CHEVRON = 28;
/** Between the label and the chevron. */
export const GAP = SPACE.m;
/** The pill's horizontal padding: a left-aligned header draws its pill this far left of its x. */
export const PAD_X = SPACE.l;
const MAX_W = 900;

export function dropdownWidth(label: string, size: number): number {
  return Math.min(MAX_W, Math.ceil(label.length * size * CHAR_EM) + GAP + CHEVRON + PAD_X * 2);
}
