import type { TrackInfo } from '@iptv/player';
import type { PickerRow } from '../screens/homeMenuLogic.ts';
import { LANGUAGE_NAMES, SUBTITLE_KEY_OFF, findTrack } from './vodPlayerLogic.ts';


/**
 * The Settings choices for the subtitle language: the same list as core's `SUBTITLE_LANGUAGES` (a test keeps them
 * equal; core stays out of the main-thread bundle).
 */
export const SUBTITLE_LANGUAGE_OPTIONS: readonly string[] = [
  'off', 'ar', 'zh', 'cs', 'da', 'nl', 'en', 'fi', 'fr', 'de', 'el', 'he', 'hi', 'hu', 'id', 'it', 'ja', 'ko', 'no', 'fa',
  'pl', 'pt', 'ro', 'ru', 'es', 'sv', 'th', 'tr', 'uk', 'vi',
];

/** A language code's English name ("pt-BR", "ENG" and "ger" too); undefined when unknown. */
export function languageName(code: string): string | undefined {
  return LANGUAGE_NAMES[code.toLowerCase().split(/[-_]/)[0] ?? ''];
}

export const subtitleLanguageLabel = (code: string): string => (code === 'off' ? 'Off' : languageName(code) ?? code);

const isForced = (t: TrackInfo) => /\bforced\b/i.test(t.label);

/**
 * The subtitle track in the preferred language (`code`, ISO 639-1; 'off': none): by the track's language tag, else
 * by a label that names the language or is its bare code. A full track wins over a forced one (forced tracks only
 * cover foreign-language lines).
 */
export function preferredTrack(tracks: readonly TrackInfo[], code: string): TrackInfo | undefined {
  const name = code === 'off' ? undefined : languageName(code);
  if (!name) return undefined;
  const byLang = tracks.filter((t) => t.language !== undefined && languageName(t.language) === name);
  const lower = name.toLowerCase();
  const matches = byLang.length > 0
    ? byLang
    : tracks.filter((t) => t.label.toLowerCase().includes(lower) || languageName(t.label.trim()) === name);
  return matches.find((t) => !isForced(t)) ?? matches[0];
}

/** What a remembered subtitle choice stores for "the file the user loaded" (`trackKey` always contains ':'). */
export const SUBTITLE_KEY_EXT = 'ext';

export type SubtitlePick = { kind: 'external' } | { kind: 'off' } | { kind: 'track'; id: string } | { kind: 'keep' };

/**
 * Which subtitle to show when a title starts: the loaded file when it was chosen and exists; off when off was chosen;
 * a remembered track; otherwise the preferred language. 'keep' leaves the engine's own default alone.
 */
export function pickSubtitle(s: {
  chosen: string | undefined;
  texts: readonly TrackInfo[];
  hasExternal: boolean;
  preferred: string;
}): SubtitlePick {
  if (s.chosen === SUBTITLE_KEY_EXT && s.hasExternal) return { kind: 'external' };
  if (s.chosen === SUBTITLE_KEY_OFF) return { kind: 'off' };
  const remembered = s.chosen && s.chosen !== SUBTITLE_KEY_EXT ? findTrack(s.texts, s.chosen) : undefined;
  const t = remembered ?? preferredTrack(s.texts, s.preferred);
  return t ? { kind: 'track', id: t.id } : { kind: 'keep' };
}

/** Picker row ids (unprefixed, so no track row `a:<id>` / `s:<id>` or Off can produce them). */
export const SUBTITLE_EXT_ROW = 'ext';
export const LOAD_URL_ROW = 'loadUrl';
export const LOAD_FILE_ROW = 'loadFile';
export const REMOVE_EXT_ROW = 'removeExt';

/** The "Audio & subtitles" rows after the tracks: the loaded file, the load actions, and remove. */
export function subtitleExtraRows(s: { external?: { name: string; active: boolean }; canLoadFile: boolean }): PickerRow[] {
  const rows: PickerRow[] = [];
  if (s.external) rows.push({ kind: 'list', id: SUBTITLE_EXT_ROW, label: `Subtitles: ${s.external.name} (loaded)`, checked: s.external.active });
  rows.push({ kind: 'list', id: LOAD_URL_ROW, label: 'Load subtitles from a link…', checked: false });
  if (s.canLoadFile) rows.push({ kind: 'list', id: LOAD_FILE_ROW, label: 'Load subtitles from a file…', checked: false });
  if (s.external) rows.push({ kind: 'list', id: REMOVE_EXT_ROW, label: 'Remove loaded subtitles', checked: false });
  return rows;
}
