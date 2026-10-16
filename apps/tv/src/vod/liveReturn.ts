/**
 * The live channel that was playing when Movies or Series opened (they stop the live stream). Home takes it when it
 * comes back, so Live TV resumes that channel. VOD stand-ins (`vod:` ids) are never remembered, and a channel is
 * only given back to the source it came from.
 */

/** Live states worth resuming: a channel that plays, or is on its way (a failed one, or one held with no status, is not). */
const RESUMABLE = new Set(['playing', 'loading', 'reconnecting']);

/** The channel to remember when a VOD tab stops live playback. */
export function liveToRemember(currentId: string | undefined, statusKind: string | undefined): string | undefined {
  if (currentId === undefined || currentId.startsWith('vod:') || statusKind === undefined || !RESUMABLE.has(statusKind)) return undefined;
  return currentId;
}

export interface LiveReturn {
  /** Remembers `id` of source `sourceId`; an undefined id keeps the earlier one (Movies to Series, or back from a VOD title). */
  remember(id: string | undefined, sourceId: string | undefined): void;
  /** Reads and clears the remembered id; undefined when it belongs to another source than `sourceId`. */
  take(sourceId: string | undefined): string | undefined;
}

export function createLiveReturn(): LiveReturn {
  let slot: { id: string; sourceId: string } | undefined;
  return {
    remember(id, sourceId) {
      if (id !== undefined && sourceId !== undefined) slot = { id, sourceId };
    },
    take(sourceId) {
      const v = slot;
      slot = undefined;
      return v && sourceId !== undefined && v.sourceId === sourceId ? v.id : undefined;
    },
  };
}

/** The app's slot: it lives as long as the page. */
export const liveReturn = createLiveReturn();
