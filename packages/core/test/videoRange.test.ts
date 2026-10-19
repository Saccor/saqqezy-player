import { describe, expect, test } from 'vitest';
import { dvFromFourCC, dvFromTitle, videoRangeOf, wrongColoursWithoutDv } from '../src/vod/videoRange.ts';
import { parseSeriesInfo, parseVodInfo } from '../src/xtream/vod.ts';

/** ffprobe-shaped stream objects, as Xtream panels put them in `get_vod_info` → `info.video`. Synthetic values. */
const HDR10 = { codec_name: 'hevc', color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc' };
const dovi = (profile: number, compat: number) => ({ side_data_type: 'DOVI configuration record', dv_profile: profile, dv_bl_signal_compatibility_id: compat });

describe('videoRangeOf (ffprobe stream object)', () => {
  test('SDR, HDR10 and HLG from the transfer characteristics', () => {
    expect(videoRangeOf({ codec_name: 'h264', color_transfer: 'bt709' })).toEqual({ hdr: 'sdr' });
    expect(videoRangeOf(HDR10)).toEqual({ hdr: 'hdr10' });
    expect(videoRangeOf({ codec_name: 'hevc', color_transfer: 'arib-std-b67' })).toEqual({ hdr: 'hlg' });
  });

  test('Dolby Vision profile 5 (no compatible base layer) has no fallback', () => {
    expect(videoRangeOf({ codec_name: 'hevc', side_data_list: [dovi(5, 0)] })).toEqual({ hdr: 'dv', dvProfile: 5, dvFallback: 'none' });
    // MP4: the dvh1/dvhe sample entry is only used for streams with no backward-compatible base layer.
    expect(videoRangeOf({ codec_name: 'hevc', codec_tag_string: 'dvh1' })).toEqual({ hdr: 'dv', dvFallback: 'none' });
    // FFmpeg 7.1+ names the IPTPQc2 matrix of profile 5.
    expect(videoRangeOf({ codec_name: 'hevc', color_space: 'ipt-c2' })).toEqual({ hdr: 'dv', dvFallback: 'none' });
  });

  test('Dolby Vision 8.1 / 8.4 / 7 play their HDR10 or HLG base layer', () => {
    expect(videoRangeOf({ ...HDR10, side_data_list: [dovi(8, 1)] })).toEqual({ hdr: 'dv', dvProfile: 8, dvFallback: 'hdr10' });
    expect(videoRangeOf({ codec_name: 'hevc', color_transfer: 'arib-std-b67', side_data_list: [dovi(8, 4)] }))
      .toEqual({ hdr: 'dv', dvProfile: 8, dvFallback: 'hlg' });
    expect(videoRangeOf({ ...HDR10, side_data_list: [dovi(7, 6)] })).toEqual({ hdr: 'dv', dvProfile: 7, dvFallback: 'hdr10' });
    expect(videoRangeOf({ codec_name: 'hevc', color_transfer: 'bt709', side_data_list: [dovi(8, 2)] }))
      .toEqual({ hdr: 'dv', dvProfile: 8, dvFallback: 'sdr' });
    // An `hvc1` sample entry with a DV record is backward compatible.
    expect(videoRangeOf({ ...HDR10, codec_tag_string: 'hvc1', side_data_list: [dovi(8, 1)] })?.dvFallback).toBe('hdr10');
  });

  test('numeric strings, other side data and junk', () => {
    expect(videoRangeOf({ side_data_list: [{ side_data_type: 'Mastering display metadata' }, { ...dovi(5, 0), dv_profile: '5' }] })?.dvProfile).toBe(5);
    expect(videoRangeOf({ codec_name: 'hevc' })).toBeUndefined();
    expect(videoRangeOf({ codec_name: 'hevc', color_transfer: 'unknown' })).toBeUndefined();
    for (const junk of [undefined, null, [], 'hevc', 3]) expect(videoRangeOf(junk)).toBeUndefined();
  });
});

describe('dvFromFourCC (player-reported codec)', () => {
  test('DV sample entries mean no fallback; plain HEVC/H.264 say nothing', () => {
    for (const f of ['dvh1', 'DVHE', 'dvav', 'dva1', 'dav1']) expect(dvFromFourCC(f)).toEqual({ hdr: 'dv', dvFallback: 'none' });
    for (const f of ['HEVC', 'H265', 'hvc1', 'H264', '', undefined]) expect(dvFromFourCC(f)).toBeUndefined();
  });
});

describe('dvFromTitle (release name)', () => {
  test('DV tokens', () => {
    expect(dvFromTitle('Synthetic Film 2160p DV WEB-DL')).toEqual({ hdr: 'dv' });
    expect(dvFromTitle('Synthetic.Film.2021.2160p.DoVi.mkv')).toEqual({ hdr: 'dv' });
    expect(dvFromTitle('Synthetic Film [Dolby Vision]')).toEqual({ hdr: 'dv' });
    expect(dvFromTitle('Synthetic Film (4K DOLBY-VISION)')).toEqual({ hdr: 'dv' });
  });

  test('DV with an HDR10/HLG tag carries a base layer', () => {
    expect(dvFromTitle('Synthetic Film 2160p DV HDR10')).toEqual({ hdr: 'dv', dvFallback: 'hdr10' });
    expect(dvFromTitle('Synthetic.Film.DV.HDR.mkv')).toEqual({ hdr: 'dv', dvFallback: 'hdr10' });
    expect(dvFromTitle('Synthetic Film HDR10+ DoVi')).toEqual({ hdr: 'dv', dvFallback: 'hdr10' });
  });

  test('no false positives', () => {
    for (const t of ['DVD Collection', 'Synthetic Film (DVDRip)', 'ADV Synthetic', 'Synthetic dv lower case', 'Synthetic Film HDR10', 'Advent']) {
      expect(dvFromTitle(t)).toBeUndefined();
    }
  });
});

describe('wrongColoursWithoutDv', () => {
  test('only DV with no usable base layer', () => {
    expect(wrongColoursWithoutDv({ hdr: 'dv', dvProfile: 5, dvFallback: 'none' })).toBe(true);
    expect(wrongColoursWithoutDv({ hdr: 'dv', dvFallback: 'none' })).toBe(true);
    // DV named in the title with no HDR tag: most often profile 5, so warn (the copy says "may").
    expect(wrongColoursWithoutDv({ hdr: 'dv' })).toBe(true);
    expect(wrongColoursWithoutDv({ hdr: 'dv', dvProfile: 8, dvFallback: 'hdr10' })).toBe(false);
    expect(wrongColoursWithoutDv({ hdr: 'hdr10' })).toBe(false);
    expect(wrongColoursWithoutDv(undefined)).toBe(false);
  });
});

describe('Xtream detail parsers keep the video range', () => {
  test('movie info.video', () => {
    expect(parseVodInfo({ info: { plot: 'P', video: { codec_name: 'hevc', side_data_list: [dovi(5, 0)] } } }))
      .toEqual({ plot: 'P', video: { hdr: 'dv', dvProfile: 5, dvFallback: 'none' } });
    // Panels without probe data send [] or nothing.
    expect(parseVodInfo({ info: { plot: 'P', video: [] } })).toEqual({ plot: 'P' });
  });

  test('episode info.video', () => {
    const d = parseSeriesInfo({ episodes: { '1': [{ id: '1', episode_num: 1, title: 'E', info: { video: HDR10 } }] } }, 'src');
    expect(d.seasons[0]!.episodes[0]!.video).toEqual({ hdr: 'hdr10' });
  });
});
