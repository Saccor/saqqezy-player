/** One stream of a live row, as the ordering sees it. */
export interface LiveSourceCandidate {
  id: string;
  /** Quality rank (0 = 4K … 4 = unknown). */
  quality: number;
  /** Named as a spare feed. */
  backup: boolean;
  /** Failed to play recently, or its host is waiting after a refusal. */
  bad?: boolean;
  /** In one of Your countries (mode first or only): played before other countries of any quality. */
  preferred?: boolean;
}

export interface LiveSourceContext {
  /** The source that last played for this row (or that the user picked). */
  last?: string;
}

/**
 * A row's sources best first; [0] is what plays (spec 2026-10-19-live-grouping §4): known-bad last; then the last
 * played source; then Your countries (catalogue-personalisation §2.2); then the last source's quality; then best
 * quality, not a spare feed, playlist order.
 */
export function orderLiveSources<T extends LiveSourceCandidate>(cands: readonly T[], ctx: LiveSourceContext): T[] {
  const last = ctx.last === undefined ? undefined : cands.find((x) => x.id === ctx.last);
  const lastQ = last?.quality;
  return cands
    .map((x, i) => ({ x, i }))
    .sort((a, b) => Number(a.x.bad ?? false) - Number(b.x.bad ?? false)
      || Number(b.x === last) - Number(a.x === last)
      || Number(b.x.preferred ?? false) - Number(a.x.preferred ?? false)
      || Number(b.x.quality === lastQ) - Number(a.x.quality === lastQ)
      || a.x.quality - b.x.quality
      || Number(a.x.backup) - Number(b.x.backup)
      || a.i - b.i)
    .map((y) => y.x);
}
