import { BODY_IDLE_MS } from '../net/timeout.ts';
import { sanitizeSettings } from '../settings.ts';
import type { Storage } from '../storage.ts';
import type { FetchFn, SourceConfig, XtreamSourceConfig } from '../types.ts';
import { VodCatalog } from '../vod/catalog.ts';
import { fetchXtreamCatalog, xtreamVodApi } from '../vod/fetchXtream.ts';
import { emptyVodList, seasonsOf } from '../vod/list.ts';
import {
  applyProgress, clearProgress, setFavourite, setTracks, setWatched,
} from '../vod/progress.ts';
import type {
  Episode, MovieDetail, SeriesDetail, SeriesPointer, VodItem, VodKind, VodUserRecord, VodUserState,
} from '../vod/types.ts';
import { XtreamClient } from '../xtream/client.ts';

export interface VodServiceDeps {
  storage: Storage;
  fetch: FetchFn;
  now?: () => number;
  /** JSON body inactivity timeout (default `BODY_IDLE_MS`). */
  bodyIdleMs?: number;
}

const vodAtKey = (kind: VodKind, sourceId: string) => `vodAt:${kind}:${sourceId}`;

/** Movies and series for one app: catalogue refresh, details, stream URLs and local user state. */
export class VodService {
  private readonly storage: Storage;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly bodyIdleMs: number;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(deps: VodServiceDeps) {
    this.storage = deps.storage;
    this.fetchFn = deps.fetch;
    this.now = deps.now ?? Date.now;
    this.bodyIdleMs = deps.bodyIdleMs ?? BODY_IDLE_MS;
  }

  async loadCatalog(sourceId: string, kind: VodKind): Promise<VodCatalog> {
    return new VodCatalog(kind, (await this.storage.getVod(sourceId, kind)) ?? emptyVodList());
  }

  async fetchedAt(sourceId: string, kind: VodKind): Promise<number> {
    return (await this.storage.getMeta<number>(vodAtKey(kind, sourceId))) ?? 0;
  }

  /** Xtream only: M3U catalogues come with the playlist refresh. */
  async needsRefresh(sourceId: string, kind: VodKind): Promise<boolean> {
    const source = await this.source(sourceId);
    if (!source || source.kind !== 'xtream') return false;
    const at = await this.fetchedAt(sourceId, kind);
    if (!at) return true;
    const hours = sanitizeSettings(await this.storage.getMeta<unknown>('settings')).autoRefreshHours;
    if (hours === 0) return false;
    return this.now() - at > hours * 3600_000;
  }

  /**
   * Fetches and stores the catalogue (Xtream). A source removed meanwhile stores nothing; a cancel rejects with
   * `VodFetchCancelled` and stores nothing. One refresh per source and kind at a time.
   */
  refresh(
    sourceId: string, kind: VodKind, opts: { signal?: AbortSignal; onProgress?: (n: number) => void } = {},
  ): Promise<{ count: number; truncated: boolean }> {
    return this.withLock(`vod:${kind}:${sourceId}`, async () => {
      const source = await this.source(sourceId);
      if (!source) throw new Error(`Unknown source ${sourceId}`);
      if (source.kind !== 'xtream') {
        const list = await this.storage.getVod(sourceId, kind);
        return { count: list?.items.length ?? 0, truncated: list?.truncated === true };
      }
      const list = await fetchXtreamCatalog(xtreamVodApi(this.client(source), sourceId, kind), kind, opts);
      if (!(await this.source(sourceId))) return { count: 0, truncated: false };
      await this.storage.replaceVod(sourceId, kind, list);
      await this.storage.setMeta(vodAtKey(kind, sourceId), this.now());
      return { count: list.items.length, truncated: list.truncated === true };
    });
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
    return this.updateUser(sourceId, itemId, (prev) => applyProgress(prev, positionMs, durationMs, this.now(), series));
  }

  async setFavourite(sourceId: string, itemId: string, on: boolean): Promise<void> {
    await this.updateUser(sourceId, itemId, (prev) => setFavourite(prev, on));
  }

  async setWatched(sourceId: string, itemId: string, on: boolean): Promise<void> {
    await this.updateUser(sourceId, itemId, (prev) => setWatched(prev, on, this.now()));
  }

  async clearProgress(sourceId: string, itemId: string): Promise<void> {
    await this.updateUser(sourceId, itemId, (prev) => clearProgress(prev));
  }

  async setTracks(sourceId: string, itemId: string, tracks: { audio?: string; subtitle?: string }): Promise<void> {
    await this.updateUser(sourceId, itemId, (prev) => setTracks(prev, tracks));
  }

  /** Read-modify-write under a per-source lock; a removed source drops the write. */
  private updateUser(sourceId: string, itemId: string, fn: (prev: VodUserState | undefined) => VodUserState): Promise<VodUserState | undefined> {
    return this.withLock(`vodUser:${sourceId}`, async () => {
      if (!(await this.source(sourceId))) return undefined;
      const next = fn(await this.storage.getVodUser(sourceId, itemId));
      await this.storage.putVodUser(sourceId, itemId, next);
      return next;
    });
  }

  private async source(id: string): Promise<SourceConfig | undefined> {
    return (await this.storage.listSources()).find((s) => s.id === id);
  }

  private client(s: XtreamSourceConfig): XtreamClient {
    return new XtreamClient(s, this.fetchFn, { idleMs: this.bodyIdleMs });
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
