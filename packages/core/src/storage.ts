import type { Channel, Programme, SourceConfig } from './types.ts';
import type { VodKind, VodList, VodUserRecord, VodUserState } from './vod/types.ts';

export interface Storage {
  listSources(): Promise<SourceConfig[]>;
  putSource(source: SourceConfig): Promise<void>;
  deleteSource(id: string): Promise<void>;
  getChannels(sourceId: string): Promise<Channel[]>;
  replaceChannels(sourceId: string, channels: Channel[]): Promise<void>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
  clearProgrammes(sourceId: string): Promise<void>;
  /** Takes the batch over: an implementation may tag and store its objects instead of copying them. */
  addProgrammes(sourceId: string, batch: Programme[]): Promise<void>;
  /**
   * Programmes of `epgIds` that overlap [`from`, `to`), sorted by epgId then start. Only programmes that start at most
   * `lookBackMs` (default `MAX_PROGRAMME_MS`) before `from` are looked at: pass the longest stored programme.
   * Records may carry the storage's own fields (IndexedDB's `sourceId`) besides the Programme ones.
   */
  getProgrammes(sourceId: string, epgIds: string[], from: number, to: number, lookBackMs?: number): Promise<Programme[]>;
  /** Calls `fn` (synchronously) for every stored programme of `sourceId`, in no particular order (records as above). */
  forEachProgramme(sourceId: string, fn: (p: Programme) => void): Promise<void>;
  getVod(sourceId: string, kind: VodKind): Promise<VodList | undefined>;
  replaceVod(sourceId: string, kind: VodKind, list: VodList): Promise<void>;
  getVodUser(sourceId: string, itemId: string): Promise<VodUserState | undefined>;
  putVodUser(sourceId: string, itemId: string, state: VodUserState): Promise<void>;
  listVodUser(sourceId: string): Promise<VodUserRecord[]>;
  /** One sync sidecar record (`syncMeta` store): clocks, pending records. Undefined when absent. */
  getSyncMeta(scope: string, key: string): Promise<unknown>;
  /** Every sync sidecar record of `scope`, in no particular order. */
  listSyncMeta(scope: string): Promise<SyncMetaEntry[]>;
  /** Writes all entries at once (one transaction). */
  putSyncMeta(entries: SyncMetaEntry[]): Promise<void>;
  deleteSyncMeta(scope: string, keys: string[]): Promise<void>;
  clearAll(): Promise<void>;
}

/**
 * A sync sidecar record. `scope` is a source id (its clocks, removed with the source) or a reserved scope starting with
 * `#` (`#clock`, `#pending`), which outlives sources. Values are small JSON values; hot structures never live here.
 */
export interface SyncMetaEntry { scope: string; key: string; value: unknown }

/** Longest programme we look back for when querying overlaps (the default, and the cap of a recorded look-back). */
export const MAX_PROGRAMME_MS = 24 * 3600_000;
