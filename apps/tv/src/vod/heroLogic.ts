import { metaLine } from './posterLogic.ts';
import { isTvPlatform } from '../video/engineConfig.ts';

/** Browse hero formatting for series. Pure: no Solid, no Lightning. */

/** "1 season" / "N seasons"; empty when there are none (or the view is not loaded). */
export function seasonsText(n: number): string {
  if (n <= 0) return '';
  return n === 1 ? '1 season' : `${n} seasons`;
}

/** "2021 · 3 seasons · Drama · 12 · ★ 7.6", leaving out what is missing. */
export function seriesMetaLine(p: { year?: number; seasons: number; genre?: string; ageRating?: string; rating?: number }): string {
  return [metaLine({ year: p.year }), seasonsText(p.seasons), metaLine({ genre: p.genre, ageRating: p.ageRating, rating: p.rating })]
    .filter((s) => s !== '')
    .join(' · ');
}

/**
 * Backdrop art behind the browse strip and on Details: desktop and browser only (spec 2026-10-26 §0.3). On a TV each
 * one is the largest texture on screen (~2.4–4 MB), two cross-fade layers and two gradient scrims.
 */
export function showsBackdrop(platform: string): boolean {
  return !isTvPlatform(platform);
}
