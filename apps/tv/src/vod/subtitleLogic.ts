import type { TrackInfo } from '@iptv/player';
import type { PickerRow } from '../screens/homeMenuLogic.ts';
import { SUBTITLE_KEY_OFF } from './vodPlayerLogic.ts';
import { findTrack, languageName, preferredTrack } from './tracks.ts';

/** `languageName` and `preferredTrack` moved to `tracks.ts`; re-exported so existing imports keep working. */
export { languageName, preferredTrack } from './tracks.ts';

/**
 * The Settings choices for the subtitle language: the same list as core's `SUBTITLE_LANGUAGES` (a test keeps them
 * equal; core stays out of the main-thread bundle).
 */
export const SUBTITLE_LANGUAGE_OPTIONS: readonly string[] = [
  'off', 'ar', 'zh', 'cs', 'da', 'nl', 'en', 'fi', 'fr', 'de', 'el', 'he', 'hi', 'hu', 'id', 'it', 'ja', 'ko', 'no', 'fa',
  'pl', 'pt', 'ro', 'ru', 'es', 'sv', 'th', 'tr', 'uk', 'vi',
];

export const subtitleLanguageLabel = (code: string): string => (code === 'off' ? 'Off' : languageName(code) ?? code);

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
export const FIND_ONLINE_ROW = 'findOnline';
export const DELAY_ROW = 'subDelay';
export const DELAY_EARLIER_ROW = 'subEarlier';
export const DELAY_LATER_ROW = 'subLater';
export const ANOTHER_VERSION_ROW = 'subAnother';

/** One Left/Right press on the delay row; the pointer rows step further. */
export const DELAY_STEP_MS = 100;
export const DELAY_POINTER_STEP_MS = 500;
const DELAY_MAX_MS = 60_000;

/** "+1.2 s", "−0.5 s", "0.0 s". */
export function delayLabel(ms: number): string {
  const s = (Math.abs(ms) / 1000).toFixed(1);
  return ms > 0 ? `+${s} s` : ms < 0 ? `−${s} s` : `${s} s`;
}

/** The delay after one step later (1) or earlier (-1), on the 0.1 s grid, within ±60 s. */
export function stepDelay(ms: number, dir: 1 | -1, step = DELAY_STEP_MS): number {
  const next = Math.round((ms + dir * step) / DELAY_STEP_MS) * DELAY_STEP_MS;
  return Math.max(-DELAY_MAX_MS, Math.min(DELAY_MAX_MS, next)) + 0;
}

/**
 * The "Audio & subtitles" rows after the tracks: the loaded file, its delay (while it shows) and another version
 * (a file found online with more than one), find online, the load actions, and remove.
 */
export function subtitleExtraRows(s: {
  external?: { name: string; active: boolean };
  /** The loaded file's delay (the row shows while the file is on). */
  delayMs?: number;
  /** Pointer mode: the delay also gets earlier/later rows to click. */
  pointer?: boolean;
  /** The loaded file came from "Find subtitles online": its language's versions and which one shows. */
  another?: { label: string; index: number; total: number };
  canLoadFile: boolean;
  canSearchOnline?: boolean;
}): PickerRow[] {
  const rows: PickerRow[] = [];
  if (s.external) rows.push({ kind: 'list', id: SUBTITLE_EXT_ROW, label: `Subtitles: ${s.external.name} (loaded)`, checked: s.external.active });
  if (s.external?.active) {
    rows.push({ kind: 'list', id: DELAY_ROW, label: `Subtitle delay: ${delayLabel(s.delayMs ?? 0)} (Left/Right)`, checked: false });
    if (s.pointer) {
      rows.push({ kind: 'list', id: DELAY_EARLIER_ROW, label: `Subtitles ${DELAY_POINTER_STEP_MS / 1000} s earlier`, checked: false });
      rows.push({ kind: 'list', id: DELAY_LATER_ROW, label: `Subtitles ${DELAY_POINTER_STEP_MS / 1000} s later`, checked: false });
    }
    if (s.another && s.another.total > 1) {
      const next = (s.another.index + 1) % s.another.total;
      rows.push({ kind: 'list', id: ANOTHER_VERSION_ROW, label: `Try another ${s.another.label} version (${next + 1} of ${s.another.total})`, checked: false });
    }
  }
  if (s.canSearchOnline) rows.push({ kind: 'list', id: FIND_ONLINE_ROW, label: 'Find subtitles online…', checked: false });
  rows.push({ kind: 'list', id: LOAD_URL_ROW, label: 'Load subtitles from a link…', checked: false });
  if (s.canLoadFile) rows.push({ kind: 'list', id: LOAD_FILE_ROW, label: 'Load subtitles from a file…', checked: false });
  if (s.external) rows.push({ kind: 'list', id: REMOVE_EXT_ROW, label: 'Remove loaded subtitles', checked: false });
  return rows;
}

/** One language found online, as the worker lists it. */
export interface OnlineLanguage { language: string; count: number; fileId: number; files?: number[]; synced?: boolean }

const ONLINE_PREFIX = 'os:';

/** A language code's display name: "Swedish", "Portuguese (BR)" for a regional variant, the code itself when unknown. */
export function onlineLanguageLabel(code: string): string {
  const [lang = '', region] = code.split(/[-_]/);
  const name = languageName(lang);
  if (!name) return code.toUpperCase();
  return region ? `${name} (${region.toUpperCase()})` : name;
}

/** The "Subtitles online" picker: one row per language, its id carrying the file a click loads. */
export function onlineLanguageRows(langs: readonly OnlineLanguage[]): PickerRow[] {
  return langs.map((l) => ({
    kind: 'list', id: `${ONLINE_PREFIX}${l.fileId}`, checked: false,
    label: l.synced ? `${onlineLanguageLabel(l.language)} · matches this file` : onlineLanguageLabel(l.language),
  }));
}

/** The file id a "Subtitles online" row loads; undefined for any other row. */
export function onlineFileId(rowId: string): number | undefined {
  if (!rowId.startsWith(ONLINE_PREFIX)) return undefined;
  const n = Number(rowId.slice(ONLINE_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
