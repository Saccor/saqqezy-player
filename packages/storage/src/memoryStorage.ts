import type { Channel, Programme, SourceConfig, Storage } from '@iptv/core';

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStorage implements Storage {
  private sources = new Map<string, SourceConfig>();
  private channels = new Map<string, Channel[]>();
  private meta = new Map<string, unknown>();
  private programmes = new Map<string, Programme[]>();

  async listSources() { return [...this.sources.values()].map(clone); }
  async putSource(source: SourceConfig) { this.sources.set(source.id, clone(source)); }

  async deleteSource(id: string) {
    this.sources.delete(id);
    this.channels.delete(id);
    this.programmes.delete(id);
    for (const key of [...this.meta.keys()]) if (key.endsWith(`:${id}`)) this.meta.delete(key);
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

  async getProgrammes(sourceId: string, epgIds: string[], from: number, to: number) {
    const wanted = new Set(epgIds);
    return (this.programmes.get(sourceId) ?? [])
      .filter((p) => wanted.has(p.epgId) && p.start < to && p.stop > from)
      .sort((a, b) => (a.epgId < b.epgId ? -1 : a.epgId > b.epgId ? 1 : a.start - b.start))
      .map(clone);
  }

  async forEachProgramme(sourceId: string, fn: (p: Programme) => void) {
    for (const p of this.programmes.get(sourceId) ?? []) fn(clone(p));
  }

  async clearAll() {
    this.sources.clear();
    this.channels.clear();
    this.meta.clear();
    this.programmes.clear();
  }
}
