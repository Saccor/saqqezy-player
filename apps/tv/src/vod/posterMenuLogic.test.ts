import { describe, expect, test, vi } from 'vitest';
import type { EpisodeView, VodTile } from '@iptv/app-api';
import { buildEpisodeMenu, buildPosterMenu, runEpisodeAction, runPosterAction, type PosterApi } from './posterMenuLogic.ts';

const movie = (over: Partial<VodTile> = {}): VodTile => ({ id: 's:m1', kind: 'movie', title: 'Synthetic Film 1', categoryId: '1', watched: false, favourite: false, ...over });

describe('posterMenuLogic', () => {
  test('items follow the tile state and the row', () => {
    expect(buildPosterMenu(movie(), false).map((i) => i.action)).toEqual(['favAdd', 'watched', 'cancel']);
    expect(buildPosterMenu(movie({ favourite: true, watched: true }), true).map((i) => i.action))
      .toEqual(['favRemove', 'unwatched', 'removeContinue', 'cancel']);
    expect(buildPosterMenu(movie({ kind: 'series' }), false).map((i) => i.action)).toEqual(['favAdd', 'cancel']);
    expect(buildPosterMenu(movie(), false).map((i) => i.label)).toEqual(['Add to favourites', 'Mark as watched', 'Cancel']);
  });
  test('actions call the API', async () => {
    const api: PosterApi = {
      setVodFavourite: vi.fn(async () => undefined), setVodWatched: vi.fn(async () => undefined),
      clearVodProgress: vi.fn(async () => undefined), clearSeriesContinue: vi.fn(async () => undefined),
    };
    expect(await runPosterAction('favAdd', movie(), api)).toBe(true);
    expect(api.setVodFavourite).toHaveBeenCalledWith('s:m1', true);
    await runPosterAction('favRemove', movie(), api);
    expect(api.setVodFavourite).toHaveBeenLastCalledWith('s:m1', false);
    await runPosterAction('watched', movie(), api);
    expect(api.setVodWatched).toHaveBeenCalledWith('s:m1', true);
    await runPosterAction('unwatched', movie(), api);
    expect(api.setVodWatched).toHaveBeenLastCalledWith('s:m1', false);
    await runPosterAction('removeContinue', movie(), api);
    expect(api.clearVodProgress).toHaveBeenCalledWith('s:m1');
    expect(await runPosterAction('cancel', movie(), api)).toBe(false);
    expect(api.clearSeriesContinue).not.toHaveBeenCalled();
  });
  test('series tiles: favourite and Remove from Continue watching, never watched', () => {
    const series = movie({ id: 's:s1', kind: 'series', title: 'Synthetic Show 1' });
    expect(buildPosterMenu(series, false).map((i) => i.action)).toEqual(['favAdd', 'cancel']);
    expect(buildPosterMenu({ ...series, favourite: true, watched: true }, true)).toEqual([
      { action: 'favRemove', label: 'Remove from favourites' },
      { action: 'removeContinue', label: 'Remove from Continue watching' },
      { action: 'cancel', label: 'Cancel' },
    ]);
  });
  test('Remove from Continue watching on a series clears the series', async () => {
    const api: PosterApi = {
      setVodFavourite: vi.fn(async () => undefined), setVodWatched: vi.fn(async () => undefined),
      clearVodProgress: vi.fn(async () => undefined), clearSeriesContinue: vi.fn(async () => undefined),
    };
    expect(await runPosterAction('removeContinue', movie({ id: 's:s1', kind: 'series' }), api)).toBe(true);
    expect(api.clearSeriesContinue).toHaveBeenCalledWith('s:s1');
    expect(api.clearVodProgress).not.toHaveBeenCalled();
  });
  test('episode cards: watched or unwatched, and Remove from Continue watching only with progress', () => {
    const ep: EpisodeView = { id: 's:e2-4', season: 2, episode: 4, title: 'Synthetic Episode 4', watched: false };
    expect(buildEpisodeMenu(ep)).toEqual([
      { action: 'watched', label: 'Mark as watched' },
      { action: 'cancel', label: 'Cancel' },
    ]);
    expect(buildEpisodeMenu({ ...ep, watched: true, progress: 0.4 }).map((i) => i.action)).toEqual(['unwatched', 'removeContinue', 'cancel']);
  });
  test('episode actions pass the series pointer and clear the episode progress', async () => {
    const api: PosterApi = {
      setVodFavourite: vi.fn(async () => undefined), setVodWatched: vi.fn(async () => undefined),
      clearVodProgress: vi.fn(async () => undefined), clearSeriesContinue: vi.fn(async () => undefined),
    };
    const ep: EpisodeView = { id: 's:e2-4', season: 2, episode: 4, title: 'Synthetic Episode 4', watched: false, progress: 0.4 };
    expect(await runEpisodeAction('watched', ep, 's:s1', api)).toBe(true);
    expect(api.setVodWatched).toHaveBeenCalledWith('s:e2-4', true, { id: 's:s1', season: 2, episode: 4 });
    expect(await runEpisodeAction('unwatched', ep, 's:s1', api)).toBe(true);
    expect(api.setVodWatched).toHaveBeenLastCalledWith('s:e2-4', false, { id: 's:s1', season: 2, episode: 4 });
    expect(await runEpisodeAction('removeContinue', ep, 's:s1', api)).toBe(true);
    expect(api.clearVodProgress).toHaveBeenCalledWith('s:e2-4');
    expect(api.clearSeriesContinue).not.toHaveBeenCalled();
    expect(await runEpisodeAction('cancel', ep, 's:s1', api)).toBe(false);
    expect(await runEpisodeAction('favAdd', ep, 's:s1', api)).toBe(false);
    expect(api.setVodFavourite).not.toHaveBeenCalled();
  });
});
