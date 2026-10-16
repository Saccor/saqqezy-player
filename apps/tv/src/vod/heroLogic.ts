import { metaLine } from './posterLogic.ts';

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
