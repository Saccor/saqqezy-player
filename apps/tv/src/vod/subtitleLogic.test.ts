import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '@iptv/player';
import { SUBTITLE_LANGUAGES, sanitizeSettings } from '@iptv/core';
import {
  LOAD_FILE_ROW, LOAD_URL_ROW, REMOVE_EXT_ROW, SUBTITLE_EXT_ROW, SUBTITLE_KEY_EXT, SUBTITLE_LANGUAGE_OPTIONS, languageName,
  pickSubtitle, preferredTrack, subtitleExtraRows, subtitleLanguageLabel,
} from './subtitleLogic.ts';

const t = (id: string, label: string, language?: string, active = false): TrackInfo => {
  const x: TrackInfo = { id, label, active };
  if (language !== undefined) x.language = language;
  return x;
};

describe('subtitle language setting', () => {
  it('offers exactly the languages core accepts', () => {
    expect(SUBTITLE_LANGUAGE_OPTIONS).toEqual(SUBTITLE_LANGUAGES);
    for (const code of SUBTITLE_LANGUAGE_OPTIONS) expect(sanitizeSettings({ subtitleLanguage: code }).subtitleLanguage).toBe(code);
  });

  it('labels every option with an English name', () => {
    expect(subtitleLanguageLabel('off')).toBe('Off');
    expect(subtitleLanguageLabel('sv')).toBe('Swedish');
    for (const code of SUBTITLE_LANGUAGE_OPTIONS) expect(subtitleLanguageLabel(code)).not.toBe(code);
  });

  it('names 639-1, both 639-2 forms and region tags', () => {
    expect(languageName('en')).toBe('English');
    expect(languageName('ENG')).toBe('English');
    expect(languageName('ger')).toBe('German');
    expect(languageName('pt-BR')).toBe('Portuguese');
    expect(languageName('zz')).toBeUndefined();
  });
});

describe('preferredTrack', () => {
  it('matches by language code in any form', () => {
    expect(preferredTrack([t('1', 'Track 1', 'eng'), t('2', 'Track 2', 'swe')], 'sv')?.id).toBe('2');
    expect(preferredTrack([t('1', 'A', 'en-US')], 'en')?.id).toBe('1');
  });

  it('falls back to a label naming the language or the bare code', () => {
    expect(preferredTrack([t('1', 'Subtitles 1'), t('2', 'Swedish (SDH)')], 'sv')?.id).toBe('2');
    expect(preferredTrack([t('1', 'swe')], 'sv')?.id).toBe('1');
  });

  it('prefers a full track over a forced one', () => {
    expect(preferredTrack([t('1', 'English Forced', 'en'), t('2', 'English', 'en')], 'en')?.id).toBe('2');
    expect(preferredTrack([t('1', 'English Forced', 'en')], 'en')?.id).toBe('1');
  });

  it('nothing for off or no match', () => {
    expect(preferredTrack([t('1', 'English', 'en')], 'off')).toBeUndefined();
    expect(preferredTrack([t('1', 'English', 'en')], 'fr')).toBeUndefined();
  });
});

describe('pickSubtitle', () => {
  const texts = [t('1', 'English', 'en'), t('2', 'Swedish', 'sv')];

  it('the loaded file when it was chosen and is there', () => {
    expect(pickSubtitle({ chosen: SUBTITLE_KEY_EXT, texts, hasExternal: true, preferred: 'en' })).toEqual({ kind: 'external' });
  });

  it('off when off was chosen', () => {
    expect(pickSubtitle({ chosen: 'off', texts, hasExternal: true, preferred: 'en' })).toEqual({ kind: 'off' });
  });

  it('a remembered track, else the preferred language', () => {
    expect(pickSubtitle({ chosen: 'sv:Swedish', texts, hasExternal: false, preferred: 'en' })).toEqual({ kind: 'track', id: '2' });
    expect(pickSubtitle({ chosen: 'fr:French', texts, hasExternal: false, preferred: 'en' })).toEqual({ kind: 'track', id: '1' });
  });

  it('no choice: the preferred language, else leave the engine alone', () => {
    expect(pickSubtitle({ chosen: undefined, texts, hasExternal: false, preferred: 'sv' })).toEqual({ kind: 'track', id: '2' });
    expect(pickSubtitle({ chosen: undefined, texts, hasExternal: false, preferred: 'off' })).toEqual({ kind: 'keep' });
    expect(pickSubtitle({ chosen: undefined, texts, hasExternal: false, preferred: 'fr' })).toEqual({ kind: 'keep' });
  });

  it('the loaded file chosen for a series but missing for this episode: the preferred language', () => {
    expect(pickSubtitle({ chosen: SUBTITLE_KEY_EXT, texts, hasExternal: false, preferred: 'sv' })).toEqual({ kind: 'track', id: '2' });
  });
});

describe('subtitleExtraRows', () => {
  it('a loaded file (checked when on), load rows, and remove', () => {
    expect(subtitleExtraRows({ external: { name: 'film.srt', active: true }, canLoadFile: true })).toEqual([
      { kind: 'list', id: SUBTITLE_EXT_ROW, label: 'Subtitles: film.srt (loaded)', checked: true },
      { kind: 'list', id: LOAD_URL_ROW, label: 'Load subtitles from a link…', checked: false },
      { kind: 'list', id: LOAD_FILE_ROW, label: 'Load subtitles from a file…', checked: false },
      { kind: 'list', id: REMOVE_EXT_ROW, label: 'Remove loaded subtitles', checked: false },
    ]);
  });

  it('no file loaded, no file picker on this device: the link row only', () => {
    expect(subtitleExtraRows({ canLoadFile: false })).toEqual([
      { kind: 'list', id: LOAD_URL_ROW, label: 'Load subtitles from a link…', checked: false },
    ]);
  });

  it('row ids never collide with track rows (a:, s:) or Off', () => {
    for (const id of [SUBTITLE_EXT_ROW, LOAD_URL_ROW, LOAD_FILE_ROW, REMOVE_EXT_ROW]) {
      expect(id).not.toMatch(/^(a|s):/);
      expect(id).not.toBe('off');
    }
  });
});
