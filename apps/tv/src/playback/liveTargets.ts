import type { LiveTargetStore } from '@iptv/player';

export const LIVE_TARGETS_KEY = 'iptv.liveTargets';
const MAX_ENTRIES = 32;
const MAX_AGE_MS = 30 * 86_400_000;

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

interface Entry { r: number; at: number }

/**
 * The learned live-delay raise per source, on this device only (CLAUDE.md rule 7): keyed by the opaque source id,
 * never a URL or credentials, never synced. Every storage access is guarded; a failure behaves as empty.
 */
export function createLiveTargetStore(storage: () => StorageLike | undefined, now: () => number = Date.now): LiveTargetStore {
  const read = (): Record<string, Entry> => {
    try {
      const raw = storage()?.getItem(LIVE_TARGETS_KEY);
      const v: unknown = raw ? JSON.parse(raw) : {};
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Entry>) : {};
    } catch {
      return {};
    }
  };
  const write = (m: Record<string, Entry>) => {
    try {
      storage()?.setItem(LIVE_TARGETS_KEY, JSON.stringify(m));
    } catch {
      // quota or denied: the learned value is simply not kept
    }
  };
  return {
    get(key) {
      const e = read()[key];
      if (!e || typeof e.r !== 'number' || !Number.isFinite(e.r) || typeof e.at !== 'number') return undefined;
      return now() - e.at < MAX_AGE_MS ? e.r : undefined;
    },
    set(key, raiseS) {
      if (!Number.isFinite(raiseS)) return;
      const m = read();
      m[key] = { r: Math.round(raiseS * 100) / 100, at: now() };
      const keys = Object.keys(m).sort((a, b) => (m[b]?.at ?? 0) - (m[a]?.at ?? 0));
      for (const k of keys.slice(MAX_ENTRIES)) delete m[k];
      write(m);
    },
  };
}
