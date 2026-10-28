import type { VideoRange } from './types.ts';

/**
 * The picture's dynamic range and Dolby Vision facts, from the hints a source or player gives. Dolby Vision profile 5 has no base layer a non-DV display can show
 * (IPTPQc2 colour), so it plays with wrong colours there; profiles 7 and 8 carry an HDR10, HLG or SDR base layer.
 */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const lower = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const int = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};

/** Sample entries used only for DV streams without a backward-compatible base layer (Dolby's ISOBMFF spec). */
const DV_ONLY_FOURCC = new Set(['dvh1', 'dvhe', 'dvav', 'dva1', 'dav1']);

/** `dv_bl_signal_compatibility_id` → what a non-DV decoder shows. */
const COMPAT: Record<number, NonNullable<VideoRange['dvFallback']>> = { 0: 'none', 1: 'hdr10', 2: 'sdr', 4: 'hlg', 6: 'hdr10' };

function rangeOfTransfer(transfer: string): 'sdr' | 'hdr10' | 'hlg' | undefined {
  if (transfer === 'smpte2084') return 'hdr10';
  if (transfer === 'arib-std-b67') return 'hlg';
  if (transfer === 'bt709' || transfer === 'bt470bg' || transfer === 'smpte170m' || transfer === 'bt2020-10') return 'sdr';
  return undefined;
}

/** A DV range from the codec name a player reports (AVPlay `fourCC`); undefined when it says nothing about DV. */
export function dvFromFourCC(fourCC: string | undefined): VideoRange | undefined {
  return DV_ONLY_FOURCC.has(lower(fourCC)) ? { hdr: 'dv', dvFallback: 'none' } : undefined;
}

/**
 * From an ffprobe-shaped stream object (Xtream `get_vod_info` → `info.video`): `color_transfer`, `color_space`,
 * `codec_tag_string` and the "DOVI configuration record" side data. Undefined when nothing tells.
 */
export function videoRangeOf(video: unknown): VideoRange | undefined {
  if (!isObj(video)) return undefined;
  const base = rangeOfTransfer(lower(video.color_transfer));
  const record = Array.isArray(video.side_data_list)
    ? video.side_data_list.find((d) => isObj(d) && lower(d.side_data_type) === 'dovi configuration record') as Record<string, unknown> | undefined
    : undefined;
  if (record) {
    const out: VideoRange = { hdr: 'dv' };
    const profile = int(record.dv_profile);
    if (profile !== undefined) out.dvProfile = profile;
    const compat = int(record.dv_bl_signal_compatibility_id);
    const fallback = compat !== undefined && compat in COMPAT ? COMPAT[compat] : profile === 5 ? 'none' : base;
    if (fallback) out.dvFallback = fallback;
    return out;
  }
  if (DV_ONLY_FOURCC.has(lower(video.codec_tag_string)) || lower(video.color_space) === 'ipt-c2') return { hdr: 'dv', dvFallback: 'none' };
  return base ? { hdr: base } : undefined;
}

// A token on its own: a separator (or the start/end) on both sides. No lookbehind: 2018 Tizen is Chromium 56.
// `DV` is upper case only ("dv" is too common a fragment).
const DV_TOKEN = /(?:^|[\s._\-[\]()|/+,])(?:DV|[Dd][Oo][Vv][Ii]|[Dd][Oo][Ll][Bb][Yy][\s._-]?[Vv][Ii][Ss][Ii][Oo][Nn])(?=$|[\s._\-[\]()|/+,])/;
const HDR_TOKEN = /(?:^|[\s._\-[\]()|/+,])(HDR(?:10\+?|10Plus)?|HLG)(?=$|[\s._\-[\]()|/+,])/i;

/** A DV range from a release name or title; a DV tag next to an HDR/HLG tag means a base layer (P7/P8). */
export function dvFromTitle(title: string | undefined): VideoRange | undefined {
  if (!title || !DV_TOKEN.test(title)) return undefined;
  const hdr = HDR_TOKEN.exec(title);
  if (!hdr) return { hdr: 'dv' };
  return { hdr: 'dv', dvFallback: hdr[1]!.toUpperCase() === 'HLG' ? 'hlg' : 'hdr10' };
}

/**
 * True when a display without Dolby Vision is likely to show this picture with wrong colours: DV with no usable base
 * layer, or DV whose base layer is not known (a title tag alone, most often profile 5).
 */
export function wrongColoursWithoutDv(range: VideoRange | undefined): boolean {
  return range?.hdr === 'dv' && (range.dvFallback === undefined || range.dvFallback === 'none');
}
