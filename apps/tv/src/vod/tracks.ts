import { englishLanguageName } from '@iptv/core';
import type { TrackInfo } from '@iptv/player';
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

/** English names for the language codes streams commonly carry (ISO 639-1 and 639-2, both 639-2 forms). */
export const LANGUAGE_NAMES: Record<string, string> = {
  ar: 'Arabic', ara: 'Arabic', cs: 'Czech', ces: 'Czech', cze: 'Czech', da: 'Danish', dan: 'Danish', de: 'German',
  deu: 'German', ger: 'German', el: 'Greek', ell: 'Greek', gre: 'Greek', en: 'English', eng: 'English', es: 'Spanish',
  spa: 'Spanish', fa: 'Persian', fas: 'Persian', per: 'Persian', fi: 'Finnish', fin: 'Finnish', fr: 'French',
  fra: 'French', fre: 'French', he: 'Hebrew', heb: 'Hebrew', hi: 'Hindi', hin: 'Hindi', hu: 'Hungarian',
  hun: 'Hungarian', id: 'Indonesian', ind: 'Indonesian', it: 'Italian', ita: 'Italian', ja: 'Japanese', jpn: 'Japanese',
  ko: 'Korean', kor: 'Korean', nb: 'Norwegian', nob: 'Norwegian', no: 'Norwegian', nor: 'Norwegian', nl: 'Dutch',
  nld: 'Dutch', dut: 'Dutch', pl: 'Polish', pol: 'Polish', pt: 'Portuguese', por: 'Portuguese', ro: 'Romanian',
  ron: 'Romanian', rum: 'Romanian', ru: 'Russian', rus: 'Russian', sv: 'Swedish', swe: 'Swedish', th: 'Thai',
  tha: 'Thai', tr: 'Turkish', tur: 'Turkish', uk: 'Ukrainian', ukr: 'Ukrainian', vi: 'Vietnamese', vie: 'Vietnamese',
  zh: 'Chinese', zho: 'Chinese', chi: 'Chinese',
};

/**
 * A language code's English name ("pt-BR", "ENG", "ger" and less common codes such as "ice" too); undefined for an
 * undetermined (`und`) or unrecognised code.
 */
export function languageName(code: string): string | undefined {
  return LANGUAGE_NAMES[code.toLowerCase().split(/[-_]/)[0] ?? ''] ?? englishLanguageName(code);
}

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

/**
 * A track's display label: a bare language code (AVPlay labels tracks by language only) becomes its English name;
 * any other label is kept. The codec family follows in parentheses where the engine knows it ("Svenska (AC-3)").
 * Labels that repeat get " (2)", " (3)" in list order.
 */
export function trackLabels(tracks: readonly TrackInfo[]): string[] {
  const seen = new Map<string, number>();
  return tracks.map((t) => {
    const raw = oneSpace(t.label);
    // A bare code (or no label at all) names the language; an untagged track says so rather than showing "und".
    const bare = raw === '' || /^[a-z]{2,3}([-_][a-z0-9]{2,4})?$/i.test(raw);
    const name = bare ? languageName(raw) ?? (t.language ? languageName(t.language) : undefined) ?? (raw && !/^und$/i.test(raw) ? raw : 'Unknown language') : raw;
    const base = t.codec ? `${name} (${t.codec})` : name;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

/** "Audio & subtitles" picker rows: audio tracks, then subtitles, then "Subtitles off"; the active ones are checked. */
export function trackRows(audio: readonly TrackInfo[], text: readonly TrackInfo[]): PickerRow[] {
  const audioLabels = trackLabels(audio);
  const textLabels = trackLabels(text);
  return [
    ...audio.map((t, i): PickerRow => ({ kind: 'list', id: `a:${t.id}`, label: `Audio: ${audioLabels[i]}`, checked: t.active })),
    ...text.map((t, i): PickerRow => ({ kind: 'list', id: `s:${t.id}`, label: `Subtitles: ${textLabels[i]}`, checked: t.active })),
    { kind: 'list', id: SUBTITLES_OFF, label: 'Subtitles off', checked: !text.some((t) => t.active) },
  ];
}

const isForced = (t: TrackInfo) => /\bforced\b/i.test(t.label);

/**
 * The track in the preferred language (`code`, ISO 639-1; 'off' or 'auto': none): by the track's language tag (2- and
 * 3-letter codes both match), else by a label that names the language or is its bare code. A full track wins over a
 * forced one (forced subtitles only cover foreign-language lines).
 */
export function preferredTrack(tracks: readonly TrackInfo[], code: string): TrackInfo | undefined {
  const name = code === 'off' || code === 'auto' ? undefined : languageName(code);
  if (!name) return undefined;
  const byLang = tracks.filter((t) => t.language !== undefined && languageName(t.language) === name);
  const lower = name.toLowerCase();
  const matches = byLang.length > 0
    ? byLang
    : tracks.filter((t) => t.label.toLowerCase().includes(lower) || languageName(t.label.trim()) === name);
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
