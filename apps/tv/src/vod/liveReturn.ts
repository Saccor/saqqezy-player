/**
 * The live channel that was playing when Movies or Series opened, or when Search opened a movie or series (they stop
 * the live stream). Home takes it when it comes back, so Live TV resumes that channel. VOD stand-ins (`vod:` ids)
 * are never remembered, and a channel is only given back to the source it came from.
 */

/** Live states worth resuming: a channel that plays, or is on its way (a failed one, or one held with no status, is not). */
const RESUMABLE = new Set(['playing', 'loading', 'reconnecting']);

/** The channel to remember when a VOD tab stops live playback. */
export function liveToRemember(currentId: string | undefined, statusKind: string | undefined): string | undefined {
  if (currentId === undefined || currentId.startsWith('vod:') || statusKind === undefined || !RESUMABLE.has(statusKind)) return undefined;
  return currentId;
}

/** Who stopped live: a VOD tab (Home resumes on Back from it) or a title opened from Search (on any return to Home). */
export type LiveStoppedBy = 'tab' | 'search';

export interface LiveReturnEntry {
  id: string;
  /** Stopped by a title opened from Search: Home is revealed through Search's Back, without the tab hint. */
  fromSearch: boolean;
}

export interface LiveReturn {
  /** Remembers `id` of source `sourceId`; an undefined id keeps the earlier entry (Movies to Series, back from a VOD title, Search inside a VOD tab). */
  remember(id: string | undefined, sourceId: string | undefined, by?: LiveStoppedBy): void;
  /** Reads and clears the remembered channel; undefined when it belongs to another source than `sourceId`. */
  take(sourceId: string | undefined): LiveReturnEntry | undefined;
}

export function createLiveReturn(): LiveReturn {
  let slot: { id: string; sourceId: string; by: LiveStoppedBy } | undefined;
  return {
    remember(id, sourceId, by = 'tab') {
      if (id !== undefined && sourceId !== undefined) slot = { id, sourceId, by };
    },
    take(sourceId) {
      const v = slot;
      slot = undefined;
      return v && sourceId !== undefined && v.sourceId === sourceId ? { id: v.id, fromSearch: v.by === 'search' } : undefined;
    },
  };
}

/** The app's slot: it lives as long as the page. */
export const liveReturn = createLiveReturn();
