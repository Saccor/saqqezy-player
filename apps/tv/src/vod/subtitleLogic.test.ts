import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '@iptv/player';
import { SUBTITLE_LANGUAGES, sanitizeSettings } from '@iptv/core';
import {
  ANOTHER_VERSION_ROW, DELAY_EARLIER_ROW, DELAY_LATER_ROW, DELAY_ROW, FIND_ONLINE_ROW, LOAD_FILE_ROW, LOAD_URL_ROW, REMOVE_EXT_ROW, SUBTITLE_EXT_ROW,
  SUBTITLE_KEY_EXT, SUBTITLE_LANGUAGE_OPTIONS, AUDIO_LANGUAGE_OPTIONS, audioLanguageLabel, delayLabel, languageName, stepDelay,
  onlineFileId, onlineLanguageRows, pickSubtitle, preferredTrack, subtitleExtraRows, subtitleLanguageLabel,
} from './subtitleLogic.ts';

const t = (id: string, label: string, language?: string, active = false): TrackInfo => {
  const x: TrackInfo = { id, label, active };
  if (language !== undefined) x.language = language;
  return x;
};

describe('subtitle language setting', () => {
  it('offers exactly the languages core accepts', () => {
    expect(SUBTITLE_LANGUAGE_OPTIONS).toEqual(SUBTITLE_LANGUAGES);
    expect(AUDIO_LANGUAGE_OPTIONS).toEqual(['auto', ...SUBTITLE_LANGUAGES.filter((c) => c !== 'off')]);
    for (const c of AUDIO_LANGUAGE_OPTIONS) expect(sanitizeSettings({ audioLanguage: c }).audioLanguage).toBe(c);
    expect(audioLanguageLabel('auto')).toBe('Stream default');
    expect(audioLanguageLabel('sv')).toBe('Swedish');
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

describe('online subtitles', () => {
  it('one row per language, named, with an id that carries the file to load', () => {
    expect(onlineLanguageRows([{ language: 'sv', count: 2, fileId: 2001 }, { language: 'en', count: 3, fileId: 1001 }])).toEqual([
      { kind: 'list', id: 'os:2001', label: 'Swedish', checked: false },
      { kind: 'list', id: 'os:1001', label: 'English', checked: false },
    ]);
  });

  it('regional variants keep their region; unknown codes show the code', () => {
    expect(onlineLanguageRows([{ language: 'pt-BR', count: 1, fileId: 1 }, { language: 'pt-PT', count: 1, fileId: 2 }, { language: 'zz', count: 1, fileId: 3 }])
      .map((r) => r.kind === 'list' && r.label)).toEqual(['Portuguese (BR)', 'Portuguese (PT)', 'ZZ']);
  });

  it('the file id back from a row id, else undefined', () => {
    expect(onlineFileId('os:2001')).toBe(2001);
    expect(onlineFileId('s:1')).toBeUndefined();
    expect(onlineFileId('os:x')).toBeUndefined();
  });

  it('a language whose best version matches the exact file says so', () => {
    expect(onlineLanguageRows([{ language: 'en', count: 3, fileId: 1003, synced: true }])[0]).toMatchObject({ label: 'English · matches this file' });
  });

  it('the find row comes first among the extra rows when the service is set up', () => {
    expect(subtitleExtraRows({ canLoadFile: false, canSearchOnline: true })[0]).toEqual(
      { kind: 'list', id: FIND_ONLINE_ROW, label: 'Find subtitles online…', checked: false },
    );
    expect(FIND_ONLINE_ROW).not.toMatch(/^(a|s|os):/);
  });
});

describe('subtitle delay', () => {
  it('labels in seconds with a sign', () => {
    expect(delayLabel(0)).toBe('0.0 s');
    expect(delayLabel(1200)).toBe('+1.2 s');
    expect(delayLabel(-500)).toBe('−0.5 s');
  });

  it('steps 0.1 s (or a given step), within ±60 s', () => {
    expect(stepDelay(0, 1)).toBe(100);
    expect(stepDelay(0, -1)).toBe(-100);
    expect(stepDelay(0, 1, 500)).toBe(500);
    expect(stepDelay(59_950, 1)).toBe(60_000);
    expect(stepDelay(-60_000, -1)).toBe(-60_000);
  });

  it('the delay row shows while a loaded file is on; pointer mode adds earlier/later rows to click', () => {
    const rows = subtitleExtraRows({ external: { name: 'English', active: true }, delayMs: 1200, canLoadFile: false });
    expect(rows[1]).toEqual({ kind: 'list', id: DELAY_ROW, label: 'Subtitle delay: +1.2 s (Left/Right)', checked: false });
    const pointer = subtitleExtraRows({ external: { name: 'English', active: true }, delayMs: 0, canLoadFile: false, pointer: true });
    expect(pointer.slice(1, 4).map((r) => r.kind === 'list' && r.id)).toEqual([DELAY_ROW, DELAY_EARLIER_ROW, DELAY_LATER_ROW]);
    expect(subtitleExtraRows({ external: { name: 'English', active: false }, delayMs: 0, canLoadFile: false }).some((r) => r.kind === 'list' && r.id === DELAY_ROW)).toBe(false);
  });

  it('"another version" names the next one, wrapping, and shows only with more than one', () => {
    const rows = subtitleExtraRows({ external: { name: 'English', active: true }, delayMs: 0, canLoadFile: false, another: { label: 'English', index: 0, total: 3 } });
    expect(rows.find((r) => r.kind === 'list' && r.id === ANOTHER_VERSION_ROW)).toMatchObject({ label: 'Try another English version (2 of 3)' });
    const last = subtitleExtraRows({ external: { name: 'English', active: true }, canLoadFile: false, another: { label: 'English', index: 2, total: 3 } });
    expect(last.find((r) => r.kind === 'list' && r.id === ANOTHER_VERSION_ROW)).toMatchObject({ label: 'Try another English version (1 of 3)' });
    const one = subtitleExtraRows({ external: { name: 'English', active: true }, canLoadFile: false, another: { label: 'English', index: 0, total: 1 } });
    expect(one.some((r) => r.kind === 'list' && r.id === ANOTHER_VERSION_ROW)).toBe(false);
    for (const id of [DELAY_ROW, DELAY_EARLIER_ROW, DELAY_LATER_ROW, ANOTHER_VERSION_ROW]) expect(id).not.toMatch(/^(a|s|os):|^off$/);
  });
});

describe('subtitleExtraRows', () => {
  it('a loaded file (checked when on), load rows, and remove', () => {
    expect(subtitleExtraRows({ external: { name: 'film.srt', active: true }, canLoadFile: true })).toEqual([
      { kind: 'list', id: SUBTITLE_EXT_ROW, label: 'Subtitles: film.srt (loaded)', checked: true },
      { kind: 'list', id: DELAY_ROW, label: 'Subtitle delay: 0.0 s (Left/Right)', checked: false },
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
