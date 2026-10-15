import type { VodTile } from '@iptv/app-api';

/** The poster options menu. Pure: no Solid, no Lightning. */
export type PosterAction = 'favAdd' | 'favRemove' | 'watched' | 'unwatched' | 'removeContinue' | 'cancel';

export function buildPosterMenu(tile: VodTile, inContinue: boolean): { action: PosterAction; label: string }[] {
  const items: { action: PosterAction; label: string }[] = [
    tile.favourite ? { action: 'favRemove', label: 'Remove from favourites' } : { action: 'favAdd', label: 'Add to favourites' },
  ];
  // Series are marked watched per episode (Plan 5).
  if (tile.kind === 'movie') items.push(tile.watched ? { action: 'unwatched', label: 'Mark as unwatched' } : { action: 'watched', label: 'Mark as watched' });
  if (inContinue) items.push({ action: 'removeContinue', label: 'Remove from Continue watching' });
  items.push({ action: 'cancel', label: 'Cancel' });
  return items;
}

export interface PosterApi {
  setVodFavourite(id: string, on: boolean): Promise<void>;
  setVodWatched(id: string, on: boolean): Promise<void>;
  clearVodProgress(id: string): Promise<void>;
}

/** Runs the chosen action; true when something changed (the screen re-reads its rows). */
export async function runPosterAction(a: PosterAction, tile: VodTile, api: PosterApi): Promise<boolean> {
  switch (a) {
    case 'favAdd': await api.setVodFavourite(tile.id, true); return true;
    case 'favRemove': await api.setVodFavourite(tile.id, false); return true;
    case 'watched': await api.setVodWatched(tile.id, true); return true;
    case 'unwatched': await api.setVodWatched(tile.id, false); return true;
    case 'removeContinue': await api.clearVodProgress(tile.id); return true;
    case 'cancel': return false;
  }
}
