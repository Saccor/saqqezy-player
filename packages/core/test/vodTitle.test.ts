import { describe, expect, test } from 'vitest';
import { parseEpisodeMarker, splitYear } from '../src/vod/title.ts';

describe('splitYear', () => {
  test('moves a trailing (YYYY) or [YYYY] into year', () => {
    expect(splitYear('Synthetic Film (2021)')).toEqual({ title: 'Synthetic Film', year: 2021 });
    expect(splitYear('Synthetic Film [1999] ')).toEqual({ title: 'Synthetic Film', year: 1999 });
  });
  test('leaves other names alone', () => {
    expect(splitYear('Synthetic Film 2021')).toEqual({ title: 'Synthetic Film 2021' });
    expect(splitYear('Film (3021)')).toEqual({ title: 'Film (3021)' });
    expect(splitYear('(2021)')).toEqual({ title: '(2021)' });
  });
});

describe('parseEpisodeMarker', () => {
  test('SxxEyy, Sxx Eyy and NxNN', () => {
    expect(parseEpisodeMarker('Synthetic Show S02E04')).toEqual({ show: 'Synthetic Show', season: 2, episode: 4, title: 'Synthetic Show S02E04' });
    expect(parseEpisodeMarker('Synthetic Show S02 E04 - Weather Warning'))
      .toEqual({ show: 'Synthetic Show', season: 2, episode: 4, title: 'Weather Warning' });
    expect(parseEpisodeMarker('synthetic show 2x05')).toEqual({ show: 'synthetic show', season: 2, episode: 5, title: 'synthetic show 2x05' });
    expect(parseEpisodeMarker('Show | s1e12 | Finale')).toEqual({ show: 'Show', season: 1, episode: 12, title: 'Finale' });
  });
  test('marker first: the text after it names the show', () => {
    expect(parseEpisodeMarker('S01E01 Pilot')).toEqual({ show: 'Pilot', season: 1, episode: 1, title: 'S01E01 Pilot' });
  });
  test('no marker, and look-alikes that are not markers', () => {
    expect(parseEpisodeMarker('Synthetic Film')).toBeUndefined();
    expect(parseEpisodeMarker('Clip 1920x1080')).toBeUndefined();
    expect(parseEpisodeMarker('Season Opener')).toBeUndefined();
  });
});
