import type { JournalEvent, JournalPersist } from '@iptv/player';
import type { StorageLike } from './liveTargets.ts';

export const JOURNAL_KEY = 'iptv.playbackJournal';

/**
 * The playback journal's storage, on this device only (CLAUDE.md rule 7): never synced or sent to the companion.
 * Every access is guarded; a failure behaves as empty.
 */
export function createJournalPersist(storage: () => StorageLike | undefined): JournalPersist {
  return {
    load() {
      try {
        return storage()?.getItem(JOURNAL_KEY) ?? null;
      } catch {
        return null;
      }
    },
    save(json) {
      try {
        storage()?.setItem(JOURNAL_KEY, json);
      } catch {
        // quota or denied: the journal stays in memory
      }
    },
  };
}

type NavigationPerf = { getEntriesByType?: (type: string) => ArrayLike<unknown> };
const NAV_TYPES = new Set(['navigate', 'reload', 'back_forward', 'prerender']);

/** The page-load journal event; `nav` says whether this load was a reload (left out where the engine can't tell). */
export function pageLoadEvent(now: number, perf: NavigationPerf | undefined): JournalEvent {
  let nav: string | undefined;
  try {
    const entry = perf?.getEntriesByType?.('navigation')[0] as { type?: unknown } | undefined;
    nav = typeof entry?.type === 'string' ? entry.type : undefined;
  } catch {
    nav = undefined;
  }
  if (nav !== undefined && NAV_TYPES.has(nav)) {
    return { k: 'page', t: now, what: 'load', nav: nav as 'navigate' | 'reload' | 'back_forward' | 'prerender' };
  }
  return { k: 'page', t: now, what: 'load' };
}
