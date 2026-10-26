import type { VideoRange } from '@iptv/core';
import type { StreamInfo, TrackInfo } from '@iptv/player';
import { channelsLabel, codecFamily, languageName, trackLanguages, type TrackLanguageInput } from '../vod/tracks.ts';
import { formatBitrate } from './streamInfo.ts';
import { SPACE } from '../shell/theme.ts';

/**
 * The badges the player's controls show about what is playing right now: picture size, dynamic range, frame rate and
 * video codec; the sound's language, channels and codec; the subtitles in use; the bitrate. Built only from what the
 * engine and the source report; anything unknown is left out rather than guessed.
 */
export interface MediaBadgeInput {
  info: StreamInfo;
  /** The range the source or title gives (VOD). */
  hint?: VideoRange;
  audio: readonly TrackInfo[];
  text: readonly TrackInfo[];
  /** A loaded subtitle file is showing: its language name ('' when unknown). */
  external?: string;
  /** The loaded file is made for the hearing impaired. */
  externalCc?: boolean;
  /** The source's language hints and the subtitle languages detected this open (as the track picker uses them). */
  languages?: TrackLanguageInput;
}

/** "4K", "1440p", "1080p", "720p" or "SD" by the picture's size (wide and cropped films by their width); "1080i" interlaced. */
export function qualityLabel(width: number | undefined, height: number | undefined, scan?: StreamInfo['scan']): string | undefined {
  if (!width || !height) return undefined;
  const w = Math.max(width, (height * 16) / 9);
  const p = scan === 'interlaced' ? 'i' : 'p';
  if (w >= 3200) return '4K';
  if (w >= 2200) return `1440${p}`;
  if (w >= 1700) return `1080${p}`;
  if (w >= 1100) return `720${p}`;
  return 'SD';
}

/** "25 fps", "23.976 fps", "29.97 fps". */
export function fpsLabel(fps: number | undefined): string | undefined {
  if (!fps || fps <= 0) return undefined;
  const whole = Math.round(fps);
  return Math.abs(fps - whole) < 0.01 ? `${whole} fps` : `${Number(fps.toFixed(3))} fps`;
}

const VIDEO_CODECS: [RegExp, string][] = [
  [/^(hvc1|hev1|hevc|h\.?265)/i, 'HEVC'],
  [/^(avc|h\.?264)/i, 'H.264'],
  [/^(av01|av1)/i, 'AV1'],
  [/^(vp09|vp9)/i, 'VP9'],
  [/^(mpeg-?2|mp2v)/i, 'MPEG-2'],
];

/** The video codec family from a codec string ("hvc1.2.4…") or name ("HEVC"); undefined when unknown. */
export function videoCodecLabel(codec: string | undefined): string | undefined {
  const c = codec?.trim();
  return c ? VIDEO_CODECS.find(([re]) => re.test(c))?.[1] : undefined;
}

const RANGE = { hdr10: 'HDR10', hdr10plus: 'HDR10+', hlg: 'HLG', dv: 'Dolby Vision' } as const;

/** The player's own Dolby Vision reading first, then the source's or title's range, then the player's; SDR is not a badge. */
function rangeLabel(info: StreamInfo, hint: VideoRange | undefined): string | undefined {
  if (info.hdr === 'dv') return RANGE.dv;
  const r = hint?.hdr ?? info.hdr;
  return r && r !== 'sdr' ? RANGE[r] : undefined;
}

/** The language name of `tracks[i]`, from every signal `trackLanguages` reads. */
function languageAt(tracks: readonly TrackInfo[], i: number, kind: 'audio' | 'subtitle', input: TrackLanguageInput | undefined): string | undefined {
  if (i < 0) return undefined;
  const code = trackLanguages(tracks, kind, input)[i];
  return code ? languageName(code) : undefined;
}

const HEARING_IMPAIRED = /\b(sdh|cc|hoh|hearing)\b/i;
const FORCED = /\bforced\b/i;

function subtitleBadge(text: readonly TrackInfo[], external: string | undefined, externalCc?: boolean, input?: TrackLanguageInput): string | undefined {
  if (external !== undefined && externalCc) return external ? `${external} CC` : 'CC';
  if (external !== undefined) return external ? `${external} subtitles` : 'Subtitles';
  const at = text.findIndex((x) => x.active);
  const t = text[at];
  if (!t) return undefined;
  const lang = languageAt(text, at, 'subtitle', input);
  if (t.forced || FORCED.test(t.label)) return lang ? `${lang} forced` : 'Forced subtitles';
  if (t.hearingImpaired || HEARING_IMPAIRED.test(t.label)) return lang ? `${lang} CC` : 'CC';
  return lang ? `${lang} subtitles` : 'Subtitles';
}

export function mediaBadges(input: MediaBadgeInput): string[] {
  const { info, hint, audio, text, external, externalCc, languages } = input;
  const activeAt = audio.findIndex((t) => t.active);
  const aAt = activeAt >= 0 ? activeAt : audio.length === 1 ? 0 : -1;
  const a = audio[aAt];
  const sound = [
    channelsLabel(a?.channels ?? info.audioChannels),
    a?.codec ?? codecFamily(info.audioCodec),
    a?.atmos ? 'Atmos' : undefined,
  ].filter(Boolean).join(' ');
  return [
    qualityLabel(info.width, info.height, info.scan),
    rangeLabel(info, hint),
    fpsLabel(info.fps),
    videoCodecLabel(info.videoCodec),
    languageAt(audio, aAt, 'audio', languages),
    sound || undefined,
    subtitleBadge(text, external, externalCc, languages),
    info.bitrate && info.bitrate > 0 ? formatBitrate(info.bitrate) : undefined,
  ].filter((b): b is string => Boolean(b));
}

/** Inner padding either side of a badge's text, and the gap between badges. */
export const BADGE_PAD = SPACE.m;
export const BADGE_GAP = SPACE.s;

export interface PlacedBadge { text: string; x: number; width: number }

/**
 * Lays the badges out left to right from x 0 (`textWidth` measures one badge's text). Badges that would cross
 * `maxWidth` are dropped, so the row never runs off its area; the earlier (more important) ones stay.
 */
export function layoutBadges(badges: readonly string[], textWidth: (text: string) => number, maxWidth: number): PlacedBadge[] {
  const out: PlacedBadge[] = [];
  let x = 0;
  for (const text of badges) {
    const width = Math.ceil(textWidth(text)) + BADGE_PAD * 2;
    if (x + width > maxWidth) break;
    out.push({ text, x, width });
    x += width + BADGE_GAP;
  }
  return out;
}

/** The row's width: from the first badge's left edge to the last one's right edge (0 when empty). */
export const badgesWidth = (placed: readonly PlacedBadge[]): number => {
  const last = placed[placed.length - 1];
  return last ? last.x + last.width : 0;
};
