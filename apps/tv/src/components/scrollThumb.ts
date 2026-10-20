/**
 * The scroll indicator's thumb (Samsung UX checklist: show position on long content): its height is the visible share
 * of the track (at least `minH`), its y the first visible item's share of the scrollable range. Undefined when
 * everything fits. Pure.
 */
export function scrollThumb(total: number, visible: number, first: number, trackH: number, minH = 48): { y: number; h: number } | undefined {
  if (total <= visible || trackH <= 0) return undefined;
  const h = Math.min(trackH, Math.max(minH, Math.round((trackH * visible) / total)));
  const share = Math.min(1, Math.max(0, first / (total - visible)));
  return { y: Math.round((trackH - h) * share), h };
}
