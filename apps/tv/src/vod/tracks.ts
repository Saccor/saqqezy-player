import type { LanguageHints } from '@iptv/app-api';
import { englishLanguageName, isoLanguage, languageFromLabel, prefixLang } from '@iptv/core';
import type { TrackInfo } from '@iptv/player';
import { VOD_COPY } from '../copy.ts';
import type { PickerRow } from '../screens/homeMenuLogic.ts';

/**
 * Audio and subtitle track helpers shared by the VOD player and the live Player: keys for remembered choices, display
 * labels (language names, codec, dedupe), the preferred-language pick and the audio auto-pick.
 */

/** Collapses runs of whitespace (a double space breaks Lightning text layout) and trims. */
export function oneSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Picker row id for "Subtitles off": unprefixed, so no track row (`a:<id>`, `s:<id>`) can produce it. */
export const SUBTITLES_OFF = 'off';

/**
 * What a remembered track choice stores: `<language>:<label>` (language may be empty). Engine ids change per open, and
 * two tracks often share a language (main and commentary), so both are kept. The codec is not part of it.
 */
export function trackKey(t: TrackInfo): string {
  return `${t.language ?? ''}:${t.label}`;
}

/**
 * The track matching a remembered choice: language and label, then the language alone, then the label alone. A key
 * without ':' (an older bare language or label) matches by language, then by label.
 */
export function findTrack(tracks: readonly TrackInfo[], want: string | undefined): TrackInfo | undefined {
  if (!want) return undefined;
  const at = want.indexOf(':');
  if (at < 0) return tracks.find((t) => t.language === want) ?? tracks.find((t) => t.label === want);
  const lang = want.slice(0, at);
  const label = want.slice(at + 1);
  return tracks.find((t) => (t.language ?? '') === lang && t.label === label)
    ?? (lang ? tracks.find((t) => t.language === lang) : undefined)
    ?? tracks.find((t) => t.label === label);
}

export type TrackKind = 'audio' | 'subtitle';

/** What is known about a stream's languages besides its tracks' own data (spec 2026-10-22-track-languages). */
export interface TrackLanguageInput {
  /** What the source says about the title (`VodPlayable.languageHints`) or the channel's name prefix. */
  hints?: LanguageHints;
  /** Subtitle languages detected from the cue text this open, by engine track id. */
  detected?: Readonly<Record<string, string>>;
}

/**
 * Each track's language (ISO 639-1), first signal that names one: the track's language code (`und` counts as none),
 * its label, the language detected from its cues; then the source's hints for tracks still without one: the probe
 * data's language for the first audio track, and the title prefix (audio or subtitles, as it names) for the only
 * track without a language when no other track has that language. Undefined when nothing names one.
 */
export function trackLanguages(tracks: readonly TrackInfo[], kind: TrackKind, input?: TrackLanguageInput): (string | undefined)[] {
  const detected = kind === 'subtitle' ? input?.detected : undefined;
  const out = tracks.map((t) => isoLanguage(t.language) ?? languageFromLabel(t.label) ?? isoLanguage(detected?.[t.id]));
  const hints = input?.hints;
  if (!hints) return out;
  if (kind === 'audio' && hints.firstAudio && out.length > 0 && out[0] === undefined) out[0] = isoLanguage(hints.firstAudio);
  const title = isoLanguage(hints.title);
  const scope: TrackKind = hints.titleScope === 'subtitles' ? 'subtitle' : 'audio';
  if (title && scope === kind && !out.includes(title)) {
    const missing = out.flatMap((l, i) => (l === undefined ? [i] : []));
    if (missing.length === 1) out[missing[0]!] = title;
  }
  return out;
}

/** A live channel's language hint: the language prefix of its name ("SE | …"), else of its group's. */
export function channelLanguageInput(name: string | undefined, group: string | undefined): TrackLanguageInput | undefined {
  const lang = (name ? prefixLang(name) : undefined) ?? (group ? prefixLang(group) : undefined);
  return lang ? { hints: { title: lang, titleScope: 'audio' } } : undefined;
}

/** "Mono", "Stereo", "5.1", "7.1" for a channel count; undefined when unknown. */
export function channelsLabel(n: number | undefined): string | undefined {
  if (!n || n <= 0) return undefined;
  if (n === 1) return 'Mono';
  if (n === 2) return 'Stereo';
  return `${n - 1}.1`;
}

/** A label that says nothing of its own: empty, a bare code, or an engine's placeholder ("Track 3", "Subtitles 1"). */
const PLACEHOLDER = /^(?:|[a-z]{2,3}(?:[-_][a-z0-9]{2,4})?|(?:track|audio|sound|subtitles?|text|cc)\s*\d*)$/i;

/**
 * Track display labels, never "Unknown". A label that says nothing (a bare code, "Track 3") becomes the language's
 * name, or "Audio 2" / "Subtitle 1" when no language is known at all. A descriptive label is kept, after the language
 * when it does not name it ("English · Commentary"). Codec and channels follow in parentheses where known ("Swedish
 * (AC-3 5.1)"); labels that repeat get " (2)", " (3)" in list order.
 */
export function trackLabels(tracks: readonly TrackInfo[], kind: TrackKind, input?: TrackLanguageInput): string[] {
  const langs = trackLanguages(tracks, kind, input);
  const seen = new Map<string, number>();
  return tracks.map((t, i) => {
    const raw = oneSpace(t.label);
    const lang = langs[i];
    const name = lang ? englishLanguageName(lang) : undefined;
    let base: string;
    if (PLACEHOLDER.test(raw)) base = name ?? `${kind === 'audio' ? 'Audio' : 'Subtitle'} ${i + 1}`;
    else base = name && !languageFromLabel(raw) ? `${name} · ${raw}` : raw;
    const channels = channelsLabel(t.channels);
    const extra = [t.codec, channels && !raw.toLowerCase().includes(channels.toLowerCase()) ? channels : undefined].filter(Boolean);
    const full = extra.length > 0 ? `${base} (${extra.join(' ')})` : base;
    const n = (seen.get(full) ?? 0) + 1;
    seen.set(full, n);
    return n === 1 ? full : `${full} (${n})`;
  });
}

/** "Audio & subtitles" picker rows: audio tracks, then subtitles, then "Subtitles off"; the active ones are checked. */
export function trackRows(audio: readonly TrackInfo[], text: readonly TrackInfo[], input?: TrackLanguageInput): PickerRow[] {
  const audioLabels = trackLabels(audio, 'audio', input);
  const textLabels = trackLabels(text, 'subtitle', input);
  return [
    ...audio.map((t, i): PickerRow => ({ kind: 'list', id: `a:${t.id}`, label: VOD_COPY.audioRow(String(audioLabels[i])), checked: t.active })),
    ...text.map((t, i): PickerRow => ({ kind: 'list', id: `s:${t.id}`, label: VOD_COPY.subtitlesRow(String(textLabels[i])), checked: t.active })),
    { kind: 'list', id: SUBTITLES_OFF, label: VOD_COPY.subtitlesOff, checked: !text.some((t) => t.active) },
  ];
}

const isForced = (t: TrackInfo) => /\bforced\b/i.test(t.label);

/**
 * The track in the preferred language (`code`, ISO 639-1; 'off' or 'auto': none): by the track's language tag (2- and
 * 3-letter codes both match), else by a label that names the language or is its bare code. A full track wins over a
 * forced one (forced subtitles only cover foreign-language lines).
 */
export function preferredTrack(tracks: readonly TrackInfo[], code: string): TrackInfo | undefined {
  const name = code === 'off' || code === 'auto' ? undefined : englishLanguageName(code);
  if (!name) return undefined;
  const byLang = tracks.filter((t) => {
    const lang = isoLanguage(t.language) ?? languageFromLabel(t.label);
    return lang !== undefined && englishLanguageName(lang) === name;
  });
  const lower = name.toLowerCase();
  const matches = byLang.length > 0
    ? byLang
    : tracks.filter((t) => t.label.toLowerCase().includes(lower) || englishLanguageName(t.label.trim()) === name);
  return matches.find((t) => !isForced(t)) ?? matches[0];
}

/**
 * The audio track to turn on when a title or channel starts: the remembered choice (`remembered`, a `trackKey`) when
 * the stream has it; else, with a preferred language from Settings (`preferred`, ISO 639-1; 'auto': none), the first
 * track in that language; else undefined, which leaves the engine's own default alone.
 */
export function pickAudioTrack(tracks: readonly TrackInfo[], remembered: string | undefined, preferred: string): TrackInfo | undefined {
  return findTrack(tracks, remembered) ?? (preferred !== 'auto' ? preferredTrack(tracks, preferred) : undefined);
}

/**
 * The audio codec family a stream's codec string names, for track labels: hls.js rendition `audioCodec` ("mp4a.40.2",
 * "ac-3", "ec-3") and AVPlay `fourCC` ("AAC", "AC3", "EAC3", "DTS", "TRUEHD", "MP3"). Undefined when unknown, so the
 * label stays clean rather than showing a raw string.
 */
export function codecFamily(codec: string | undefined): string | undefined {
  if (!codec) return undefined;
  const c = codec.trim().toLowerCase();
  if (c === 'ec-3' || c === 'ec3' || c === 'eac3' || c === 'e-ac-3' || c === 'eac-3') return 'E-AC-3';
  if (c === 'ac-3' || c === 'ac3') return 'AC-3';
  if (c === 'mp3' || c === 'mpga' || c === 'mp4a.40.34' || c === 'mp4a.6b' || c === 'mp4a.69') return 'MP3';
  if (c === 'aac' || c === 'mp4a' || c.startsWith('mp4a.40') || c.startsWith('aac')) return 'AAC';
  if (c === 'truehd' || c === 'mlpa' || c === 'mlp') return 'TrueHD';
  if (c.startsWith('dts')) return 'DTS';
  if (c === 'opus') return 'Opus';
  return undefined;
}
