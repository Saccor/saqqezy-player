import { describe, expect, test } from 'vitest';
import { XtreamClient } from '../src/xtream/client.ts';
import {
  parseSeriesInfo, parseSeriesList, parseVodCategories, parseVodInfo, parseVodStreams,
} from '../src/xtream/vod.ts';
import { VOD_UNCATEGORIZED } from '../src/vod/types.ts';
import type { FetchFn } from '../src/types.ts';

describe('Xtream VOD parsers', () => {
  test('categories: valid, de-duplicated, junk skipped', () => {
    expect(parseVodCategories([
      { category_id: '1', category_name: 'Drama' }, { category_id: 1, category_name: 'Dup' },
      { category_id: '', category_name: 'x' }, 'junk', { category_id: '2', category_name: 'Comedy' },
    ], 'movie')).toEqual([
      { id: '1', kind: 'movie', name: 'Drama', count: 0 },
      { id: '2', kind: 'movie', name: 'Comedy', count: 0 },
    ]);
    expect(parseVodCategories({ error: 1 }, 'series')).toEqual([]);
  });

  test('vod streams: fields, year sources, rating, junk', () => {
    const items = parseVodStreams([
      { stream_id: 11, name: 'Synthetic Film 001 (2021)', stream_icon: 'http://img.test/1.jpg', rating: '7.64', added: '1760000000', category_id: '1', container_extension: 'mkv' },
      { stream_id: '12', name: 'Synthetic Film 002', year: '2019', rating: 0, category_id: null },
      { stream_id: 13, name: 'Synthetic Film 003', releaseDate: '2018-05-01', rating: '11' },
      { stream_id: 0, name: 'bad id' }, { stream_id: 14, name: '' }, null,
    ], 'src');
    expect(items).toEqual([
      { id: 'src:m11', kind: 'movie', title: 'Synthetic Film 001', categoryId: '1', xid: 11, poster: 'http://img.test/1.jpg', year: 2021, rating: 7.6, added: 1760000000, ext: 'mkv' },
      { id: 'src:m12', kind: 'movie', title: 'Synthetic Film 002', categoryId: VOD_UNCATEGORIZED, xid: 12, year: 2019 },
      { id: 'src:m13', kind: 'movie', title: 'Synthetic Film 003', categoryId: VOD_UNCATEGORIZED, xid: 13, year: 2018, rating: 10 },
    ]);
  });

  test('series list', () => {
    expect(parseSeriesList([
      { series_id: 5, name: 'Synthetic Series 01', cover: 'http://img.test/s.jpg', rating: '8.1', last_modified: '1760000500', category_id: '3', releaseDate: '2021' },
    ], 'src')).toEqual([
      { id: 'src:s5', kind: 'series', title: 'Synthetic Series 01', categoryId: '3', xid: 5, poster: 'http://img.test/s.jpg', year: 2021, rating: 8.1, added: 1760000500 },
    ]);
  });

  test('vod info: plot, runtime from seconds or HH:MM:SS, backdrop array or string', () => {
    expect(parseVodInfo({ info: {
      plot: 'A synthetic plot.', duration_secs: '6840', genre: 'Drama', director: 'Synthetic Person',
      cast: 'A, B', mpaa_rating: '12', backdrop_path: ['http://img.test/b.jpg'], youtube_trailer: 'ignored', tmdb_id: '1',
    } })).toEqual({
      plot: 'A synthetic plot.', runtimeMin: 114, genre: 'Drama', director: 'Synthetic Person', cast: 'A, B', ageRating: '12', backdrop: 'http://img.test/b.jpg',
    });
    expect(parseVodInfo({ info: { description: 'Desc', duration: '01:54:00', actors: 'C', age: '15', backdrop_path: 'http://img.test/c.jpg' } }))
      .toEqual({ plot: 'Desc', runtimeMin: 114, cast: 'C', ageRating: '15', backdrop: 'http://img.test/c.jpg' });
    expect(parseVodInfo([])).toEqual({});
  });

  test('series info: episodes keyed by season, names, marker titles, junk', () => {
    const d = parseSeriesInfo({
      seasons: [{ season_number: 2, name: 'Second' }],
      info: { plot: 'Night shifts.', genre: 'Drama', backdrop_path: ['http://img.test/sb.jpg'] },
      episodes: {
        '2': [{ id: '202', episode_num: 2, title: 'Synthetic Series 01 - S02E02 - Dead Air', container_extension: 'mp4', info: { duration_secs: 3060, movie_image: 'http://img.test/e.jpg', plot: 'P' } }],
        '1': [
          { id: '102', episode_num: '2', title: 'Second', season: 1 },
          { id: '101', episode_num: 1, title: '' },
          { id: 'x', episode_num: 3 },
        ],
      },
    }, 'src');
    expect(d.plot).toBe('Night shifts.');
    expect(d.backdrop).toBe('http://img.test/sb.jpg');
    expect(d.seasons.map((s) => [s.number, s.name, s.episodes.map((e) => [e.id, e.episode, e.title])])).toEqual([
      [1, 'Season 1', [['src:e101', 1, 'Episode 1'], ['src:e102', 2, 'Second']]],
      [2, 'Second', [['src:e202', 2, 'Dead Air']]],
    ]);
    expect(d.seasons[1]!.episodes[0]).toMatchObject({ xid: 202, runtimeMin: 51, still: 'http://img.test/e.jpg', ext: 'mp4', plot: 'P' });
  });

  test('series info: season 0 is kept as specials, last; a repeated episode id counts once', () => {
    const d = parseSeriesInfo({
      episodes: {
        '0': [{ id: 9, episode_num: 1, title: 'Behind the scenes' }],
        '1': [{ id: 1, episode_num: 1, title: 'A' }, { id: 1, episode_num: 1, title: 'A again' }],
      },
    }, 'src');
    expect(d.seasons.map((s) => [s.number, s.name, s.episodes.map((e) => [e.id, e.season, e.title])])).toEqual([
      [1, 'Season 1', [['src:e1', 1, 'A']]],
      [0, 'Specials', [['src:e9', 0, 'Behind the scenes']]],
    ]);
  });

  test('years: only a 4-digit year from 1900 to 2100 counts', () => {
    const y = (year: unknown) => parseVodStreams([{ stream_id: 1, name: 'F', year }], 'src')[0]!.year;
    expect(y('2021-05-01')).toBe(2021);
    expect(y('20211')).toBeUndefined();
    expect(y('1899')).toBeUndefined();
    expect(y('2101')).toBeUndefined();
    expect(y('1900')).toBe(1900);
    expect(y('2100')).toBe(2100);
  });

  test('series info: season 0 from the episode field stays 0', () => {
    const d = parseSeriesInfo({ episodes: { '1': [{ id: 3, episode_num: 1, season: 0, title: 'X' }] } }, 'src');
    expect(d.seasons.map((s) => s.number)).toEqual([0]);
  });

  test('series info: episodes as an array of season arrays', () => {
    const d = parseSeriesInfo({ episodes: [[{ id: 1, episode_num: 1, season: 1, title: 'A' }], [{ id: 2, episode_num: 1, season: 2, title: 'B' }]] }, 'src');
    expect(d.seasons.map((s) => s.number)).toEqual([1, 2]);
  });
});

describe('XtreamClient VOD methods', () => {
  const cfg = { server: 'example.test', username: 'u', password: 'p&' };
  test('actions, category filter and URLs', async () => {
    const seen: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      seen.push(url);
      return new Response(JSON.stringify([]), { status: 200 });
    };
    const c = new XtreamClient(cfg, fetchFn);
    await c.vodCategories();
    await c.vodStreams('src', '7');
    await c.vodInfo(11);
    await c.seriesCategories();
    await c.seriesList('src');
    await c.seriesInfo('src', 5);
    expect(seen.map((u) => new URL(u).search)).toEqual([
      '?username=u&password=p%26&action=get_vod_categories',
      '?username=u&password=p%26&action=get_vod_streams&category_id=7',
      '?username=u&password=p%26&action=get_vod_info&vod_id=11',
      '?username=u&password=p%26&action=get_series_categories',
      '?username=u&password=p%26&action=get_series',
      '?username=u&password=p%26&action=get_series_info&series_id=5',
    ]);
    expect(c.movieUrl(11, 'mkv')).toBe('http://example.test/movie/u/p%26/11.mkv');
    expect(c.episodeUrl(202, 'mp4')).toBe('http://example.test/series/u/p%26/202.mp4');
  });
});
