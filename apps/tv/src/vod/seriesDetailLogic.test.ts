import { describe, expect, it } from 'vitest';
import type { EpisodeView, SeasonView, SeriesView } from '@iptv/app-api';
import { episodeMeta, initialFocus, primaryLabel, refocus, seasonLabel, seriesMeta } from './seriesDetailLogic.ts';

const ep = (season: number, episode: number, extra: Partial<EpisodeView> = {}): EpisodeView => ({
  id: `e${season}-${episode}`, season, episode, title: `Episode ${episode}`, watched: false, ...extra,
});
const season = (number: number, count: number, name = `Season ${number}`): SeasonView => ({
  number, name, episodes: Array.from({ length: count }, (_, i) => ep(number, i + 1)),
});
const view = (extra: Partial<SeriesView> = {}): SeriesView => ({
  tile: { id: 's1', kind: 'series', title: 'Sample Series', categoryId: 'c', watched: false, favourite: false },
  detail: null,
  seasons: [season(1, 3), season(2, 5)],
  ...extra,
});

describe('primaryLabel', () => {
  it('labels continue, start and unknown', () => {
    expect(primaryLabel({ episodeId: 'e2-4', season: 2, episode: 4, resumeMs: 5, mode: 'continue' })).toBe('Continue S2 · E4');
    expect(primaryLabel({ episodeId: 'e1-1', season: 1, episode: 1, resumeMs: 0, mode: 'start' })).toBe('Play S1 · E1');
    expect(primaryLabel(undefined)).toBe('Play');
  });
});

describe('initialFocus', () => {
  it('opens on the season and episode holding primary', () => {
    const v = view({ primary: { episodeId: 'e2-4', season: 2, episode: 4, resumeMs: 0, mode: 'continue' } });
    expect(initialFocus(v)).toEqual({ season: 1, episode: 3 });
  });
  it('is 0/0 without primary, with an unknown primary, or without seasons', () => {
    expect(initialFocus(view())).toEqual({ season: 0, episode: 0 });
    expect(initialFocus(view({ primary: { episodeId: 'zz', season: 9, episode: 9, resumeMs: 0, mode: 'start' } }))).toEqual({ season: 0, episode: 0 });
    expect(initialFocus(view({ seasons: [] }))).toEqual({ season: 0, episode: 0 });
  });
});

describe('episodeMeta', () => {
  it('shows number and runtime, omitting an unknown runtime', () => {
    expect(episodeMeta(ep(1, 4, { runtimeMin: 42 }))).toBe('E4 · 42 min');
    expect(episodeMeta(ep(1, 4))).toBe('E4');
    expect(episodeMeta(ep(1, 4, { runtimeMin: 0 }))).toBe('E4');
  });
});

describe('seasonLabel', () => {
  it('uses a real name, else Season N, and Specials for 0', () => {
    expect(seasonLabel({ number: 2, name: 'The Long Winter', episodes: [] })).toBe('The Long Winter');
    expect(seasonLabel({ number: 2, name: '2', episodes: [] })).toBe('Season 2');
    expect(seasonLabel({ number: 3, name: '', episodes: [] })).toBe('Season 3');
    expect(seasonLabel({ number: 0, name: 'Season 0', episodes: [] })).toBe('Specials');
  });
});

describe('seriesMeta', () => {
  it('joins the parts that exist', () => {
    const v = view({
      tile: { ...view().tile, year: 2021, rating: 7.86 },
      detail: { genre: 'Drama', ageRating: '12' },
      seasons: [season(1, 1), season(2, 1), season(3, 1)],
    });
    expect(seriesMeta(v)).toBe('2021 · 3 seasons · Drama · 12 · ★ 7.9');
  });
  it('omits missing parts and never prints undefined', () => {
    expect(seriesMeta(view({ seasons: [season(1, 1)] }))).toBe('1 season');
    expect(seriesMeta(view({ seasons: [] }))).toBe('');
    expect(seriesMeta(view({ detail: { genre: 'Drama' } }))).toContain('Drama');
    expect(seriesMeta(view())).not.toContain('undefined');
  });
});

describe('refocus', () => {
  it('keeps the episode by id after episodes were added before it', () => {
    const v = view({ seasons: [season(1, 3), { number: 2, name: 'Season 2', episodes: [ep(2, 0, { id: 'new' }), ...season(2, 5).episodes] }] });
    expect(refocus({ seasonNumber: 2, episodeId: 'e2-4' }, v)).toEqual({ season: 1, episode: 4 });
  });
  it('falls back to the same season at episode 0 when the episode is gone', () => {
    expect(refocus({ seasonNumber: 2, episodeId: 'gone' }, view())).toEqual({ season: 1, episode: 0 });
  });
  it('falls back to 0/0 when the season is gone or there are no seasons', () => {
    expect(refocus({ seasonNumber: 9, episodeId: 'gone' }, view())).toEqual({ season: 0, episode: 0 });
    expect(refocus({ seasonNumber: 1, episodeId: 'x' }, view({ seasons: [] }))).toEqual({ season: 0, episode: 0 });
  });
  it('uses initialFocus without a previous focus', () => {
    const v = view({ primary: { episodeId: 'e2-2', season: 2, episode: 2, resumeMs: 0, mode: 'start' } });
    expect(refocus(undefined, v)).toEqual({ season: 1, episode: 1 });
  });
});
