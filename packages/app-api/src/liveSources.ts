import type { Storage } from '@iptv/core';

/** Most remembered sources per source (oldest dropped). */
const LIVE_PICKS_MAX = 2000;
/** How long a stream that failed to play sorts last. */
const LIVE_BAD_MS = 10 * 60_000;

export const livePickKey = (sourceId: string): string => `livePick:${sourceId}`;

/**
 * What the worker remembers about combined channels' streams (spec 2026-10-19-live-grouping §4): the source that
 * last played (or was picked) per row, stored per source on this device; and, in memory only, streams that failed
 * to play in the last ten minutes.
 */
export class LiveSourceMemory {
  /** Source id → fold key → channel id. Insertion order is age (a write moves the key to the end). */
  private readonly picks = new Map<string, Map<string, string>>();
  private readonly bad = new Map<string, number>();

  constructor(private readonly storage: Storage, private readonly now: () => number) {}

  async pick(sourceId: string, foldKey: string): Promise<string | undefined> {
    return (await this.load(sourceId)).get(foldKey);
  }

  async remember(sourceId: string, foldKey: string, channelId: string): Promise<void> {
    const m = await this.load(sourceId);
    if (m.get(foldKey) === channelId) return;
    m.delete(foldKey);
    m.set(foldKey, channelId);
    while (m.size > LIVE_PICKS_MAX) m.delete(m.keys().next().value!);
    await this.storage.setMeta(livePickKey(sourceId), Object.fromEntries(m));
  }

  failed(channelId: string): void {
    this.bad.set(channelId, this.now());
  }

  /** It played: no longer known-bad. */
  played(channelId: string): void {
    this.bad.delete(channelId);
  }

  isBad(channelId: string): boolean {
    const at = this.bad.get(channelId);
    if (at === undefined) return false;
    if (this.now() - at < LIVE_BAD_MS) return true;
    this.bad.delete(channelId);
    return false;
  }

  /** The source was deleted (its stored record is cleared by the caller). */
  forget(sourceId: string): void {
    this.picks.delete(sourceId);
  }

  private async load(sourceId: string): Promise<Map<string, string>> {
    let m = this.picks.get(sourceId);
    if (!m) {
      const raw = await this.storage.getMeta<unknown>(livePickKey(sourceId)).catch(() => undefined);
      m = new Map();
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') m.set(k, v);
      }
      this.picks.set(sourceId, m);
    }
    return m;
  }
}
