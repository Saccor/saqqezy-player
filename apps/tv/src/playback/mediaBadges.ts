import type { VideoRange } from '@iptv/core';
import type { StreamInfo, TrackInfo } from '@iptv/player';
import { codecFamily, languageName } from '../vod/tracks.ts';
import { formatBitrate } from './streamInfo.ts';

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

function channelsLabel(n: number | undefined): string | undefined {
  if (!n || n <= 0) return undefined;
  if (n === 1) return 'Mono';
  if (n === 2) return 'Stereo';
  return `${n - 1}.1`;
}

/** A track's language name: its language tag, else a label that is a bare code or a language's name. */
function trackLanguage(t: TrackInfo): string | undefined {
  const byTag = t.language ? languageName(t.language) : undefined;
  if (byTag) return byTag;
  const label = t.label.trim();
  return label ? languageName(label) : undefined;
}

const HEARING_IMPAIRED = /\b(sdh|cc|hoh|hearing)\b/i;
const FORCED = /\bforced\b/i;

function subtitleBadge(text: readonly TrackInfo[], external: string | undefined, externalCc?: boolean): string | undefined {
  if (external !== undefined && externalCc) return external ? `${external} CC` : 'CC';
  if (external !== undefined) return external ? `${external} subtitles` : 'Subtitles';
  const t = text.find((x) => x.active);
  if (!t) return undefined;
  const lang = trackLanguage(t);
  if (t.forced || FORCED.test(t.label)) return lang ? `${lang} forced` : 'Forced subtitles';
  if (t.hearingImpaired || HEARING_IMPAIRED.test(t.label)) return lang ? `${lang} CC` : 'CC';
  return lang ? `${lang} subtitles` : 'Subtitles';
}

export function mediaBadges(input: MediaBadgeInput): string[] {
  const { info, hint, audio, text, external, externalCc } = input;
  const a = audio.find((t) => t.active) ?? (audio.length === 1 ? audio[0] : undefined);
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
    a ? trackLanguage(a) : undefined,
    sound || undefined,
    subtitleBadge(text, external, externalCc),
    info.bitrate && info.bitrate > 0 ? formatBitrate(info.bitrate) : undefined,
  ].filter((b): b is string => Boolean(b));
}

/** Inner padding either side of a badge's text, and the gap between badges. */
export const BADGE_PAD = 14;
export const BADGE_GAP = 10;

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
