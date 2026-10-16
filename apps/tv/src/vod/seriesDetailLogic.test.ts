import { describe, expect, it } from 'vitest';
import type { EpisodeView, SeasonView, SeriesView } from '@iptv/app-api';
import {
  cardAt, episodeMeta, fallbackArea, initialFocus, primaryLabel, refocus, regularSeasonCount, remountRestore, seasonLabel, seasonTabWidth,
  seriesActions, seriesMeta, stripAt, stripOffset, stripStarts, tabSelAfterReload,
} from './seriesDetailLogic.ts';

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
    expect(episodeMeta(ep(1, 4, { runtimeMin: 90 }))).toBe('E4 · 1 h 30 min');
    expect(episodeMeta(ep(1, 4, { runtimeMin: 120 }))).toBe('E4 · 2 h');
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
    expect(seriesMeta(view({ seasons: [season(0, 2), season(1, 1), season(2, 1)] }))).toBe('2 seasons');
    expect(seriesMeta(view({ seasons: [season(0, 2)] }))).toBe('');
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

describe('regularSeasonCount', () => {
  it('counts only seasons numbered above 0', () => {
    expect(regularSeasonCount([season(0, 1), season(1, 1), season(2, 1)])).toBe(2);
    expect(regularSeasonCount([])).toBe(0);
  });
});

describe('season tab strip', () => {
  it('sizes a tab from its label within bounds', () => {
    expect(seasonTabWidth('Season 1')).toBeGreaterThanOrEqual(140);
    expect(seasonTabWidth('A')).toBe(140);
    expect(seasonTabWidth('x'.repeat(200))).toBe(360);
    expect(seasonTabWidth('Season 10')).toBeGreaterThan(seasonTabWidth('Season 1'));
  });
  it('lays tabs out left to right with a gap', () => {
    expect(stripStarts([100, 150, 120], 10)).toEqual([0, 110, 270]);
    expect(stripStarts([], 10)).toEqual([]);
  });
  it('finds the tab under x, none in a gap or outside', () => {
    const starts = [0, 110, 270];
    const widths = [100, 150, 120];
    expect(stripAt(starts, widths, 50)).toBe(0);
    expect(stripAt(starts, widths, 105)).toBeUndefined();
    expect(stripAt(starts, widths, 300)).toBe(2);
    expect(stripAt(starts, widths, 400)).toBeUndefined();
    expect(stripAt(starts, widths, -1)).toBeUndefined();
  });
  it('scrolls as little as possible to keep the focused tab in view', () => {
    const widths = [200, 200, 200, 200, 200];
    const starts = stripStarts(widths, 0);
    expect(stripOffset(starts, widths, 0, 500, 0)).toBe(0);
    expect(stripOffset(starts, widths, 2, 500, 0)).toBe(100);
    expect(stripOffset(starts, widths, 4, 500, 100)).toBe(500);
    expect(stripOffset(starts, widths, 1, 500, 500)).toBe(200);
    expect(stripOffset(starts, widths, 3, 500, 500)).toBe(500);
    expect(stripOffset([], [], 0, 500, 40)).toBe(0);
  });
});

describe('cardAt', () => {
  it('maps a row-local x to the card under it (pitch 424, card 400), none in a gap or past the end', () => {
    expect(cardAt(10, 0, 424, 400, 10)).toBe(0);
    expect(cardAt(410, 0, 424, 400, 10)).toBeUndefined();
    expect(cardAt(430, 0, 424, 400, 10)).toBe(1);
    expect(cardAt(10, 3, 424, 400, 10)).toBe(3);
    expect(cardAt(430, 9, 424, 400, 10)).toBeUndefined();
    expect(cardAt(-5, 0, 424, 400, 10)).toBeUndefined();
  });
});

describe('remountRestore', () => {
  const focus = { seasonNumber: 2, episodeId: 'e2-4' };
  const v = view();
  it('restores the saved episode and area when the screen was left from the seasons or episodes', () => {
    expect(remountRestore({ focus, area: 'episodes' }, v)).toEqual({ prev: focus, area: 'episodes' });
    expect(remountRestore({ focus, area: 'seasons' }, v)).toEqual({ prev: focus, area: 'seasons' });
  });
  it('opens on the primary button (and the primary episode) on a first open or when left from the actions', () => {
    expect(remountRestore({}, v)).toEqual({ prev: undefined, area: 'actions' });
    expect(remountRestore({ focus, area: 'actions' }, v)).toEqual({ prev: undefined, area: 'actions' });
    expect(remountRestore({ area: 'episodes' }, v)).toEqual({ prev: undefined, area: 'actions' });
  });
  it('moves to the primary episode, keeping the area, when the saved episode is now watched (the player auto-advanced)', () => {
    const primary = { episodeId: 'e2-5', season: 2, episode: 5, resumeMs: 0, mode: 'continue' as const };
    const watched = view({ seasons: [season(1, 3), { ...season(2, 5), episodes: season(2, 5).episodes.map((e) => ({ ...e, watched: e.episode <= 4 })) }], primary });
    expect(remountRestore({ focus, area: 'episodes' }, watched)).toEqual({ prev: { seasonNumber: 2, episodeId: 'e2-5' }, area: 'episodes' });
    expect(remountRestore({ focus, area: 'seasons' }, watched)).toEqual({ prev: { seasonNumber: 2, episodeId: 'e2-5' }, area: 'seasons' });
    // No primary: the saved (watched) episode stays.
    expect(remountRestore({ focus, area: 'episodes' }, { ...watched, primary: undefined })).toEqual({ prev: focus, area: 'episodes' });
    // Not watched: the saved episode stays even with a primary elsewhere.
    expect(remountRestore({ focus, area: 'episodes' }, view({ primary }))).toEqual({ prev: focus, area: 'episodes' });
  });
});

describe('fallbackArea', () => {
  it('keeps an area that has something to focus', () => {
    expect(fallbackArea('episodes', { seasons: 2, episodes: 3 })).toBe('episodes');
    expect(fallbackArea('seasons', { seasons: 2, episodes: 0 })).toBe('seasons');
    expect(fallbackArea('actions', { seasons: 0, episodes: 0 })).toBe('actions');
  });
  it('falls back from empty episodes to the seasons, and from no seasons to the actions', () => {
    expect(fallbackArea('episodes', { seasons: 2, episodes: 0 })).toBe('seasons');
    expect(fallbackArea('episodes', { seasons: 0, episodes: 0 })).toBe('actions');
    expect(fallbackArea('seasons', { seasons: 0, episodes: 0 })).toBe('actions');
  });
});

describe('tabSelAfterReload', () => {
  it('follows the placed season unless the keys are on the tabs', () => {
    expect(tabSelAfterReload('episodes', 3, 1, 5)).toBe(1);
    expect(tabSelAfterReload('actions', 3, 1, 5)).toBe(1);
  });
  it('keeps the tab selection while on the tabs, clamped to the seasons', () => {
    expect(tabSelAfterReload('seasons', 3, 1, 5)).toBe(3);
    expect(tabSelAfterReload('seasons', 3, 1, 2)).toBe(1);
    expect(tabSelAfterReload('seasons', 3, 0, 0)).toBe(0);
  });
});

describe('seriesActions', () => {
  const primary = { episodeId: 'e2-4', season: 2, episode: 4, resumeMs: 5, mode: 'continue' as const };
  it('shows the primary episode and Favourite', () => {
    expect(seriesActions({ loaded: true, primary, favourite: false }).map((a) => [a.id, a.label]))
      .toEqual([['play', 'Continue S2 · E4'], ['fav', 'Add to favourites']]);
    expect(seriesActions({ loaded: true, primary, favourite: true })[1]!.label).toBe('In favourites');
  });
  it('shows Play while loading and hides it once loaded without a primary episode', () => {
    expect(seriesActions({ loaded: false, favourite: false }).map((a) => [a.id, a.label])).toEqual([['play', 'Play'], ['fav', 'Add to favourites']]);
    expect(seriesActions({ loaded: true, favourite: false }).map((a) => a.id)).toEqual(['fav']);
  });
});
