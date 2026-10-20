import { describe, expect, test } from 'vitest';
import { englishLanguageName, isoLanguage } from '../src/text/language.ts';
import { parseSeriesInfo, parseVodInfo } from '../src/xtream/vod.ts';

describe('isoLanguage', () => {
  test('ISO 639-1 and both 639-2 forms, any case, with a region or script', () => {
    expect(isoLanguage('en')).toBe('en');
    expect(isoLanguage('ENG')).toBe('en');
    expect(isoLanguage('ger')).toBe('de');
    expect(isoLanguage('deu')).toBe('de');
    expect(isoLanguage('pt-BR')).toBe('pt');
    expect(isoLanguage('zh_Hant')).toBe('zh');
    expect(isoLanguage(' swe ')).toBe('sv');
  });

  test('languages beyond the prefix list', () => {
    expect(isoLanguage('ice')).toBe('is');
    expect(isoLanguage('isl')).toBe('is');
    expect(isoLanguage('srp')).toBe('sr');
    expect(isoLanguage('hr')).toBe('hr');
  });

  test('English names as some panels and engines write them', () => {
    expect(isoLanguage('English')).toBe('en');
    expect(isoLanguage('swedish')).toBe('sv');
  });

  test('undetermined, multiple, no speech and junk: undefined', () => {
    for (const t of ['und', 'mul', 'zxx', 'mis', 'qaa', '', '  ', 'xx', 'abcd', undefined]) expect(isoLanguage(t)).toBeUndefined();
  });
});

describe('englishLanguageName', () => {
  test('any recognised tag, title-cased', () => {
    expect(englishLanguageName('ice')).toBe('Icelandic');
    expect(englishLanguageName('nb-NO')).toBe('Norwegian Bokmål');
    expect(englishLanguageName('und')).toBeUndefined();
    expect(englishLanguageName(undefined)).toBeUndefined();
  });
});

describe('audio language from get_vod_info / get_series_info (ffprobe tags)', () => {
  test('movie: info.audio.tags.language', () => {
    expect(parseVodInfo({ info: { audio: { codec_name: 'eac3', tags: { language: 'swe' } } } }).audioLang).toBe('sv');
    expect(parseVodInfo({ info: { audio: { codec_name: 'aac', tags: { language: 'und' } } } }).audioLang).toBeUndefined();
    expect(parseVodInfo({ info: {} }).audioLang).toBeUndefined();
  });

  test('episode: info.audio.tags.language', () => {
    const d = parseSeriesInfo({
      episodes: { 1: [{ id: '7', episode_num: 1, title: 'A', info: { audio: { tags: { language: 'fre' } } } }] },
    }, 's');
    expect(d.seasons[0]!.episodes[0]!.audioLang).toBe('fr');
  });
});
