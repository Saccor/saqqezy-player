import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '@iptv/player';
import { SUBTITLE_LANGUAGES, sanitizeSettings } from '@iptv/core';
import {
  ANOTHER_VERSION_ROW, DELAY_EARLIER_ROW, DELAY_LATER_ROW, DELAY_ROW, FIND_ONLINE_ROW, LOAD_FILE_ROW, LOAD_URL_ROW, REMOVE_EXT_ROW, SUBTITLE_EXT_ROW,
  SUBTITLE_KEY_EXT, SUBTITLE_LANGUAGE_OPTIONS, AUDIO_LANGUAGE_OPTIONS, audioLanguageLabel, delayLabel, languageName, stepDelay,
  onlineFileId, onlineLanguageRows, pickSubtitle, preferredTrack, subtitleExtraRows, subtitleLanguageLabel,
  SPEED_FILM_TO_PAL, SPEED_PAL_TO_FILM, SPEED_HELP, SPEED_ROW, VERSION_LABEL_MAX, autoSpeed, normalizeSpeed, speedLabel, stepSpeed,
  subtitleTime, versionFileId, versionLabel, versionRows, sourceRowIndex, sourceSubtitleName, loadedLanguage,
} from './subtitleLogic.ts';

const t = (id: string, label: string, language?: string, active = false): TrackInfo => {
  const x: TrackInfo = { id, label, active };
  if (language !== undefined) x.language = language;
  return x;
};

describe('subtitle language setting', () => {
  it('offers exactly the languages core accepts', () => {
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
    expect(onlineLanguageRows([{ language: 'en', count: 1, fileId: 7, cc: true }])[0]).toMatchObject({ label: 'English CC', id: 'os:7' });
    expect(onlineLanguageRows([{ language: 'en', count: 1, fileId: 8, cc: true, synced: true }])[0]).toMatchObject({ label: 'English CC · matches this file' });
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
    expect(rows[1]).toEqual({ kind: 'list', id: DELAY_ROW, label: 'Subtitle delay: +1.2 s', checked: false });
    const pointer = subtitleExtraRows({ external: { name: 'English', active: true }, delayMs: 0, canLoadFile: false, pointer: true });
    expect(pointer.slice(1, 4).map((r) => r.kind === 'list' && r.id)).toEqual([DELAY_ROW, DELAY_EARLIER_ROW, DELAY_LATER_ROW]);
    expect(subtitleExtraRows({ external: { name: 'English', active: false }, delayMs: 0, canLoadFile: false }).some((r) => r.kind === 'list' && r.id === DELAY_ROW)).toBe(false);
  });

  it('"another version" shows while a file found online is on', () => {
    const rows = subtitleExtraRows({ external: { name: 'English', active: true }, delayMs: 0, canLoadFile: false, another: { label: 'English' } });
    expect(rows.find((r) => r.kind === 'list' && r.id === ANOTHER_VERSION_ROW)).toMatchObject({ label: 'Try another English version…' });
    const off = subtitleExtraRows({ external: { name: 'English', active: false }, canLoadFile: false, another: { label: 'English' } });
    expect(off.some((r) => r.kind === 'list' && r.id === ANOTHER_VERSION_ROW)).toBe(false);
    const none = subtitleExtraRows({ external: { name: 'English', active: true }, canLoadFile: false });
    expect(none.some((r) => r.kind === 'list' && r.id === ANOTHER_VERSION_ROW)).toBe(false);
    for (const id of [DELAY_ROW, DELAY_EARLIER_ROW, DELAY_LATER_ROW, ANOTHER_VERSION_ROW, SPEED_ROW]) expect(id).not.toMatch(/^(a|s|os|v):|^off$/);
  });

  it('the source\'s own files come first, named by label or language; the loaded one is checked and not listed twice', () => {
    const source = [{ url: 'http://p.test/1.srt', language: 'en' }, { url: 'http://p.test/2.srt', label: 'Svenska' }];
    expect(sourceSubtitleName(source[0]!)).toBe('English (from source)');
    const rows = subtitleExtraRows({ source, canLoadFile: false });
    expect(rows.slice(0, 2)).toEqual([
      { kind: 'list', id: 'src:0', label: 'Subtitles: English (from source)', checked: false },
      { kind: 'list', id: 'src:1', label: 'Subtitles: Svenska (from source)', checked: false },
    ]);
    const loaded = subtitleExtraRows({ source, external: { name: 'English (from source)', active: true }, canLoadFile: false });
    expect(loaded[0]).toMatchObject({ id: 'src:0', checked: true });
    expect(loaded.some((r) => r.kind === 'list' && r.id === SUBTITLE_EXT_ROW)).toBe(false);
    expect(loaded.some((r) => r.kind === 'list' && r.id === DELAY_ROW)).toBe(true);
    expect(sourceRowIndex('src:1')).toBe(1);
    expect(sourceRowIndex('s:1')).toBeUndefined();
  });
});

describe('subtitle speed', () => {
  it('the exact frame-rate factors', () => {
    expect(SPEED_PAL_TO_FILM).toBe(23.976 / 25);
    expect(SPEED_FILM_TO_PAL).toBe(25 / 23.976);
  });

  it('subtitle time: the playhead minus the delay, scaled by the speed', () => {
    expect(subtitleTime(10_000, 0, 1)).toBe(10_000);
    expect(subtitleTime(10_000, 2_000, 1)).toBe(8_000);
    expect(subtitleTime(10_000, -1_000, 1)).toBe(11_000);
    expect(subtitleTime(100_000, 0, SPEED_PAL_TO_FILM)).toBeCloseTo(95_904, 6);
    expect(subtitleTime(10_000, 2_000, SPEED_FILM_TO_PAL)).toBeCloseTo(8_000 * 25 / 23.976, 6);
  });

  it('auto speed: only when both frame rates are known and clearly differ', () => {
    expect(autoSpeed(25, 23.976)).toBe(SPEED_PAL_TO_FILM);
    expect(autoSpeed(25, 23.976)).toBeCloseTo(0.959, 3);
    expect(autoSpeed(23.976, 25)).toBe(SPEED_FILM_TO_PAL);
    expect(autoSpeed(24, 25)).toBe(SPEED_FILM_TO_PAL);
    expect(autoSpeed(25, 24)).toBe(SPEED_PAL_TO_FILM);
    // Not a 24/25 pair: no fixed factor fits, Normal.
    expect(autoSpeed(25, 50)).toBe(1);
    expect(autoSpeed(50, 25)).toBe(1);
    expect(autoSpeed(23.976, 29.97)).toBe(1);
    expect(autoSpeed(23.976, 59.94)).toBe(1);
    expect(autoSpeed(30, 25)).toBe(1);
    expect(autoSpeed(25, 30)).toBe(1);
    expect(autoSpeed(25, 25)).toBe(1);
    expect(autoSpeed(undefined, 25)).toBe(1);
    expect(autoSpeed(25, undefined)).toBe(1);
    expect(autoSpeed(undefined, undefined)).toBe(1);
    expect(autoSpeed(30, 29.97)).toBe(1);
    expect(autoSpeed(0, 25)).toBe(1);
    expect(autoSpeed(Number.NaN, 25)).toBe(1);
  });

  it('a saved speed is one of the three; anything else is Normal', () => {
    expect(normalizeSpeed(undefined)).toBe(1);
    expect(normalizeSpeed(1)).toBe(1);
    expect(normalizeSpeed(SPEED_PAL_TO_FILM)).toBe(SPEED_PAL_TO_FILM);
    expect(normalizeSpeed(0.959)).toBe(SPEED_PAL_TO_FILM);
    expect(normalizeSpeed(1.0427)).toBe(SPEED_FILM_TO_PAL);
    expect(normalizeSpeed(1.5)).toBe(1);
    expect(normalizeSpeed(Number.NaN)).toBe(1);
  });

  it('labels and Left/Right cycling, wrapping', () => {
    expect(speedLabel(1)).toBe('Normal');
    expect(speedLabel(SPEED_PAL_TO_FILM)).toBe('25 → 23.976');
    expect(speedLabel(SPEED_FILM_TO_PAL)).toBe('23.976 → 25');
    expect(stepSpeed(1, 1)).toBe(SPEED_PAL_TO_FILM);
    expect(stepSpeed(SPEED_PAL_TO_FILM, 1)).toBe(SPEED_FILM_TO_PAL);
    expect(stepSpeed(SPEED_FILM_TO_PAL, 1)).toBe(1);
    expect(stepSpeed(1, -1)).toBe(SPEED_FILM_TO_PAL);
  });

  it('the speed row sits under the delay, only while a loaded file is on', () => {
    const rows = subtitleExtraRows({ external: { name: 'English', active: true }, delayMs: 0, speed: SPEED_PAL_TO_FILM, canLoadFile: false });
    expect(rows.slice(1, 3).map((r) => r.kind === 'list' && r.id)).toEqual([DELAY_ROW, SPEED_ROW]);
    expect(rows[2]).toEqual({ kind: 'list', id: SPEED_ROW, label: 'Subtitle speed: 25 → 23.976', checked: false, help: SPEED_HELP });
    expect(SPEED_HELP).toBe('Fixes subtitles that drift further off as the film goes on');
    const pointer = subtitleExtraRows({ external: { name: 'English', active: true }, canLoadFile: false, pointer: true });
    expect(pointer.slice(1, 5).map((r) => r.kind === 'list' && r.id)).toEqual([DELAY_ROW, DELAY_EARLIER_ROW, DELAY_LATER_ROW, SPEED_ROW]);
    expect(pointer[4]).toMatchObject({ label: 'Subtitle speed: Normal' });
    const off = subtitleExtraRows({ external: { name: 'English', active: false }, canLoadFile: false });
    expect(off.some((r) => r.kind === 'list' && r.id === SPEED_ROW)).toBe(false);
    expect(subtitleExtraRows({ canLoadFile: false }).some((r) => r.kind === 'list' && r.id === SPEED_ROW)).toBe(false);
  });
});

describe('subtitle versions', () => {
  it('release, frame rate and exact match, parts only when known', () => {
    expect(versionLabel({ release: 'Rel.2020', fps: 25, synced: true }, 1)).toBe('Rel.2020 · 25 fps · exact match');
    expect(versionLabel({ release: 'Synthetic.Release', fps: 23.976, synced: false }, 1)).toBe('Synthetic.Release · 23.976 fps');
    expect(versionLabel({ release: 'Rel', synced: false, hearingImpaired: true }, 1)).toBe('Rel · CC');
    expect(versionLabel({ release: 'Synthetic.Release', synced: false }, 1)).toBe('Synthetic.Release');
    expect(versionLabel({ release: '  ', synced: false }, 3)).toBe('Version 3');
    expect(versionLabel({ release: '', fps: 29.97003, synced: false }, 2)).toBe('Version 2 · 29.97 fps');
  });

  it('a long release name is shortened so the frame rate and match still fit', () => {
    const long = 'Synthetic.Release.Name.That.Goes.On.And.On.1080p.x264';
    const l = versionLabel({ release: long, fps: 25, synced: true }, 1);
    expect(l.length).toBeLessThanOrEqual(VERSION_LABEL_MAX);
    expect(l.endsWith('… · 25 fps · exact match')).toBe(true);
    expect(l.startsWith('Synthetic.Rel')).toBe(true);
    const plain = versionLabel({ release: long, synced: false }, 1);
    expect(plain.length).toBe(VERSION_LABEL_MAX);
    expect(plain.endsWith('…')).toBe(true);
  });

  it('one row per version, the loaded one checked; the id carries the file', () => {
    const rows = versionRows([
      { fileId: 11, release: 'A', fps: 25, synced: false, downloads: 5 },
      { fileId: 12, release: 'B', synced: true, downloads: 1 },
    ], 12);
    expect(rows).toEqual([
      { kind: 'list', id: 'v:11', label: 'A · 25 fps', checked: false, help: 'A' },
      { kind: 'list', id: 'v:12', label: 'B · exact match', checked: true, help: 'B' },
    ]);
    // The footer shows the whole release name; none without one.
    const long = 'Synthetic.Release.Name.That.Goes.On.And.On.1080p';
    expect(versionRows([{ fileId: 13, release: ` ${long} `, synced: false }])[0]).toMatchObject({ help: long });
    expect('help' in versionRows([{ fileId: 14, release: '', synced: false }])[0]!).toBe(false);
    expect(versionFileId('v:12')).toBe(12);
    expect(versionFileId('os:12')).toBeUndefined();
    expect(versionFileId('v:x')).toBeUndefined();
  });
});

describe('loadedLanguage', () => {
  const cue = (text: string) => ({ startMs: 0, endMs: 1, text });
  it('the stored language, else the file name, else the text of its cues, else none', () => {
    expect(loadedLanguage({ name: 'film.srt', cues: [], language: 'da' })).toBe('da');
    expect(loadedLanguage({ name: 'film.srt', cues: [], online: { language: 'pt-BR', fileId: 1 } })).toBe('pt-BR');
    expect(loadedLanguage({ name: 'Film.2020.sv.srt', cues: [] })).toBe('sv');
    expect(loadedLanguage({ name: 'subs.srt', cues: [cue('Jag vet inte vad du pratar om.'), cue('Vi måste gå nu, det är inte säkert här.')] })).toBe('sv');
    expect(loadedLanguage({ name: 'subs.srt', cues: [cue('OK')] })).toBeUndefined();
  });
});

describe('subtitleExtraRows', () => {
  it('a loaded file whose name does not say its language: the language first', () => {
    expect(subtitleExtraRows({ external: { name: 'subs.srt', active: false, language: 'sv' }, canLoadFile: false })[0])
      .toMatchObject({ label: 'Subtitles: Swedish · subs.srt (loaded)' });
    expect(subtitleExtraRows({ external: { name: 'Film.sv.srt', active: false, language: 'sv' }, canLoadFile: false })[0])
      .toMatchObject({ label: 'Subtitles: Film.sv.srt (loaded)' });
  });

  it('a loaded file (checked when on), load rows, and remove', () => {
    expect(subtitleExtraRows({ external: { name: 'film.srt', active: true }, canLoadFile: true })).toEqual([
      { kind: 'list', id: SUBTITLE_EXT_ROW, label: 'Subtitles: film.srt (loaded)', checked: true },
      { kind: 'list', id: DELAY_ROW, label: 'Subtitle delay: 0.0 s', checked: false },
      { kind: 'list', id: SPEED_ROW, label: 'Subtitle speed: Normal', checked: false, help: SPEED_HELP },
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
