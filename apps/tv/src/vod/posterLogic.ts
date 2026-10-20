/** Poster and meta formatting. Pure: no Solid, no Lightning. */

/** 8 per row across the content width: (1664 − 7 × 24) / 8. */
export const POSTER_W = 187;
export const POSTER_H = 280;
export const POSTER_GAP = 24;

/** Calm, dark title-card colours (white text stays readable on each). */
export const CARD_COLOURS: readonly number[] = [
  0x1d3b53ff, 0x3a1f2bff, 0x16302bff, 0x2a2440ff, 0x40311aff, 0x13263dff, 0x2f3a1cff, 0x33202fff,
];

/** A stable colour per title, for titles without a poster. */
export function titleCardColour(title: string): number {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  return CARD_COLOURS[h % CARD_COLOURS.length]!;
}

export function formatRuntime(minutes: number | undefined): string | undefined {
  if (minutes === undefined || !Number.isFinite(minutes)) return undefined;
  const min = Math.round(minutes);
  if (min <= 0) return undefined;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** "2022 · 1 h 54 min · Drama · 12 · ★ 7.6", leaving out what is missing. */
export function metaLine(p: { year?: number; runtimeMin?: number; genre?: string; ageRating?: string; rating?: number }): string {
  const parts: string[] = [];
  if (p.year) parts.push(String(p.year));
  const rt = formatRuntime(p.runtimeMin);
  if (rt) parts.push(rt);
  if (p.genre) parts.push(p.genre);
  if (p.ageRating) parts.push(p.ageRating);
  if (p.rating !== undefined && Number.isFinite(p.rating) && p.rating > 0) parts.push(`★ ${p.rating.toFixed(1)}`);
  return parts.join(' · ');
}

export function barWidth(progress: number | undefined, width: number): number {
  if (progress === undefined || Number.isNaN(progress)) return 0;
  return Math.round(Math.max(0, Math.min(1, progress)) * width);
}

export type PosterFace = 'skeleton' | 'card' | 'image';

/**
 * What a poster shows: a skeleton while its tile (`pending`) or its image is on the way, the image once loaded, and
 * the title on a coloured card when there is no image or it failed.
 */
export function posterFace(p: { pending: boolean; image: string | undefined; loaded: boolean; failed: boolean }): PosterFace {
  if (p.pending) return 'skeleton';
  if (!p.image || p.failed) return 'card';
  return p.loaded ? 'image' : 'skeleton';
}
