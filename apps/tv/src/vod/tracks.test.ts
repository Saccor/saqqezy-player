import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '@iptv/player';
import { channelLanguageInput, codecFamily, pickAudioTrack, trackKey, trackLabels, trackLanguages, trackRows } from './tracks.ts';
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

  it('matches by a label that names the language when no tags are given (native names too)', () => {
    expect(pickAudioTrack([t('0', 'English'), t('1', 'Svenska'), t('2', 'Swedish')], undefined, 'sv')?.id).toBe('1');
    expect(pickAudioTrack([t('0', 'English'), t('1', 'Track 2'), t('2', 'Swedish')], undefined, 'sv')?.id).toBe('2');
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

describe('trackLanguages', () => {
  it('the track language code first (any ISO form; und is none)', () => {
    expect(trackLanguages([t('0', 'x', 'swe'), t('1', 'x', 'ger'), t('2', 'x', 'pt-BR'), t('3', 'x', 'und')], 'audio'))
      .toEqual(['sv', 'de', 'pt', undefined]);
  });

  it('then the label', () => {
    expect(trackLanguages([t('0', 'Svenska 5.1'), t('1', '[EN]'), t('2', 'eng - AC3'), t('3', 'Track 3', 'und')], 'audio'))
      .toEqual(['sv', 'en', 'en', undefined]);
  });

  it('then languages detected from subtitle text, by track id', () => {
    expect(trackLanguages([t('0', 'Subtitles 1'), t('1', 'Subtitles 2')], 'subtitle', { detected: { 1: 'fi' } }))
      .toEqual([undefined, 'fi']);
  });

  it('the probe language names the first audio track only, when it has none of its own', () => {
    expect(trackLanguages([t('0', 'Track 1'), t('1', 'Track 2')], 'audio', { hints: { firstAudio: 'fr' } })).toEqual(['fr', undefined]);
    expect(trackLanguages([t('0', 'Track 1', 'en'), t('1', 'Track 2')], 'audio', { hints: { firstAudio: 'fr' } })).toEqual(['en', undefined]);
    expect(trackLanguages([t('0', 'Subtitles 1')], 'subtitle', { hints: { firstAudio: 'fr' } })).toEqual([undefined]);
  });

  it('the title prefix names the only track without a language, unless another track has that language', () => {
    const hints = { title: 'sv', titleScope: 'audio' as const };
    expect(trackLanguages([t('0', 'Track 1')], 'audio', { hints })).toEqual(['sv']);
    expect(trackLanguages([t('0', 'Track 1', 'en'), t('1', 'Track 2')], 'audio', { hints })).toEqual(['en', 'sv']);
    expect(trackLanguages([t('0', 'Track 1', 'sv'), t('1', 'Track 2')], 'audio', { hints })).toEqual(['sv', undefined]);
    expect(trackLanguages([t('0', 'Track 1'), t('1', 'Track 2')], 'audio', { hints })).toEqual([undefined, undefined]);
    // A prefix that names the subtitles is not the speech.
    expect(trackLanguages([t('0', 'Track 1')], 'audio', { hints: { title: 'sv', titleScope: 'subtitles' } })).toEqual([undefined]);
    expect(trackLanguages([t('0', 'Subtitles 1')], 'subtitle', { hints: { title: 'sv', titleScope: 'subtitles' } })).toEqual(['sv']);
    expect(trackLanguages([t('0', 'Subtitles 1')], 'subtitle', { hints })).toEqual([undefined]);
  });
});

describe('trackLabels', () => {
  it('names bare language codes, appends the codec, and numbers repeats', () => {
    expect(trackLabels([t('0', 'swe', 'swe', false, 'AC-3'), t('1', 'eng', 'eng'), t('2', 'eng', 'eng'), t('3', 'Director', 'eng', false, 'AAC')], 'audio'))
      .toEqual(['Swedish (AC-3)', 'English', 'English (2)', 'English · Director (AAC)']);
  });

  it('names any language code and falls back to the track language tag', () => {
    expect(trackLabels([t('0', 'ice', 'ice'), t('1', '', 'fre'), t('2', 'und', 'fre')], 'audio'))
      .toEqual(['Icelandic', 'French', 'French (2)']);
  });

  it('never says Unknown: a numbered label with codec and channels when nothing is known', () => {
    const a = (id: string, label: string, codec?: string, channels?: number): TrackInfo => {
      const x = t(id, label, undefined, false, codec);
      if (channels) x.channels = channels;
      return x;
    };
    expect(trackLabels([a('0', 'und'), a('1', '', 'AC-3', 6), a('2', 'Track 3', 'AAC', 2)], 'audio'))
      .toEqual(['Audio 1', 'Audio 2 (AC-3 5.1)', 'Audio 3 (AAC Stereo)']);
    expect(trackLabels([a('0', 'Subtitles 1'), a('1', 'und')], 'subtitle')).toEqual(['Subtitle 1', 'Subtitle 2']);
    expect(trackLabels([a('0', 'xx')], 'audio')).toEqual(['Audio 1']);
  });

  it('a label that names its language is kept; channels it already says are not repeated', () => {
    const x = t('0', 'Svenska 5.1', 'swe', false, 'AC-3');
    x.channels = 6;
    expect(trackLabels([x], 'audio')).toEqual(['Svenska 5.1 (AC-3)']);
  });

  it('labels from inferred languages: the label, detected text and hints', () => {
    expect(trackLabels([t('0', 'Track 1'), t('1', 'Track 2', undefined, false, 'AC-3')], 'audio', { hints: { firstAudio: 'de' } }))
      .toEqual(['German', 'Audio 2 (AC-3)']);
    expect(trackLabels([t('0', 'Subtitles 1')], 'subtitle', { detected: { 0: 'sv' } })).toEqual(['Swedish']);
  });

  it('keeps the codec out of the remembered key', () => {
    expect(trackKey(t('0', 'swe', 'swe', false, 'AC-3'))).toBe('swe:swe');
  });

  it('shows in the picker rows', () => {
    expect(trackRows([t('0', 'Svenska', 'swe', true, 'E-AC-3')], [])[0]!.label).toBe('Audio: Svenska (E-AC-3)');
    const rows = trackRows([t('0', 'Track 1')], [t('0', 'Subtitles 1')], { hints: { title: 'en', titleScope: 'audio' }, detected: { 0: 'fi' } });
    expect(rows.map((r) => (r.kind === 'list' ? r.label : ''))).toEqual(['Audio: English', 'Subtitles: Finnish', 'Subtitles off']);
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

describe('channelLanguageInput', () => {
  it('the channel name prefix, else the group prefix, names the speech', () => {
    expect(channelLanguageInput('SE | Synthetic One HD', 'Sports')).toEqual({ hints: { title: 'sv', titleScope: 'audio' } });
    expect(channelLanguageInput('Synthetic One', 'DE | Movies')).toEqual({ hints: { title: 'de', titleScope: 'audio' } });
    expect(channelLanguageInput('Synthetic One', 'Movies')).toBeUndefined();
    expect(channelLanguageInput(undefined, undefined)).toBeUndefined();
  });
});
