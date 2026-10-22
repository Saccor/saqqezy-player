import { SourceNetworkError, StorageWriteError, storageFullMessage } from '../errors.ts';
import { BODY_IDLE_MS } from '../net/timeout.ts';
import { sanitizeSettings } from '../settings.ts';
import type { Storage } from '../storage.ts';
import type { FetchFn, SourceConfig, XtreamSourceConfig } from '../types.ts';
import { VodCatalog } from '../vod/catalog.ts';
import { fetchXtreamCatalog, VodFetchCancelled, xtreamVodApi } from '../vod/fetchXtream.ts';
import { emptyVodList, seasonsOf } from '../vod/list.ts';
import {
  applyVodOps, normalizeVodLayout, vodLayoutKey, type VodApplyResult, type VodLayout, type VodLayoutOp,
} from '../vod/layout.ts';
import {
  applyProgress, clearProgress, setFavourite, setTracks, setWatched,
} from '../vod/progress.ts';
import type {
  Episode, MovieDetail, SeriesDetail, SeriesPointer, VodItem, VodKind, VodList, VodUserRecord, VodUserState,
} from '../vod/types.ts';
import { XtreamClient, normalizeServer } from '../xtream/client.ts';
import type { RefusalGuard } from '../net/refusalGuard.ts';
import { SyncClock } from '../sync/clock.ts';
import { applyVodRestore, type VodRestore } from '../sync/snapshot.ts';
import { SYNC_KIND, clockKey, pairKey, type SyncKind } from '../sync/keys.ts';
import { clearRefreshFailure, countsAsRefreshFailure, recordRefreshFailure, refreshBackedOff } from './refreshBackoff.ts';

export interface VodServiceDeps {
  storage: Storage;
  fetch: FetchFn;
  now?: () => number;
  /** JSON body inactivity timeout (default `BODY_IDLE_MS`). */
  bodyIdleMs?: number;
  /**
   * The source service's refusal guard (`SourceService.guard`): catalogue and detail requests then wait out a
   * source's refusal cooldown like every other request (`SourceRefusedError`, nothing sent) and their answers feed it.
   */
  guard?: RefusalGuard;
  /** Pacing of the per-category fallback (default `VOD_FALLBACK_GAP_MS`; tests use 0). */
  fallbackGapMs?: number;
  /** Sync clock stamped by every user write (default: one built on `storage`). Share the source service's. */
  syncClock?: SyncClock;
}

const vodAtKey = (kind: VodKind, sourceId: string) => `vodAt:${kind}:${sourceId}`;
// Keys end in the source id, so storage's per-source cleanup removes them with the source.
const vodSplitKey = (kind: VodKind, sourceId: string) => `vodSplit:${kind}:${sourceId}`;
const vodPickKey = (kind: VodKind, sourceId: string) => `vodPick:${kind}:${sourceId}`;
/** Remembered version picks kept per source and kind. */
export const VOD_PICKS_MAX = 2000;

/** Movies and series for one app: catalogue refresh, details, stream URLs and local user state. */
export class VodService {
  private readonly storage: Storage;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly bodyIdleMs: number;
  private readonly guard: RefusalGuard | undefined;
  private readonly fallbackGapMs: number | undefined;
  private readonly locks = new Map<string, Promise<void>>();
  /** Stamped after each user write that took effect (never on reads, refreshes or playback start). */
  readonly syncClock: SyncClock;

  constructor(deps: VodServiceDeps) {
    this.storage = deps.storage;
    this.fetchFn = deps.fetch;
    this.now = deps.now ?? Date.now;
    this.bodyIdleMs = deps.bodyIdleMs ?? BODY_IDLE_MS;
    this.guard = deps.guard;
    this.fallbackGapMs = deps.fallbackGapMs;
    this.syncClock = deps.syncClock ?? new SyncClock({ storage: deps.storage, now: this.now });
  }

  async loadCatalog(sourceId: string, kind: VodKind): Promise<VodCatalog> {
    return new VodCatalog(kind, (await this.storage.getVod(sourceId, kind)) ?? emptyVodList());
  }

  /** The stored catalogue, or undefined when nothing was ever stored for this source and kind. */
  /** The stored list as read (no catalogue around it): for a one-off pass such as building the Search index. */
  storedList(sourceId: string, kind: VodKind): Promise<VodList | undefined> {
    return this.storage.getVod(sourceId, kind);
  }

  async storedCatalog(sourceId: string, kind: VodKind): Promise<VodCatalog | undefined> {
    const list = await this.storage.getVod(sourceId, kind);
    return list ? new VodCatalog(kind, list) : undefined;
  }

  async fetchedAt(sourceId: string, kind: VodKind): Promise<number> {
    return (await this.storage.getMeta<number>(vodAtKey(kind, sourceId))) ?? 0;
  }

  /**
   * Whether a fetch should run: Xtream only (M3U catalogues come with the playlist refresh), never fetched or stale.
   * A background refresh (stale-while-revalidate) is also held off after a failed one (15 min, 1 h, then 6 h);
   * `foreground` (the screen has nothing to show yet) skips that wait, except after a failed save (the list would be
   * downloaded again for nothing). `refresh` itself is never held off.
   */
  async needsRefresh(sourceId: string, kind: VodKind, opts: { foreground?: boolean } = {}): Promise<boolean> {
    const source = await this.source(sourceId);
    if (!source || source.kind !== 'xtream') return false;
    if (await refreshBackedOff(this.storage, sourceId, `vod:${kind}`, this.now(), { foreground: opts.foreground === true })) return false;
    const at = await this.fetchedAt(sourceId, kind);
    if (!at) return true;
    const hours = sanitizeSettings(await this.storage.getMeta<unknown>('settings')).autoRefreshHours;
    if (hours === 0) return false;
    return this.now() - at > hours * 3600_000;
  }

  /** Whether a fetch of `kind` is held off because its last result could not be saved on this device. */
  storageBlocked(sourceId: string, kind: VodKind): Promise<boolean> {
    return refreshBackedOff(this.storage, sourceId, `vod:${kind}`, this.now(), { foreground: true });
  }

  /**
   * Fetches and stores the catalogue (Xtream). A source removed or switched to another account (server or user name)
   * meanwhile, or a cancel, rejects with `VodFetchCancelled` and stores nothing.
   * A list that downloaded but could not be saved rejects with `StorageWriteError` (its `value` is the list, still good
   * for the session; an automatic fetch records the backoff).
   * An empty answer never replaces a non-empty stored catalogue (it rejects with `SourceNetworkError`). One refresh per source and kind at a time.
   */
  refresh(
    sourceId: string, kind: VodKind,
    opts: { signal?: AbortSignal; onProgress?: (n: number) => void; onSnapshot?: (list: VodList) => void; gap?: number; automatic?: boolean } = {},
  ): Promise<{ count: number; truncated: boolean; list: VodList }> {
    return this.withLock(`vod:${kind}:${sourceId}`, () => this.withBackoff(sourceId, kind, opts.automatic === true, async () => {
      const source = await this.source(sourceId);
      if (!source) throw new Error(`Unknown source ${sourceId}`);
      if (source.kind !== 'xtream') {
        const list = (await this.storage.getVod(sourceId, kind)) ?? emptyVodList();
        return { count: list.items.length, truncated: list.truncated === true, list };
      }
      const server = normalizeServer(source.server);
      const { automatic: _automatic, ...fetchOpts } = opts;
      if (fetchOpts.gap === undefined && this.fallbackGapMs !== undefined) fetchOpts.gap = this.fallbackGapMs;
      const list = await fetchXtreamCatalog(xtreamVodApi(this.client(source), sourceId, kind), kind, fetchOpts);
      // The account may have been removed or changed during the fetch: this list belongs to the old one.
      const now = await this.source(sourceId);
      if (!now || now.kind !== 'xtream' || normalizeServer(now.server) !== server || now.username !== source.username) {
        throw new VodFetchCancelled();
      }
      // A 200 with an error body parses to an empty list, and a partial list (some categories failed) may have lost
      // titles: either way, keep a bigger cached catalogue rather than shrink it.
      if (list.items.length === 0 || list.partial) {
        const stored = (await this.storage.getVod(sourceId, kind))?.items.length ?? 0;
        if (stored > list.items.length) throw new SourceNetworkError('Unexpected response from the provider.');
      }
      // Checked right before the write: an abort during the awaits above must store nothing.
      if (opts.signal?.aborted) throw new VodFetchCancelled();
      try {
        await this.storage.replaceVod(sourceId, kind, list);
      } catch (cause) {
        throw new StorageWriteError(`vod:${kind}`, cause, storageFullMessage(kind), list);
      }
      await this.storage.setMeta(vodAtKey(kind, sourceId), this.now());
      return { count: list.items.length, truncated: list.truncated === true, list };
    }));
  }

  /** An automatic fetch that failed (not a refusal or a cancel) records the backoff; any success clears it. */
  private async withBackoff<T>(sourceId: string, kind: VodKind, automatic: boolean, fn: () => Promise<T>): Promise<T> {
    let out: T;
    try {
      out = await fn();
    } catch (err) {
      if (automatic && countsAsRefreshFailure(err) && (await this.source(sourceId).catch(() => undefined))) {
        await recordRefreshFailure(this.storage, sourceId, `vod:${kind}`, this.now(), err instanceof StorageWriteError ? 'storage' : undefined);
      }
      throw err;
    }
    if (await this.source(sourceId).catch(() => undefined)) await clearRefreshFailure(this.storage, sourceId, `vod:${kind}`);
    return out;
  }

  async movieDetail(sourceId: string, item: VodItem): Promise<MovieDetail> {
    const source = await this.source(sourceId);
    if (source?.kind === 'xtream' && item.xid) return this.client(source).vodInfo(item.xid);
    return {};
  }

  async seriesDetail(sourceId: string, item: VodItem): Promise<SeriesDetail> {
    const source = await this.source(sourceId);
    if (source?.kind === 'xtream' && item.xid) return this.client(source).seriesInfo(sourceId, item.xid);
    const list = await this.storage.getVod(sourceId, 'series');
    return { seasons: seasonsOf(list?.episodes?.[item.id] ?? []) };
  }

  async streamUrl(sourceId: string, target: VodItem | Episode): Promise<string> {
    if (target.url) return target.url;
    const isItem = 'kind' in target;
    if (isItem && target.kind === 'series') throw new Error('A series is not playable; play one of its episodes.');
    const source = await this.source(sourceId);
    if (source?.kind !== 'xtream' || !target.xid) throw new Error('This title has no stream address.');
    const client = this.client(source);
    const ext = target.ext ?? 'mp4';
    return isItem ? client.movieUrl(target.xid, ext) : client.episodeUrl(target.xid, ext);
  }

  getUser(sourceId: string, itemId: string): Promise<VodUserState | undefined> {
    return this.storage.getVodUser(sourceId, itemId);
  }

  listUser(sourceId: string): Promise<VodUserRecord[]> {
    return this.storage.listVodUser(sourceId);
  }

  saveProgress(sourceId: string, itemId: string, positionMs: number, durationMs: number, series?: SeriesPointer): Promise<VodUserState | undefined> {
    return this.updateUser(sourceId, itemId, SYNC_KIND.progress, (prev) => applyProgress(prev, positionMs, durationMs, this.now(), series));
  }

  setFavourite(sourceId: string, itemId: string, on: boolean): Promise<VodUserState | undefined> {
    return this.updateUser(sourceId, itemId, SYNC_KIND.favourite, (prev) => setFavourite(prev, on));
  }

  setWatched(
    sourceId: string, itemId: string, on: boolean, series?: SeriesPointer, opts?: { keepUpdatedAt?: boolean },
  ): Promise<VodUserState | undefined> {
    return this.updateUser(sourceId, itemId, SYNC_KIND.progress, (prev) => setWatched(prev, on, this.now(), series, opts));
  }

  clearProgress(sourceId: string, itemId: string): Promise<VodUserState | undefined> {
    return this.updateUser(sourceId, itemId, SYNC_KIND.progress, (prev) => clearProgress(prev));
  }

  setTracks(sourceId: string, itemId: string, tracks: { audio?: string; subtitle?: string }): Promise<VodUserState | undefined> {
    return this.updateUser(sourceId, itemId, SYNC_KIND.tracks, (prev) => setTracks(prev, tracks));
  }

  /**
   * Read-modify-write under a per-source lock; a removed source drops the write. The write stamps the sync clock of
   * its register (`kind`), also when `updatedAt` stays (mark unwatched, `keepUpdatedAt`, Remove from Continue).
   */
  private updateUser(
    sourceId: string, itemId: string, kind: SyncKind, fn: (prev: VodUserState | undefined) => VodUserState,
  ): Promise<VodUserState | undefined> {
    return this.withLock(`vodUser:${sourceId}`, async () => {
      if (!(await this.source(sourceId))) return undefined;
      const next = fn(await this.storage.getVodUser(sourceId, itemId));
      await this.storage.putVodUser(sourceId, itemId, next);
      await this.syncClock.stamp(sourceId, [clockKey(kind, itemId)]);
      return next;
    });
  }

  /** Title keys the user shows separately ("Show separately"), per source and kind. */
  async getVodSplits(sourceId: string, kind: VodKind): Promise<Set<string>> {
    const v = await this.storage.getMeta<unknown>(vodSplitKey(kind, sourceId));
    return new Set(Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []);
  }

  setVodSplit(sourceId: string, kind: VodKind, key: string, on: boolean): Promise<Set<string>> {
    const meta = vodSplitKey(kind, sourceId);
    return this.withLock(meta, async () => {
      const keys = await this.getVodSplits(sourceId, kind);
      if (on) keys.add(key);
      else keys.delete(key);
      await this.storage.setMeta(meta, keys.size ? [...keys] : null);
      // A source removed meanwhile gets no clock (its scope would never be cleaned up).
      if (await this.source(sourceId)) await this.syncClock.stamp(sourceId, [clockKey(SYNC_KIND.split, pairKey(kind, key))]);
      return keys;
    });
  }

  /** The user's category layout (hidden, order, shown) per source and kind. */
  async getVodLayout(sourceId: string, kind: VodKind): Promise<VodLayout> {
    return normalizeVodLayout(await this.storage.getMeta<unknown>(vodLayoutKey(kind, sourceId)));
  }

  /** Applies category ops under a per-source lock and stamps what changed; a removed source writes nothing. */
  applyVodLayoutOps(sourceId: string, kind: VodKind, ops: readonly VodLayoutOp[]): Promise<VodApplyResult> {
    const meta = vodLayoutKey(kind, sourceId);
    return this.withLock(meta, async () => {
      const before = await this.getVodLayout(sourceId, kind);
      const res = applyVodOps(before, kind, ops);
      if (!res.changed) return res;
      if (!(await this.source(sourceId))) return { layout: before, changed: false, rejected: res.rejected, touched: [] };
      await this.storage.setMeta(meta, res.layout);
      if (res.touched.length) await this.syncClock.stamp(sourceId, res.touched);
      return res;
    });
  }

  /** The version the user picked per title key (item id), per source and kind. */
  async getVodPicks(sourceId: string, kind: VodKind): Promise<Record<string, string>> {
    const v = await this.storage.getMeta<unknown>(vodPickKey(kind, sourceId));
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, id] of Object.entries(v)) if (typeof id === 'string') out[k] = id;
    return out;
  }

  /** Remembers a pick; past `VOD_PICKS_MAX` titles the oldest pick goes. */
  setVodPick(sourceId: string, kind: VodKind, key: string, itemId: string): Promise<void> {
    const meta = vodPickKey(kind, sourceId);
    return this.withLock(meta, async () => {
      const picks = await this.getVodPicks(sourceId, kind);
      // Re-inserted last, so key order is oldest pick first.
      delete picks[key];
      picks[key] = itemId;
      const keys = Object.keys(picks);
      for (const old of keys.slice(0, Math.max(0, keys.length - VOD_PICKS_MAX))) delete picks[old];
      await this.storage.setMeta(meta, picks);
      if (await this.source(sourceId)) await this.syncClock.stamp(sourceId, [clockKey(SYNC_KIND.pick, pairKey(kind, key))]);
    });
  }

  /**
   * Writes restored VOD state (a backup or, later, sync): user records, picks and splits, under the same locks as the
   * user's own writes but without stamping (the restore adopts the stamps it brings). A removed source drops it all.
   */
  async applyRestore(
    sourceId: string,
    changes: {
      vod: readonly VodRestore[]; picks: readonly { kind: VodKind; key: string; itemId: string }[]; splits: readonly { kind: VodKind; key: string; on: boolean }[];
      /** Category ops per kind (backup of Your countries); applied without stamping, like the rest. */
      vodLayout?: readonly { kind: VodKind; ops: readonly VodLayoutOp[] }[];
    },
  ): Promise<void> {
    if (!(await this.source(sourceId))) return;
    if (changes.vod.length) {
      await this.withLock(`vodUser:${sourceId}`, async () => {
        for (const r of changes.vod) await this.storage.putVodUser(sourceId, r.itemId, applyVodRestore(await this.storage.getVodUser(sourceId, r.itemId), r));
      });
    }
    for (const kind of ['movie', 'series'] as const) {
      const picks = changes.picks.filter((p) => p.kind === kind);
      if (picks.length) {
        const meta = vodPickKey(kind, sourceId);
        await this.withLock(meta, async () => {
          const cur = await this.getVodPicks(sourceId, kind);
          for (const p of picks) {
            delete cur[p.key];
            cur[p.key] = p.itemId;
          }
          const keys = Object.keys(cur);
          for (const old of keys.slice(0, Math.max(0, keys.length - VOD_PICKS_MAX))) delete cur[old];
          await this.storage.setMeta(meta, cur);
        });
      }
      const splits = changes.splits.filter((p) => p.kind === kind);
      if (splits.length) {
        const meta = vodSplitKey(kind, sourceId);
        await this.withLock(meta, async () => {
          const keys = await this.getVodSplits(sourceId, kind);
          for (const sp of splits) {
            if (sp.on) keys.add(sp.key);
            else keys.delete(sp.key);
          }
          await this.storage.setMeta(meta, keys.size ? [...keys] : null);
        });
      }
      const cat = changes.vodLayout?.find((x) => x.kind === kind);
      if (cat?.ops.length) {
        const meta = vodLayoutKey(kind, sourceId);
        await this.withLock(meta, async () => {
          const res = applyVodOps(await this.getVodLayout(sourceId, kind), kind, cat.ops);
          if (res.changed) await this.storage.setMeta(meta, res.layout);
        });
      }
    }
  }

  private async source(id: string): Promise<SourceConfig | undefined> {
    return (await this.storage.listSources()).find((s) => s.id === id);
  }

  private client(s: XtreamSourceConfig): XtreamClient {
    return new XtreamClient(s, this.guard ? this.guard.wrap(s.id, this.fetchFn) : this.fetchFn, { idleMs: this.bodyIdleMs });
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(() => undefined, () => undefined);
    this.locks.set(key, tail);
    void tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return run;
  }
}
