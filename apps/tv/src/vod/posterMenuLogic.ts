import type { EpisodeView, VodTile } from '@iptv/app-api';
import type { SeriesPointer } from '@iptv/core';
import { favToggleLabel } from '../copy.ts';

/** The poster options menu. Pure: no Solid, no Lightning. */
export type PosterAction = 'play' | 'favAdd' | 'favRemove' | 'watched' | 'unwatched' | 'removeContinue' | 'cancel';

/** Play resumes a started movie (progress) or a series in Continue watching (its episode `badge`): say Resume. */
export function buildPosterMenu(tile: VodTile, inContinue: boolean): { action: PosterAction; label: string }[] {
  const resumes = (tile.progress !== undefined && tile.progress > 0) || tile.badge !== undefined;
  const items: { action: PosterAction; label: string }[] = [
    { action: 'play', label: resumes ? 'Resume' : 'Play' },
    { action: tile.favourite ? 'favRemove' : 'favAdd', label: favToggleLabel(tile.favourite) },
  ];
  // Series are marked watched per episode (Plan 5).
  if (tile.kind === 'movie') items.push(tile.watched ? { action: 'unwatched', label: 'Mark as unwatched' } : { action: 'watched', label: 'Mark as watched' });
  if (inContinue) items.push({ action: 'removeContinue', label: 'Remove from Continue watching' });
  items.push({ action: 'cancel', label: 'Cancel' });
  return items;
}

/** An episode card's menu: watched or unwatched, and Remove from Continue watching when it has progress. */
export function buildEpisodeMenu(ep: EpisodeView): { action: PosterAction; label: string }[] {
  const items: { action: PosterAction; label: string }[] = [
    ep.watched ? { action: 'unwatched', label: 'Mark as unwatched' } : { action: 'watched', label: 'Mark as watched' },
  ];
  if (ep.progress !== undefined) items.push({ action: 'removeContinue', label: 'Remove from Continue watching' });
  items.push({ action: 'cancel', label: 'Cancel' });
  return items;
}

export interface PosterApi {
  setVodFavourite(id: string, on: boolean): Promise<void>;
  setVodWatched(id: string, on: boolean, series?: SeriesPointer): Promise<void>;
  clearVodProgress(id: string): Promise<void>;
  clearSeriesContinue(seriesId: string): Promise<void>;
}

/** Runs the chosen action; true when something changed (the screen re-reads its rows). */
export async function runPosterAction(a: PosterAction, tile: VodTile, api: PosterApi): Promise<boolean> {
  switch (a) {
    case 'favAdd': await api.setVodFavourite(tile.id, true); return true;
    case 'favRemove': await api.setVodFavourite(tile.id, false); return true;
    case 'watched': await api.setVodWatched(tile.id, true); return true;
    case 'unwatched': await api.setVodWatched(tile.id, false); return true;
    case 'removeContinue':
      // A series leaves Continue watching as a whole; a movie drops its progress.
      if (tile.kind === 'series') await api.clearSeriesContinue(tile.id);
      else await api.clearVodProgress(tile.id);
      return true;
    // Play opens the player; the menu runner (`createPosterMenu`) starts it, nothing is saved here.
    case 'play':
    case 'cancel': return false;
  }
}

/** Runs an episode card's action (watched state carries the series pointer); true when something changed. */
export async function runEpisodeAction(a: PosterAction, ep: EpisodeView, seriesId: string, api: PosterApi): Promise<boolean> {
  const pointer: SeriesPointer = { id: seriesId, season: ep.season, episode: ep.episode };
  switch (a) {
    case 'watched': await api.setVodWatched(ep.id, true, pointer); return true;
    case 'unwatched': await api.setVodWatched(ep.id, false, pointer); return true;
    case 'removeContinue': await api.clearVodProgress(ep.id); return true;
    default: return false;
  }
}
