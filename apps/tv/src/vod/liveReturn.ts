/**
 * The live channel that was playing when Movies or Series opened (they stop the live stream). Home takes it when it
 * comes back, so Live TV resumes that channel. VOD stand-ins (`vod:` ids) are never remembered.
 */

/** The channel to remember when a VOD tab stops live playback: only a live channel that is actually playing. */
export function liveToRemember(currentId: string | undefined, statusKind: string | undefined): string | undefined {
  if (currentId === undefined || currentId.startsWith('vod:') || statusKind !== 'playing') return undefined;
  return currentId;
}

export interface LiveReturn {
  /** Remembers `id`; undefined keeps the earlier one (Movies to Series, or back from a VOD title). */
  remember(id: string | undefined): void;
  /** Reads and clears the remembered id. */
  take(): string | undefined;
}

export function createLiveReturn(): LiveReturn {
  let slot: string | undefined;
  return {
    remember(id) { if (id !== undefined) slot = id; },
    take() { const v = slot; slot = undefined; return v; },
  };
}

/** The app's slot: it lives as long as the page. */
export const liveReturn = createLiveReturn();
