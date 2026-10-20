import { describe, expect, it } from 'vitest';
import type { StreamInfo, TrackInfo } from '@iptv/player';
import { BADGE_GAP, BADGE_PAD, badgesWidth, fpsLabel, layoutBadges, mediaBadges, qualityLabel, videoCodecLabel } from './mediaBadges.ts';

describe('layoutBadges', () => {
  const w = (t: string) => t.length * 10;
  it('left to right with padding and gaps; drops what would not fit, keeping the first ones', () => {
    const placed = layoutBadges(['4K', 'HDR10', '25 fps'], w, 1000);
    expect(placed).toEqual([
      { text: '4K', x: 0, width: 20 + BADGE_PAD * 2 },
      { text: 'HDR10', x: 20 + BADGE_PAD * 2 + BADGE_GAP, width: 50 + BADGE_PAD * 2 },
      { text: '25 fps', x: 70 + BADGE_PAD * 4 + BADGE_GAP * 2, width: 60 + BADGE_PAD * 2 },
    ]);
    expect(badgesWidth(placed)).toBe(130 + BADGE_PAD * 6 + BADGE_GAP * 2);
    expect(layoutBadges(['4K', 'HDR10', '25 fps'], w, 70 + BADGE_PAD * 4 + BADGE_GAP).map((b) => b.text)).toEqual(['4K', 'HDR10']);
    expect(layoutBadges(['4K', 'HDR10', '25 fps'], w, 70 + BADGE_PAD * 4 + BADGE_GAP - 1).map((b) => b.text)).toEqual(['4K']);
    expect(badgesWidth([])).toBe(0);
  });
});

const track = (over: Partial<TrackInfo>): TrackInfo => ({ id: '0', label: '', active: false, ...over });

describe('qualityLabel', () => {
  it('names the picture by its size, wide and cropped films included', () => {
    expect(qualityLabel(3840, 2160)).toBe('4K');
    expect(qualityLabel(3840, 1600)).toBe('4K');
    expect(qualityLabel(2560, 1440)).toBe('1440p');
    expect(qualityLabel(1920, 1080)).toBe('1080p');
    expect(qualityLabel(1920, 800)).toBe('1080p');
    expect(qualityLabel(1440, 1080)).toBe('1080p');
    expect(qualityLabel(1280, 720)).toBe('720p');
    expect(qualityLabel(720, 576)).toBe('SD');
    expect(qualityLabel(1920, 1080, 'interlaced')).toBe('1080i');
    expect(qualityLabel(undefined, 1080)).toBeUndefined();
  });
});

describe('fpsLabel', () => {
  it('whole rates plainly, film and NTSC rates to three places', () => {
    expect(fpsLabel(25)).toBe('25 fps');
    expect(fpsLabel(50.004)).toBe('50 fps');
    expect(fpsLabel(23.976023)).toBe('23.976 fps');
    expect(fpsLabel(29.97003)).toBe('29.97 fps');
    expect(fpsLabel(59.94006)).toBe('59.94 fps');
    expect(fpsLabel(undefined)).toBeUndefined();
    expect(fpsLabel(0)).toBeUndefined();
  });
});

describe('videoCodecLabel', () => {
  it('the family, from codec strings and names', () => {
    expect(videoCodecLabel('hvc1.2.4.L153.B0')).toBe('HEVC');
    expect(videoCodecLabel('HEVC')).toBe('HEVC');
    expect(videoCodecLabel('avc1.640028')).toBe('H.264');
    expect(videoCodecLabel('H264')).toBe('H.264');
    expect(videoCodecLabel('av01.0.08M.10')).toBe('AV1');
    expect(videoCodecLabel('vp09.00.10.08')).toBe('VP9');
    expect(videoCodecLabel('mpeg2video')).toBe('MPEG-2');
    expect(videoCodecLabel('something')).toBeUndefined();
  });
});

describe('mediaBadges', () => {
  const info: StreamInfo = { width: 3840, height: 2160, fps: 23.976, videoCodec: 'hvc1.2.4.L153', audioCodec: 'ec-3', audioChannels: 6, bitrate: 18_400_000 };

  it('picture, then sound, then subtitles, then bitrate', () => {
    const audio = [track({ id: 'a', label: 'eng', language: 'eng', active: true, codec: 'E-AC-3', channels: 6, atmos: true })];
    const text = [track({ id: 's', label: 'English SDH', language: 'en', active: true, hearingImpaired: true })];
    expect(mediaBadges({ info, hint: { hdr: 'hdr10' }, audio, text })).toEqual([
      '4K', 'HDR10', '23.976 fps', 'HEVC', 'English', '5.1 E-AC-3 Atmos', 'English CC', '18.4 Mbps',
    ]);
  });

  it('falls back to the stream info for the sound; SDR, no subtitles and unknowns are left out', () => {
    expect(mediaBadges({ info: { ...info, hdr: 'sdr', bitrate: undefined }, audio: [], text: [] }))
      .toEqual(['4K', '23.976 fps', 'HEVC', '5.1 E-AC-3']);
    expect(mediaBadges({ info: {}, audio: [], text: [] })).toEqual([]);
  });

  it('the player\'s Dolby Vision reading and the title\'s range', () => {
    expect(mediaBadges({ info: { hdr: 'dv' }, audio: [], text: [] })).toEqual(['Dolby Vision']);
    expect(mediaBadges({ info: { hdr: 'sdr' }, hint: { hdr: 'dv', dvProfile: 8 }, audio: [], text: [] })).toEqual(['Dolby Vision']);
  });

  it('channel layouts and a stereo track; an untagged audio track names no language', () => {
    const a = (channels: number) => mediaBadges({ info: {}, audio: [track({ active: true, codec: 'AAC', channels })], text: [] });
    expect(a(1)).toEqual(['Mono AAC']);
    expect(a(2)).toEqual(['Stereo AAC']);
    expect(a(8)).toEqual(['7.1 AAC']);
    expect(mediaBadges({ info: {}, audio: [track({ active: true, label: 'und', language: 'und' })], text: [] })).toEqual([]);
  });

  it('subtitles: forced, regular, and a loaded file', () => {
    const forced = [track({ label: 'English forced', language: 'en', active: true, forced: true })];
    expect(mediaBadges({ info: {}, audio: [], text: forced })).toEqual(['English forced']);
    const plain = [track({ label: 'Svenska', language: 'swe', active: true })];
    expect(mediaBadges({ info: {}, audio: [], text: plain })).toEqual(['Swedish subtitles']);
    expect(mediaBadges({ info: {}, audio: [], text: plain, external: 'Danish' })).toEqual(['Danish subtitles']);
    expect(mediaBadges({ info: {}, audio: [], text: [], external: '' })).toEqual(['Subtitles']);
    expect(mediaBadges({ info: {}, audio: [], text: [], external: 'English', externalCc: true })).toEqual(['English CC']);
  });
});
