import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '@iptv/player';
import { codecFamily, pickAudioTrack, trackKey, trackLabels, trackRows } from './tracks.ts';
import * as vodPlayerLogic from './vodPlayerLogic.ts';
import * as subtitleLogic from './subtitleLogic.ts';

const t = (id: string, label: string, language?: string, active = false, codec?: string): TrackInfo => {
  const x: TrackInfo = { id, label, active };
  if (language !== undefined) x.language = language;
  if (codec !== undefined) x.codec = codec;
  return x;
};

describe('pickAudioTrack', () => {
  const tracks = [t('0', 'English', 'eng', true), t('1', 'Svenska', 'swe'), t('2', 'Commentary', 'eng')];

  it('a remembered choice wins over the preferred language', () => {
    expect(pickAudioTrack(tracks, 'eng:Commentary', 'sv')?.id).toBe('2');
  });

  it('matches the preferred language by 2- or 3-letter tags', () => {
    expect(pickAudioTrack(tracks, undefined, 'sv')?.id).toBe('1');
    expect(pickAudioTrack([t('0', 'Track 1', 'en'), t('1', 'Track 2', 'sv')], undefined, 'sv')?.id).toBe('1');
    expect(pickAudioTrack([t('0', 'Track 1', 'en'), t('1', 'Track 2', 'sv')], undefined, 'en')?.id).toBe('0');
  });

  it('matches by a label that names the language when no tags are given', () => {
    expect(pickAudioTrack([t('0', 'English'), t('1', 'Svenska'), t('2', 'Swedish')], undefined, 'sv')?.id).toBe('2');
  });

  it('auto leaves the engine default', () => {
    expect(pickAudioTrack(tracks, undefined, 'auto')).toBeUndefined();
  });

  it('no match leaves the engine default', () => {
    expect(pickAudioTrack(tracks, undefined, 'de')).toBeUndefined();
    expect(pickAudioTrack([], 'swe:Svenska', 'sv')).toBeUndefined();
  });

  it('a remembered key the stream lacks falls through to the language', () => {
    expect(pickAudioTrack(tracks, 'deu:Deutsch', 'sv')?.id).toBe('1');
  });
});

describe('codecFamily', () => {
  it('maps hls.js codec strings and AVPlay fourCCs to family names', () => {
    expect(codecFamily('mp4a.40.2')).toBe('AAC');
    expect(codecFamily('mp4a.40.5')).toBe('AAC');
    expect(codecFamily('AAC')).toBe('AAC');
    expect(codecFamily('ac-3')).toBe('AC-3');
    expect(codecFamily('AC3')).toBe('AC-3');
    expect(codecFamily('ec-3')).toBe('E-AC-3');
    expect(codecFamily('EAC3')).toBe('E-AC-3');
    expect(codecFamily('DTS')).toBe('DTS');
    expect(codecFamily('dtsh')).toBe('DTS');
    expect(codecFamily('TRUEHD')).toBe('TrueHD');
    expect(codecFamily('mlpa')).toBe('TrueHD');
    expect(codecFamily('MP3')).toBe('MP3');
    expect(codecFamily('mp4a.40.34')).toBe('MP3');
    expect(codecFamily('opus')).toBe('Opus');
  });

  it('is undefined for unknown or empty strings', () => {
    expect(codecFamily(undefined)).toBeUndefined();
    expect(codecFamily('')).toBeUndefined();
    expect(codecFamily('  ')).toBeUndefined();
    expect(codecFamily('H264')).toBeUndefined();
    expect(codecFamily('flac')).toBeUndefined();
  });
});

describe('trackLabels', () => {
  it('names bare language codes, appends the codec, and numbers repeats', () => {
    expect(trackLabels([t('0', 'swe', 'swe', false, 'AC-3'), t('1', 'eng', 'eng'), t('2', 'eng', 'eng'), t('3', 'Director', 'eng', false, 'AAC')]))
      .toEqual(['Swedish (AC-3)', 'English', 'English (2)', 'Director (AAC)']);
  });

  it('names any language code, falls back to the track language tag, and never shows und', () => {
    expect(trackLabels([t('0', 'ice', 'ice'), t('1', '', 'fre'), t('2', 'und', 'fre'), t('3', 'und'), t('4', '')]))
      .toEqual(['Icelandic', 'French', 'French (2)', 'Unknown language', 'Unknown language (2)']);
  });

  it('keeps the codec out of the remembered key', () => {
    expect(trackKey(t('0', 'swe', 'swe', false, 'AC-3'))).toBe('swe:swe');
  });

  it('shows in the picker rows', () => {
    expect(trackRows([t('0', 'Svenska', 'swe', true, 'E-AC-3')], [])[0]!.label).toBe('Audio: Svenska (E-AC-3)');
  });
});

describe('re-exports', () => {
  it('the old modules still export the moved helpers', () => {
    expect(vodPlayerLogic.trackKey).toBe(trackKey);
    expect(vodPlayerLogic.trackRows).toBe(trackRows);
    expect(vodPlayerLogic.findTrack).toBeTypeOf('function');
    expect(subtitleLogic.preferredTrack).toBeTypeOf('function');
  });
});
