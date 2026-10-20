import type { Storage } from '../storage.ts';
import { isHlc } from './hlc.ts';
import { expiredTombstone, wins } from './merge.ts';
import { registerKey, type SyncRecord } from './types.ts';

/** `syncMeta` scope of records whose source is not on this device (yet). Outlives sources. */
export const PENDING_SCOPE = '#pending';
/** Records kept pending at most; past it the oldest go (a 50k hidden set of an absent source still fits). */
export const PENDING_MAX = 200_000;

const isRecord = (x: unknown): x is SyncRecord => {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Partial<SyncRecord>;
  return typeof r.k === 'string' && isHlc(r.t) && typeof r.ref === 'object' && r.ref !== null && typeof r.ref.sfp === 'string';
};

/**
 * Remote records that matched no local source (§6.2): kept, one per register (the newest), until a source with the
 * same fingerprint is added, then handed over with `take`. Runs off the cold-start and zapping paths only.
 */
export class PendingStore {
  private readonly max: number;

  constructor(private readonly storage: Storage, opts: { max?: number } = {}) {
    this.max = opts.max ?? PENDING_MAX;
  }

  async add(records: readonly SyncRecord[]): Promise<void> {
    if (!records.length) return;
    const all = await this.all();
    const changed = new Map<string, SyncRecord>();
    for (const r of records) {
      const key = registerKey(r);
      if (!wins(r, changed.get(key) ?? all.get(key))) continue;
      changed.set(key, r);
      all.set(key, r);
    }
    const drop: string[] = [];
    if (all.size > this.max) {
      const oldest = [...all].sort((a, b) => (a[1].t < b[1].t ? -1 : a[1].t > b[1].t ? 1 : 0));
      for (const [key] of oldest.slice(0, all.size - this.max)) {
        drop.push(key);
        changed.delete(key);
      }
    }
    await this.storage.putSyncMeta([...changed].map(([key, value]) => ({ scope: PENDING_SCOPE, key, value })));
    await this.storage.deleteSyncMeta(PENDING_SCOPE, drop);
  }

  /** Removes and returns the pending records of fingerprint `sfp` (a source with it was just added). */
  async take(sfp: string): Promise<SyncRecord[]> {
    const out: SyncRecord[] = [];
    const keys: string[] = [];
    for (const [key, r] of await this.all()) {
      if (r.ref.sfp !== sfp) continue;
      out.push(r);
      keys.push(key);
    }
    await this.storage.deleteSyncMeta(PENDING_SCOPE, keys);
    return out;
  }

  /** Forgets tombstones older than 90 days; returns how many went. */
  async prune(now: number): Promise<number> {
    const keys: string[] = [];
    for (const [key, r] of await this.all()) if (expiredTombstone(r, now)) keys.push(key);
    await this.storage.deleteSyncMeta(PENDING_SCOPE, keys);
    return keys.length;
  }

  async count(): Promise<number> {
    return (await this.all()).size;
  }

  private async all(): Promise<Map<string, SyncRecord>> {
    const out = new Map<string, SyncRecord>();
    for (const e of await this.storage.listSyncMeta(PENDING_SCOPE)) if (isRecord(e.value)) out.set(e.key, e.value);
    return out;
  }
}
