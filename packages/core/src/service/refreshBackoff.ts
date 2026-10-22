import { SourceNetworkError, StorageWriteError } from '../errors.ts';
import { REFUSAL_STATUSES } from '../net/refusalGuard.ts';
import type { Storage } from '../storage.ts';

/** What an automatic refresh fetches: each has its own backoff record. */
export type RefreshWhat = 'playlist' | 'epg' | 'vod:movie' | 'vod:series';
export const REFRESH_WHATS: readonly RefreshWhat[] = ['playlist', 'epg', 'vod:movie', 'vod:series'];

/** After 1, 2, 3+ failed refreshes in a row, the next automatic one waits at least this long (the last step repeats). */
export const REFRESH_BACKOFF_MS: readonly number[] = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];

/** `storage`: the fetch worked but the result could not be saved, so even a screen with nothing to show must not fetch again. */
export interface RefreshFailRecord { count: number; at: number; storage?: true }

export const refreshFailKey = (sourceId: string, what: RefreshWhat) => `refreshFail:${sourceId}:${what}`;

function isRecord(v: unknown): v is RefreshFailRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<RefreshFailRecord>;
  return typeof r.count === 'number' && Number.isFinite(r.count) && r.count > 0 && typeof r.at === 'number' && Number.isFinite(r.at);
}

/**
 * Whether a failed refresh counts toward the backoff: the source failed to answer usefully (unreachable, timed out, a
 * non-refusal HTTP error, an unreadable answer). Refusals belong to the refusal guard, and a refresh the guard stopped
 * before sending, or one that was cancelled, said nothing about the source. A list that downloaded but could not be
 * saved counts too: downloading it again at the next launch would fail the same way and load the source for nothing.
 */
export function countsAsRefreshFailure(err: unknown): boolean {
  if (err instanceof StorageWriteError) return true;  // quota or not: the write failed, so a fetch right away would too (the `storage` mark is for quota only)
  return err instanceof SourceNetworkError && (err.status === undefined || !REFUSAL_STATUSES.has(err.status));
}

/** Records one more failed refresh of `what` (best effort: a storage error never hides the refresh's own error). */
export async function recordRefreshFailure(storage: Storage, sourceId: string, what: RefreshWhat, now: number, reason?: 'storage'): Promise<void> {
  try {
    const prev = await storage.getMeta<unknown>(refreshFailKey(sourceId, what));
    const count = isRecord(prev) ? prev.count + 1 : 1;
    await storage.setMeta(refreshFailKey(sourceId, what), { count, at: now, ...(reason === 'storage' ? { storage: true as const } : {}) } satisfies RefreshFailRecord);
  } catch {
    // Best effort.
  }
}

/** A successful refresh of `what` clears its record (best effort: a storage error never fails the refresh). */
export async function clearRefreshFailure(storage: Storage, sourceId: string, what: RefreshWhat): Promise<void> {
  const key = refreshFailKey(sourceId, what);
  try {
    if ((await storage.getMeta<unknown>(key)) != null) await storage.setMeta(key, null);
  } catch {
    // Best effort: a leftover record only delays the next automatic refresh.
  }
}

/**
 * Whether the next automatic refresh of `what` must still wait after a failure. A clock that went back before the
 * failure does not hold the refresh off. `foreground` (the screen has nothing to show) only waits after a storage
 * failure: that fetch would be thrown away again.
 */
export async function refreshBackedOff(
  storage: Storage, sourceId: string, what: RefreshWhat, now: number, opts: { foreground?: boolean } = {},
): Promise<boolean> {
  const rec = await storage.getMeta<unknown>(refreshFailKey(sourceId, what));
  if (!isRecord(rec)) return false;
  if (opts.foreground && rec.storage !== true) return false;
  const wait = REFRESH_BACKOFF_MS[Math.min(rec.count, REFRESH_BACKOFF_MS.length) - 1]!;
  return now >= rec.at && now - rec.at < wait;
}
