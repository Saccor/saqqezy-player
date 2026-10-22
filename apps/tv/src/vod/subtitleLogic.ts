import { detectTextLanguage, languageFromFileName, type LoadedSubtitle } from '@iptv/core';
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

/** The Settings choices for the audio language: 'auto' (the stream's default track), then the subtitle languages. */
export const AUDIO_LANGUAGE_OPTIONS: readonly string[] = ['auto', ...SUBTITLE_LANGUAGE_OPTIONS.filter((c) => c !== 'off')];

export const audioLanguageLabel = (code: string): string => (code === 'auto' ? 'Stream default' : languageName(code) ?? code);

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
export const SPEED_ROW = 'subSpeed';

/** A subtitle timed for 25 fps on a 23.976 fps video (its cues come ever earlier without this). */
export const SPEED_PAL_TO_FILM = 23.976 / 25;
/** A subtitle timed for 23.976 fps on a 25 fps video. */
export const SPEED_FILM_TO_PAL = 25 / 23.976;
/** The speed choices, in Left/Right order: Normal, 25 → 23.976, 23.976 → 25. */
export const SUBTITLE_SPEEDS: readonly number[] = [1, SPEED_PAL_TO_FILM, SPEED_FILM_TO_PAL];
/** 1, SPEED_PAL_TO_FILM or SPEED_FILM_TO_PAL: how much faster subtitle time runs than the video's. */
export type SubtitleSpeed = number;
export const SPEED_HELP = 'Fixes subtitles that drift further off as the film goes on';

/** Frame rates closer than this are the same rate (30 and 29.97 differ by 0.1%: no visible drift in a film). */
const FPS_SAME = 0.5;
/** How close videoFps / subFps must be to a factor for the automatic speed (24 vs 25 counts; 24 vs 23.976 does not differ). */
const AUTO_SPEED_TOLERANCE = 0.005;

/** The time in the subtitle file to show at the video's `positionMs`: the delay first, then the speed. */
export function subtitleTime(positionMs: number, delayMs: number, speed: SubtitleSpeed): number {
  return (positionMs - delayMs) * speed;
}

const knownFps = (fps: number | undefined): fps is number => fps !== undefined && Number.isFinite(fps) && fps > 0;

/** The saved speed as one of SUBTITLE_SPEEDS (the nearest, within 1%); anything else (or none) is Normal. */
export function normalizeSpeed(speed: number | undefined): SubtitleSpeed {
  if (speed === undefined || !Number.isFinite(speed)) return 1;
  let best = 1;
  for (const s of SUBTITLE_SPEEDS) if (Math.abs(s - speed) < Math.abs(best - speed)) best = s;
  return Math.abs(best - speed) / best < 0.01 ? best : 1;
}

/**
 * The speed that fits a subtitle timed for `subFps` to a video at `videoFps`: video time to subtitle time is
 * videoFps / subFps, snapped to the nearer of the two factors. Normal when either rate is unknown or they are the same.
 */
export function autoSpeed(subFps?: number, videoFps?: number): SubtitleSpeed {
  if (!knownFps(subFps) || !knownFps(videoFps) || Math.abs(subFps - videoFps) <= FPS_SAME) return 1;
  // Only the 24/25 pairs: 25 vs 50 or 23.976 vs 29.97 is no speed difference a fixed factor fixes.
  const ratio = videoFps / subFps;
  for (const s of [SPEED_PAL_TO_FILM, SPEED_FILM_TO_PAL]) if (Math.abs(ratio - s) / s <= AUTO_SPEED_TOLERANCE) return s;
  return 1;
}

/** "Normal", "25 → 23.976", "23.976 → 25". */
export function speedLabel(speed: SubtitleSpeed): string {
  const s = normalizeSpeed(speed);
  return s === SPEED_PAL_TO_FILM ? '25 → 23.976' : s === SPEED_FILM_TO_PAL ? '23.976 → 25' : 'Normal';
}

/** The next (1) or previous (-1) speed, wrapping. */
export function stepSpeed(speed: SubtitleSpeed, dir: 1 | -1): SubtitleSpeed {
  const n = SUBTITLE_SPEEDS.length;
  const i = SUBTITLE_SPEEDS.indexOf(normalizeSpeed(speed));
  return SUBTITLE_SPEEDS[(i + dir + n) % n] ?? 1;
}

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

/** A subtitle file the source lists, as the player gets it (`VodPlayable.subtitles`; its link is never shown). */
export interface SourceSubtitleInfo { url: string; language?: string; label?: string }

const SOURCE_PREFIX = 'src:';

/**
 * A source file's name: its label, else its language, then where it comes from. The worker names a loaded source
 * file the same way (`sourceSubtitleName` in app-api), so the picker can tell which one is loaded.
 */
export function sourceSubtitleName(sub: SourceSubtitleInfo): string {
  const what = sub.label?.trim() || (sub.language ? languageName(sub.language) : undefined) || 'Subtitles';
  return `${what} (from source)`;
}

/**
 * A loaded file's language: the one stored with it (given, found online, or inferred on load), else its file name's
 * ("Film.sv.srt"), else its first cues' text (files loaded before languages were inferred). ISO 639-1, maybe with a
 * region; undefined when nothing tells.
 */
export function loadedLanguage(loaded: LoadedSubtitle): string | undefined {
  return loaded.language ?? loaded.online?.language ?? languageFromFileName(loaded.name)
    ?? detectTextLanguage(loaded.cues.slice(0, DETECT_CUES).map((c) => c.text).join('\n'));
}

/** How many of a loaded file's cues `loadedLanguage` reads. */
const DETECT_CUES = 40;

/** A loaded file's row name: its language first when its name does not say it ("Swedish · subs.srt"). */
function externalName(ext: { name: string; language?: string }): string {
  const lang = ext.language ? languageName(ext.language.split(/[-_]/)[0] ?? '') : undefined;
  return lang && !languageFromFileName(ext.name) ? `${lang} · ${ext.name}` : ext.name;
}

/** The index of the source file a picker row loads; undefined for any other row. */
export function sourceRowIndex(rowId: string): number | undefined {
  if (!rowId.startsWith(SOURCE_PREFIX)) return undefined;
  const n = Number(rowId.slice(SOURCE_PREFIX.length));
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * The "Audio & subtitles" rows after the tracks: the loaded file, its delay and speed (while it shows) and another
 * version (a file found online: the row opens its language's versions), find online, the load actions, and remove.
 */
export function subtitleExtraRows(s: {
  /** Subtitle files the source lists (`VodPlayable.subtitles`): a row each, first. */
  source?: readonly SourceSubtitleInfo[];
  /** The loaded file: its name, whether it shows, and its language (`loadedLanguage`) when known. */
  external?: { name: string; active: boolean; language?: string };
  /** The loaded file's delay (the row shows while the file is on). */
  delayMs?: number;
  /** Pointer mode: the delay also gets earlier/later rows to click. */
  pointer?: boolean;
  /** The loaded file's speed (Normal when not given). */
  speed?: SubtitleSpeed;
  /** The loaded file came from "Find subtitles online": its language's name (the row opens its versions). */
  another?: { label: string };
  canLoadFile: boolean;
  canSearchOnline?: boolean;
}): PickerRow[] {
  const rows: PickerRow[] = [];
  // The loaded file is one of the source's: its source row is checked and it is not listed a second time.
  let loadedIsSource = false;
  (s.source ?? []).forEach((sub, i) => {
    const name = sourceSubtitleName(sub);
    const isLoaded = s.external?.name === name;
    loadedIsSource ||= isLoaded;
    rows.push({ kind: 'list', id: `${SOURCE_PREFIX}${i}`, label: `Subtitles: ${name}`, checked: isLoaded && s.external?.active === true });
  });
  if (s.external && !loadedIsSource) {
    rows.push({ kind: 'list', id: SUBTITLE_EXT_ROW, label: `Subtitles: ${externalName(s.external)} (loaded)`, checked: s.external.active });
  }
  if (s.external?.active) {
    rows.push({ kind: 'list', id: DELAY_ROW, label: `Subtitle delay: ${delayLabel(s.delayMs ?? 0)} (Left/Right)`, checked: false });
    if (s.pointer) {
      rows.push({ kind: 'list', id: DELAY_EARLIER_ROW, label: `Subtitles ${DELAY_POINTER_STEP_MS / 1000} s earlier`, checked: false });
      rows.push({ kind: 'list', id: DELAY_LATER_ROW, label: `Subtitles ${DELAY_POINTER_STEP_MS / 1000} s later`, checked: false });
    }
    rows.push({ kind: 'list', id: SPEED_ROW, label: `Subtitle speed: ${speedLabel(s.speed ?? 1)} (Left/Right)`, checked: false, help: SPEED_HELP });
    if (s.another) rows.push({ kind: 'list', id: ANOTHER_VERSION_ROW, label: `Try another ${s.another.label} version…`, checked: false });
  }
  if (s.canSearchOnline) rows.push({ kind: 'list', id: FIND_ONLINE_ROW, label: 'Find subtitles online…', checked: false });
  rows.push({ kind: 'list', id: LOAD_URL_ROW, label: 'Load subtitles from a link…', checked: false });
  if (s.canLoadFile) rows.push({ kind: 'list', id: LOAD_FILE_ROW, label: 'Load subtitles from a file…', checked: false });
  if (s.external) rows.push({ kind: 'list', id: REMOVE_EXT_ROW, label: 'Remove loaded subtitles', checked: false });
  return rows;
}

/** One language found online, as the worker lists it. */
export interface OnlineLanguage { language: string; count: number; fileId: number; files?: number[]; synced?: boolean; fps?: number; cc?: boolean }

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
  return langs.map((l) => {
    const name = l.cc ? `${onlineLanguageLabel(l.language)} CC` : onlineLanguageLabel(l.language);
    return { kind: 'list', id: `${ONLINE_PREFIX}${l.fileId}`, checked: false, label: l.synced ? `${name} · matches this file` : name };
  });
}

/** The file id a "Subtitles online" row loads; undefined for any other row. */
export function onlineFileId(rowId: string): number | undefined {
  if (!rowId.startsWith(ONLINE_PREFIX)) return undefined;
  const n = Number(rowId.slice(ONLINE_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** One version of a language's subtitles, as the worker lists it. */
export interface VersionInfo { fileId: number; release: string; fps?: number; synced: boolean; downloads?: number; hearingImpaired?: boolean }

/** The longest version label the picker row shows whole (its text width at body size). */
export const VERSION_LABEL_MAX = 38;
const VERSION_PREFIX = 'v:';

/** "23.976 fps", "25 fps" (three decimals at most). */
const fpsText = (fps: number) => `${Number(fps.toFixed(3))} fps`;

/**
 * "Release.Name · 25 fps · exact match · CC": the frame rate, the match and CC (hearing impaired) only when known; "Version 3" without a
 * release name. A long name is cut (with "…") so the whole label fits VERSION_LABEL_MAX.
 */
export function versionLabel(v: { release: string; fps?: number; synced: boolean; hearingImpaired?: boolean }, n: number): string {
  const parts = [knownFps(v.fps) ? fpsText(v.fps) : '', v.synced ? 'exact match' : '', v.hearingImpaired ? 'CC' : ''].filter(Boolean);
  const tail = parts.map((t) => ` · ${t}`).join('');
  let name = releaseName(v.release) || `Version ${n}`;
  const room = Math.max(8, VERSION_LABEL_MAX - tail.length);
  if (name.length > room) name = `${name.slice(0, room - 1).trimEnd()}…`;
  return name + tail;
}

const releaseName = (release: string) => release.trim().replace(/\s+/g, ' ');

/** The versions picker: one row per version, best first, the loaded one checked; the footer shows the whole release. */
export function versionRows(versions: readonly VersionInfo[], loadedFileId?: number): PickerRow[] {
  return versions.map((v, i) => {
    const release = releaseName(v.release);
    return {
      kind: 'list', id: `${VERSION_PREFIX}${v.fileId}`, label: versionLabel(v, i + 1), checked: v.fileId === loadedFileId,
      ...(release ? { help: release } : {}),
    };
  });
}

/** The file id a versions row loads; undefined for any other row. */
export function versionFileId(rowId: string): number | undefined {
  if (!rowId.startsWith(VERSION_PREFIX)) return undefined;
  const n = Number(rowId.slice(VERSION_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
