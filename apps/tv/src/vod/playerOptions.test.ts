import { describe, expect, test } from 'vitest';
import type { SeasonView, VersionView, VodPlayable } from '@iptv/app-api';
import type { TrackInfo } from '@iptv/player';
import { audioItems, matchingEpisode, optionsItems, sourceItems, versionOwnerId } from './playerOptions.ts';

const track = (id: string, lang: string, active = false): TrackInfo => ({ id, label: lang, language: lang, active }) as TrackInfo;
const v = (id: string, lang?: string, quality?: string): VersionView => ({ id, tags: [], auto: false, ...(lang ? { lang } : {}), ...(quality ? { quality } : {}) });

describe('optionsItems', () => {
  test('audio, subtitles, stream info and all settings; no source with one version', () => {
    const items = optionsItems({ audio: 'English', subtitles: 'Off', versions: 1, infoOn: false });
    expect(items.map((i) => i.id)).toEqual(['audio', 'subtitles', 'info', 'settings']);
    expect(items[0]).toMatchObject({ label: 'Audio track', value: 'English' });
    expect(items[1]).toMatchObject({ label: 'Subtitles', value: 'Off' });
    expect(items[2]).toMatchObject({ value: 'Off' });
  });
  test('source shows with more than one version, with the count', () => {
    const items = optionsItems({ audio: 'Default', subtitles: 'Off', versions: 3, infoOn: true });
    expect(items.map((i) => i.id)).toEqual(['audio', 'subtitles', 'source', 'info', 'settings']);
    expect(items[2]).toMatchObject({ label: 'Source', value: '3' });
    expect(items[3]).toMatchObject({ value: 'On' });
  });
});

describe('audioItems', () => {
  test('one row per track, the active one selected, then Back', () => {
    const items = audioItems([track('1', 'en', true), track('2', 'sv')], ['English', 'Swedish']);
    expect(items).toEqual([
      { id: 'track:1', label: 'English', value: 'Selected' },
      { id: 'track:2', label: 'Swedish', value: '' },
      { id: 'back', label: 'Back' },
    ]);
  });
  test('no list or a single track says so', () => {
    expect(audioItems([], [])).toEqual([{ id: 'back', label: 'No audio track list for this video' }]);
    expect(audioItems([track('1', 'en', true)], ['English'])).toEqual([{ id: 'back', label: 'Only one audio track' }]);
  });
  test('a browser without a track list says the browser is why', () => {
    expect(audioItems([], [], true)).toEqual([{ id: 'back', label: "This browser can't list this video's audio tracks" }]);
    expect(audioItems([track('1', 'en', true), track('2', 'sv')], ['English', 'Swedish'], true)).toHaveLength(3);
  });
});

describe('sourceItems', () => {
  test('every version named, the playing one selected, then Back', () => {
    const items = sourceItems([v('a', 'sv', '4K'), v('b', undefined, 'HD')], 'b');
    expect(items).toEqual([
      { id: 'ver:a', label: 'Swedish · 4K', value: '' },
      { id: 'ver:b', label: 'Version 2 · HD', value: 'Playing' },
      { id: 'back', label: 'Back' },
    ]);
  });
});

describe('versionOwnerId', () => {
  test('a movie is its own version; an episode belongs to its series version', () => {
    expect(versionOwnerId({ kind: 'movie', itemId: 'm1' } as VodPlayable)).toBe('m1');
    expect(versionOwnerId({ kind: 'episode', itemId: 'e1', series: { id: 's1', season: 1, episode: 2 } } as VodPlayable)).toBe('s1');
    expect(versionOwnerId({ kind: 'episode', itemId: 'e1' } as VodPlayable)).toBeUndefined();
  });
});

describe('matchingEpisode', () => {
  const seasons = [
    { number: 1, name: 'S1', episodes: [{ id: 'x11', season: 1, episode: 1 }, { id: 'x12', season: 1, episode: 2 }] },
    { number: 2, name: 'S2', episodes: [{ id: 'x21', season: 2, episode: 1 }] },
  ] as unknown as SeasonView[];
  test('the same season and episode in the other version', () => {
    expect(matchingEpisode(seasons, 1, 2)).toBe('x12');
    expect(matchingEpisode(seasons, 2, 1)).toBe('x21');
  });
  test('missing there: undefined', () => {
    expect(matchingEpisode(seasons, 3, 1)).toBeUndefined();
  });
});
