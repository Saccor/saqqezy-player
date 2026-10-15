import { describe, expect, test, vi } from 'vitest';
import type { VodTile } from '@iptv/app-api';
import { buildPosterMenu, runPosterAction, type PosterApi } from './posterMenuLogic.ts';

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
});
