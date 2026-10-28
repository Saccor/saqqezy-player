/**
 * What Live TV keeps across visits (the Player, catch-up, Search and the VOD screens re-create the screen): the
 * position, and the guide's row cache per source. Module state, read and written by the mounted Live TV only.
 */
import type { ChannelRow, ProgrammeLite } from '@iptv/app-api';
import { api, onEvent } from '../../api.ts';
import { EpgCache, type EpgChange } from '../epgCache.ts';
import { HOUR, MINUTE } from '../guideLogic.ts';

/**
 * Position across Live TV visits: the group, the focused channel and row, and the focused time. `catchupDays` is the
 * source's (`sourceId`) largest archive, so a remount opens the wide window at once; `fromCatchup` marks a return from
 * the catch-up player.
 */
export const memory: {
  groupId?: string; channelId?: string; row?: number; anchor?: number; viewStart?: number;
  sourceId?: string; catchupDays?: number; fromCatchup?: boolean;
} = {};

/**
 * The guide's row cache, kept across Live TV visits (per source), so Back from Movies, Start or the Player draws the
 * rows it had at once instead of reading every page again (the screen itself is re-created). The mounted screen
 * listens through `warmListener`. While no Live TV is mounted, a refresh, a layout change or a source switch drops it,
 * and a short-EPG update marks its channels stale; pages older than 15 min are read again anyway (`maxAgeMs`).
 */
/** Channels per guide page: the cache's page size and the row signals' page size must match. */
export const GUIDE_ROWS_PER_PAGE = 20;
let warm: { sourceId: string | undefined; cache: EpgCache<ChannelRow, ProgrammeLite> } | undefined;
let warmListener: (change: EpgChange) => void = () => undefined;
let awayOffs: Array<() => void> = [];

export function warmCache(sourceId: string | undefined, onChange: (change: EpgChange) => void): EpgCache<ChannelRow, ProgrammeLite> {
  for (const off of awayOffs) off();
  awayOffs = [];
  warmListener = onChange;
  if (warm?.sourceId !== sourceId || !warm) {
    warm = {
      sourceId,
      cache: new EpgCache<ChannelRow, ProgrammeLite>(
        (g, o, c, f, t) => api.getEpgRows(g, o, c, f, t),
        { rowsPerPage: GUIDE_ROWS_PER_PAGE, chunkMs: 3 * HOUR, maxEntries: 24, maxAgeMs: 15 * MINUTE, onChange: (change) => warmListener(change) },
      ),
    };
  }
  return warm.cache;
}

/** A remote source switch emptied `cache`: it now holds rows of `sourceId` (when it is still the kept cache). */
export function retagWarm(cache: EpgCache<ChannelRow, ProgrammeLite>, sourceId: string | undefined): void {
  if (warm?.cache === cache) warm.sourceId = sourceId;
}

/** Live TV unmounted: its rows are kept, and dropped if the data changes before the next visit. */
export function leaveWarm(cache: EpgCache<ChannelRow, ProgrammeLite>): void {
  warmListener = () => undefined;
  if (warm?.cache !== cache) return;
  const drop = () => { if (warm?.cache === cache) warm = undefined; };
  awayOffs = [
    onEvent('refreshed', drop),
    onEvent('layoutChanged', drop),
    onEvent('sourcesChanged', drop),
    onEvent('nowNextUpdated', (e) => { cache.staleChannels((e as { channelIds: string[] }).channelIds, (c) => c.id); }),
  ];
}
