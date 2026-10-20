import type { VodTile } from '@iptv/app-api';

/** Joins meta parts with " · ", skipping empty ones. Pure. */
export function joinMeta(...parts: (string | undefined)[]): string {
  return parts.filter((p): p is string => !!p).join(' · ');
}

/**
 * What used to be drawn on the poster (spec §1.3: one overlay only): the episode badge, progress as a percentage,
 * Watched, and the number of versions. Shown in the info strip's meta line.
 */
export function tileStatus(t: Pick<VodTile, 'progress' | 'badge' | 'watched' | 'versions'>): string {
  const progress = t.progress !== undefined && t.progress > 0 ? `${Math.round(t.progress * 100)}% watched` : undefined;
  return joinMeta(
    t.badge,
    progress ?? (t.watched ? 'Watched' : undefined),
    t.versions !== undefined && t.versions > 1 ? `${t.versions} versions` : undefined,
  );
}
