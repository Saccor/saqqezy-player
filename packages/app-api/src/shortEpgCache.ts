import { lruSet, type Programme } from '@iptv/core';

/** Nothing found (or the request failed): asked again after this long. */
export const SHORT_EPG_EMPTY_TTL_MS = 15 * 60_000;
/** Answers kept per source; the oldest go first (memory on 1 GB TVs). */
const MAX_PER_SOURCE = 500;

interface Entry { until: number; programmes: Programme[] }

/**
 * Until when a short-EPG answer stays good, from its now/next on the displayed timeline at `t`: the end of the
 * programme on now, else the start of the next one (at most 15 min away), else 15 min.
 */
export function shortEpgUntil(nn: { now?: Programme; next?: Programme }, t: number): number {
  const empty = t + SHORT_EPG_EMPTY_TTL_MS;
  if (nn.now) return nn.now.stop;
  return nn.next ? Math.min(nn.next.start, empty) : empty;
}

/**
 * Short-EPG answers per source and channel, in memory (spec 2026-10-15-gentle-source §3.2). The programmes are kept
 * as the source sent them (unshifted), so a changed guide offset still applies on read.
 */
export class ShortEpgCache {
  private readonly bySource = new Map<string, Map<string, Entry>>();

  /** The answer's programmes while it is good at `t` (an empty list: nothing found); undefined when unknown or expired. */
  get(sourceId: string, channelId: string, t: number): Programme[] | undefined {
    const e = this.bySource.get(sourceId)?.get(channelId);
    return e && t < e.until ? e.programmes : undefined;
  }

  set(sourceId: string, channelId: string, programmes: Programme[], until: number): void {
    let m = this.bySource.get(sourceId);
    if (!m) {
      m = new Map();
      this.bySource.set(sourceId, m);
    }
    lruSet(m, channelId, { until, programmes }, MAX_PER_SOURCE);
  }

  dropSource(sourceId: string): void {
    this.bySource.delete(sourceId);
  }
}
