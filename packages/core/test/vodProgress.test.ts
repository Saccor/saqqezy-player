import { describe, expect, test } from 'vitest';
import {
  applyProgress, clearProgress, continueMovies, continueSeries, emptyUserState, episodeLabel, isInProgress,
  nextEpisode, resumeMs, setFavourite, setTracks, setWatched,
} from '../src/vod/progress.ts';
import type { Season, VodUserRecord, VodUserState } from '../src/vod/types.ts';

const MIN = 60_000;
const H = 60 * MIN;

describe('applyProgress', () => {
  test('in progress from 60 s, watched from 92 %', () => {
    const a = applyProgress(undefined, 30_000, H, 1);
    expect(a).toMatchObject({ position: 30_000, duration: H, watched: false, updatedAt: 1 });
    expect(isInProgress(a)).toBe(false);
    const b = applyProgress(a, 10 * MIN, H, 2);
    expect(isInProgress(b)).toBe(true);
    expect(resumeMs(b)).toBe(10 * MIN);
    const c = applyProgress(b, 0.92 * H, H, 3);
    expect(c).toMatchObject({ watched: true, position: 0 });
    expect(resumeMs(c)).toBe(0);
  });

  test('re-watching past 60 s clears watched; a short scrub keeps it', () => {
    const w = setWatched(undefined, true, 1);
    expect(applyProgress(w, 20_000, H, 2)).toMatchObject({ watched: true, position: 0 });
    expect(applyProgress(w, 5 * MIN, H, 3)).toMatchObject({ watched: false, position: 5 * MIN });
  });

  test('unknown duration keeps the previous one; favourites and tracks survive', () => {
    const fav = setTracks(setFavourite(undefined, true), { audio: 'eng' });
    const s = applyProgress({ ...fav, duration: H }, 5 * MIN, 0, 9);
    expect(s).toMatchObject({ duration: H, favourite: true, audio: 'eng' });
  });

  test('series pointer is stored', () => {
    const p = { id: 'x:s1', season: 1, episode: 2, next: { id: 'x:e3', season: 1, episode: 3 } };
    expect(applyProgress(undefined, 5 * MIN, H, 1, p).series).toEqual(p);
  });
});

describe('setWatched, clearProgress, setFavourite', () => {
  test('setWatched bumps updatedAt and clears position', () => {
    expect(setWatched({ ...emptyUserState(), position: 5 * MIN }, false, 7)).toMatchObject({ watched: false, position: 0, updatedAt: 7 });
  });
  test('clearProgress keeps watched, drops position and next pointer', () => {
    const s: VodUserState = { ...emptyUserState(), position: 5 * MIN, watched: false, updatedAt: 4, series: { id: 's', season: 1, episode: 1, next: { id: 'n', season: 1, episode: 2 } } };
    expect(clearProgress(s)).toMatchObject({ position: 0, updatedAt: 4, series: { id: 's', season: 1, episode: 1 } });
    expect(clearProgress(s).series?.next).toBeUndefined();
  });
  test('setFavourite does not bump updatedAt', () => {
    expect(setFavourite({ ...emptyUserState(), updatedAt: 3 }, true)).toMatchObject({ favourite: true, updatedAt: 3 });
  });
});

describe('continue watching', () => {
  const rec = (itemId: string, s: Partial<VodUserState>): VodUserRecord => ({ itemId, state: { ...emptyUserState(), duration: H, ...s } });

  test('movies: in progress only, newest first, capped; episodes and favourites excluded', () => {
    const records = [
      rec('m1', { position: 5 * MIN, updatedAt: 1 }),
      rec('m2', { position: 5 * MIN, updatedAt: 3 }),
      rec('m3', { watched: true, updatedAt: 9 }),
      rec('m4', { favourite: true }),
      rec('e1', { position: 5 * MIN, updatedAt: 5, series: { id: 's1', season: 1, episode: 1 } }),
    ];
    expect(continueMovies(records)).toEqual(['m2', 'm1']);
    expect(continueMovies(records, 1)).toEqual(['m2']);
  });

  test('series: latest episode per series, resume or next, newest first', () => {
    const records = [
      rec('e11', { watched: true, updatedAt: 1, series: { id: 'A', season: 1, episode: 1, next: { id: 'e12', season: 1, episode: 2 } } }),
      rec('e12', { position: 7 * MIN, updatedAt: 2, series: { id: 'A', season: 1, episode: 2 } }),
      rec('b3', { watched: true, updatedAt: 5, series: { id: 'B', season: 2, episode: 3, next: { id: 'b4', season: 2, episode: 4 } } }),
      rec('c9', { watched: true, updatedAt: 6, series: { id: 'C', season: 1, episode: 9 } }),
    ];
    expect(continueSeries(records)).toEqual([
      { seriesId: 'B', episodeId: 'b4', season: 2, episode: 4, resumeMs: 0 },
      { seriesId: 'A', episodeId: 'e12', season: 1, episode: 2, resumeMs: 7 * MIN },
    ]);
  });
});

describe('episodes', () => {
  const seasons: Season[] = [
    { number: 1, name: 'Season 1', episodes: [{ id: 'a', season: 1, episode: 1, title: 'A' }, { id: 'b', season: 1, episode: 2, title: 'B' }] },
    { number: 2, name: 'Season 2', episodes: [{ id: 'c', season: 2, episode: 1, title: 'C' }] },
  ];
  test('nextEpisode crosses seasons and ends', () => {
    expect(nextEpisode(seasons, 'a')?.id).toBe('b');
    expect(nextEpisode(seasons, 'b')?.id).toBe('c');
    expect(nextEpisode(seasons, 'c')).toBeUndefined();
    expect(nextEpisode(seasons, 'zz')).toBeUndefined();
  });
  test('episodeLabel', () => {
    expect(episodeLabel(2, 4)).toBe('S2 · E4');
  });
});
