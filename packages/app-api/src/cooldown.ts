import type { SourceCooldown } from '@iptv/core';

/**
 * The cooldown that blocks longer. A stream is blocked when its host or its source is (spec 2026-10-16-source-retry
 * §5): the worker's Retry answer and the TV's cooldown copy both show the worse of the two.
 */
export function worseCooldown(a: SourceCooldown, b: SourceCooldown): SourceCooldown {
  if (a.state === 'clear') return b;
  if (b.state === 'clear') return a;
  return b.until > a.until ? b : a;
}
