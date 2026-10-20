import { MAX_PROGRAMME_MS, type Channel, type Programme, type SourceConfig, type Storage, type SyncMetaEntry, type VodKind, type VodList, type VodUserRecord, type VodUserState } from '@iptv/core';

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStorage implements Storage {
  private sources = new Map<string, SourceConfig>();
  private channels = new Map<string, Channel[]>();
  private meta = new Map<string, unknown>();
  private programmes = new Map<string, Programme[]>();
  private vod = new Map<string, VodList>();
  private vodUser = new Map<string, Map<string, VodUserState>>();
  private syncMeta = new Map<string, Map<string, unknown>>();

  async listSources() { return [...this.sources.values()].map(clone); }
  async putSource(source: SourceConfig) { this.sources.set(source.id, clone(source)); }

  async deleteSource(id: string) {
    this.sources.delete(id);
    this.channels.delete(id);
    this.programmes.delete(id);
    for (const key of [...this.meta.keys()]) if (key.endsWith(`:${id}`)) this.meta.delete(key);
    for (const key of [...this.vod.keys()]) if (key.startsWith(`${id}\u0000`)) this.vod.delete(key);
    this.vodUser.delete(id);
    this.syncMeta.delete(id);
  }

  async getChannels(sourceId: string) { return clone(this.channels.get(sourceId) ?? []); }
  async replaceChannels(sourceId: string, channels: Channel[]) { this.channels.set(sourceId, clone(channels)); }

  async getMeta<T>(key: string) { return clone(this.meta.get(key)) as T | undefined; }
  async setMeta(key: string, value: unknown) { this.meta.set(key, clone(value)); }

  async clearProgrammes(sourceId: string) { this.programmes.delete(sourceId); }
  async addProgrammes(sourceId: string, batch: Programme[]) {
    const list = this.programmes.get(sourceId) ?? [];
    for (const p of batch) list.push(clone(p));
    this.programmes.set(sourceId, list);
  }

  async getProgrammes(sourceId: string, epgIds: string[], from: number, to: number, lookBackMs = MAX_PROGRAMME_MS) {
    const wanted = new Set(epgIds);
    const earliest = from - lookBackMs;
    return (this.programmes.get(sourceId) ?? [])
      .filter((p) => wanted.has(p.epgId) && p.start >= earliest && p.start < to && p.stop > from)
      .sort((a, b) => (a.epgId < b.epgId ? -1 : a.epgId > b.epgId ? 1 : a.start - b.start))
      .map(clone);
  }

  async forEachProgramme(sourceId: string, fn: (p: Programme) => void) {
    for (const p of this.programmes.get(sourceId) ?? []) fn(clone(p));
  }

  async getVod(sourceId: string, kind: VodKind) { return clone(this.vod.get(`${sourceId}\u0000${kind}`)); }
  async replaceVod(sourceId: string, kind: VodKind, list: VodList) { this.vod.set(`${sourceId}\u0000${kind}`, clone(list)); }

  async getVodUser(sourceId: string, itemId: string) { return clone(this.vodUser.get(sourceId)?.get(itemId)); }
  async putVodUser(sourceId: string, itemId: string, state: VodUserState) {
    const m = this.vodUser.get(sourceId) ?? new Map<string, VodUserState>();
    m.set(itemId, clone(state));
    this.vodUser.set(sourceId, m);
  }
  async listVodUser(sourceId: string): Promise<VodUserRecord[]> {
    return [...(this.vodUser.get(sourceId) ?? new Map<string, VodUserState>()).entries()].map(([itemId, state]) => ({ itemId, state: clone(state) }));
  }

  async getSyncMeta(scope: string, key: string) { return clone(this.syncMeta.get(scope)?.get(key)); }
  async listSyncMeta(scope: string): Promise<SyncMetaEntry[]> {
    return [...(this.syncMeta.get(scope) ?? new Map<string, unknown>()).entries()].map(([key, value]) => ({ scope, key, value: clone(value) }));
  }
  async putSyncMeta(entries: SyncMetaEntry[]) {
    for (const { scope, key, value } of entries) {
      const m = this.syncMeta.get(scope) ?? new Map<string, unknown>();
      m.set(key, clone(value));
      this.syncMeta.set(scope, m);
    }
  }
  async deleteSyncMeta(scope: string, keys: string[]) {
    const m = this.syncMeta.get(scope);
    for (const k of keys) m?.delete(k);
  }

  async clearAll() {
    this.sources.clear();
    this.channels.clear();
    this.meta.clear();
    this.programmes.clear();
    this.vod.clear();
    this.vodUser.clear();
    this.syncMeta.clear();
  }
}
