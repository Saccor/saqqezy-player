/**
 * What multiview learned about each source's streams, on this device only (spec 2026-10-20-multiview §5.4, §5.7): the
 * lowest window count a source refused at, and the most windows seen playing at once. Numbers keyed by source id;
 * never URLs or account data. It informs the copy and Diagnostics; it never blocks a window.
 */
const KEY = 'iptv.connections';

interface Entry { refusedAt?: number; maxSeen?: number }

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export interface ConnectionMemory {
  refusedAt(sourceId: string): number | undefined;
  /** The source refused (or cut) window `k`: keeps the lowest k. */
  learn(sourceId: string, k: number): void;
  maxSeen(sourceId: string): number;
  /** `n` windows of this source played at once. */
  seen(sourceId: string, n: number): void;
}

export function createConnectionMemory(store: () => Store | undefined): ConnectionMemory {
  let cache: Record<string, Entry> | undefined;
  const all = (): Record<string, Entry> => {
    if (cache) return cache;
    cache = {};
    try {
      const parsed: unknown = JSON.parse(store()?.getItem(KEY) ?? '{}');
      if (parsed && typeof parsed === 'object') {
        for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
          const e = (v ?? {}) as Entry;
          const clean: Entry = {};
          if (Number.isInteger(e.refusedAt)) clean.refusedAt = e.refusedAt!;
          if (Number.isInteger(e.maxSeen)) clean.maxSeen = e.maxSeen!;
          cache[id] = clean;
        }
      }
    } catch {
      // Unreadable: start empty.
    }
    return cache;
  };
  const save = () => {
    try {
      store()?.setItem(KEY, JSON.stringify(all()));
    } catch {
      // Storage full or blocked: it still holds for this session.
    }
  };
  const entry = (id: string): Entry => (all()[id] ??= {});
  return {
    refusedAt: (id) => all()[id]?.refusedAt,
    learn(id, k) {
      const e = entry(id);
      if (e.refusedAt === undefined || k < e.refusedAt) {
        e.refusedAt = k;
        save();
      }
    },
    maxSeen: (id) => all()[id]?.maxSeen ?? 0,
    seen(id, n) {
      const e = entry(id);
      if (n > (e.maxSeen ?? 0)) {
        e.maxSeen = n;
        save();
      }
    },
  };
}
