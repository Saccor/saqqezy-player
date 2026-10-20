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

describe('splitYear bounds', () => {
  test('1899 and 2101 keep the name; 1900 and 2100 are years', () => {
    expect(splitYear('Film (1899)')).toEqual({ title: 'Film (1899)' });
    expect(splitYear('Film (1900)')).toEqual({ title: 'Film', year: 1900 });
    expect(splitYear('Film (2100)')).toEqual({ title: 'Film', year: 2100 });
    expect(splitYear('Film (2101)')).toEqual({ title: 'Film (2101)' });
  });
});

describe('parseEpisodeMarker edges', () => {
  test('a bare marker has no show; three-digit episodes parse', () => {
    expect(parseEpisodeMarker('S01E01')).toBeUndefined();
    expect(parseEpisodeMarker('Show S01E100')).toMatchObject({ show: 'Show', season: 1, episode: 100 });
  });
  test('a trailing dot that ends an abbreviation survives; other trailing dots go', () => {
    expect(parseEpisodeMarker('Show S01E01 - Dr.')?.title).toBe('Dr.');
    expect(parseEpisodeMarker('Show S01E01 - Mr. ')?.title).toBe('Mr.');
    expect(parseEpisodeMarker('Dr. S01E01')?.show).toBe('Dr.');
    expect(parseEpisodeMarker('Show Vol. - S01E01')?.show).toBe('Show Vol.');
    expect(parseEpisodeMarker('Show S01E01 - Pilot.')?.title).toBe('Pilot');
    expect(parseEpisodeMarker('Show S01E01 - St.')?.title).toBe('St.');
    expect(parseEpisodeMarker('Show S01E01 - Bust.')?.title).toBe('Bust');
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

describe('long titles', () => {
  test('space and separator runs before the end are linear, not quadratic', () => {
    const t = performance.now();
    expect(splitYear('Film' + ' '.repeat(40000) + 'x').year).toBeUndefined();
    expect(splitYear('Film' + ' '.repeat(40000) + '(2001)' + ' '.repeat(40000))).toEqual({ title: 'Film', year: 2001 });
    expect(parseEpisodeMarker('S01E02 x' + ' -'.repeat(40000) + 'y')?.show).toMatch(/^x - - /);
    expect(parseEpisodeMarker('Show S01E02 Pilot' + ' -'.repeat(40000))?.title).toBe('Pilot');
    expect(performance.now() - t).toBeLessThan(200);
  });
});
