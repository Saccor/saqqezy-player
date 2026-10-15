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
  addProgrammes(sourceId: string, batch: Programme[]): Promise<void>;
  getProgrammes(sourceId: string, epgIds: string[], from: number, to: number): Promise<Programme[]>;
  /** Calls `fn` (synchronously) for every stored programme of `sourceId`, in no particular order. */
  forEachProgramme(sourceId: string, fn: (p: Programme) => void): Promise<void>;
  getVod(sourceId: string, kind: VodKind): Promise<VodList | undefined>;
  replaceVod(sourceId: string, kind: VodKind, list: VodList): Promise<void>;
  getVodUser(sourceId: string, itemId: string): Promise<VodUserState | undefined>;
  putVodUser(sourceId: string, itemId: string, state: VodUserState): Promise<void>;
  listVodUser(sourceId: string): Promise<VodUserRecord[]>;
  clearAll(): Promise<void>;
}

/** Longest programme we look back for when querying overlaps. */
export const MAX_PROGRAMME_MS = 24 * 3600_000;
