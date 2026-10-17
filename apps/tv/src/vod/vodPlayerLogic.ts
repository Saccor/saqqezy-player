import type { TrackInfo } from '@iptv/player';
import type { VodPlayable } from '@iptv/app-api';
import type { PickerRow } from '../screens/homeMenuLogic.ts';

export const OVERLAY_HIDE_MS = 4000;
export const NEXT_COUNTDOWN_S = 10;
export const PROGRESS_SAVE_MS = 10_000;

/** "1:02:10" (h:mm:ss) or "52:07" (m:ss). */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** "-52:07" style remaining time. */
export function remaining(positionMs: number, durationMs: number): string {
  return `-${clock(Math.max(0, durationMs - positionMs))}`;
}

/** Overlay visible: paused, seeking, ended/failed, or within OVERLAY_HIDE_MS of the last key. */
export function overlayVisible(s: {
  paused: boolean;
  seeking: boolean;
  problem: boolean;
  lastKeyAt: number;
  now: number;
}): boolean {
  return s.paused || s.seeking || s.problem || s.now - s.lastKeyAt < OVERLAY_HIDE_MS;
}

/** "Resume from 1:02:10" / "Play". */
export function resumeLabel(resumeMs: number): string {
  return resumeMs > 0 ? `Resume from ${clock(resumeMs)}` : 'Play';
}

/** "52 min left" (at least 1 min). */
export function minutesLeft(positionMs: number, durationMs: number): string {
  return `${Math.max(1, Math.round((durationMs - positionMs) / 60_000))} min left`;
}

/**
 * A title's length for "N min left": the length measured while playing (the saved position over the saved fraction)
 * wins over the catalogue runtime, which providers often get wrong. 0 when neither is known.
 */
export function titleLengthMs(resumeMs: number, progress: number | undefined, runtimeMin: number | undefined): number {
  if (resumeMs > 0 && progress && progress > 0) return resumeMs / progress;
  return runtimeMin && runtimeMin > 0 ? runtimeMin * 60_000 : 0;
}

/** The detail's resume bar and minutes-left line: only with a resume point and a known length. */
export function resumeBarShown(resumeMs: number, lengthMs: number): boolean {
  return resumeMs > 0 && Number.isFinite(lengthMs) && lengthMs > 0;
}

/** A usable duration: the engine's when finite and > 0, else the playable's, else undefined (unknown). */
export function knownDuration(engineMs: number | undefined, fallbackMs: number | undefined): number | undefined {
  const ok = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v) && v > 0;
  if (ok(engineMs)) return engineMs;
  return ok(fallbackMs) ? fallbackMs : undefined;
}

/**
 * What a remembered track choice stores: `<language>:<label>` (language may be empty). Engine ids change per open, and
 * two tracks often share a language (main and commentary), so both are kept.
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

/** Collapses runs of whitespace (a double space breaks Lightning text layout) and trims. */
export function oneSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** What a remembered subtitle choice stores for "Subtitles off" (`trackKey` always contains ':', so never this). */
export const SUBTITLE_KEY_OFF = 'off';

/** A subtitle cue for display: whitespace runs collapsed per line, blank lines dropped; '' when nothing is left. */
export function cueText(text: string | null): string {
  if (!text) return '';
  return text.split(/\r?\n/).map(oneSpace).filter(Boolean).join('\n');
}

/** Picker row id for "Subtitles off": unprefixed, so no track row (`a:<id>`, `s:<id>`) can produce it. */
export const SUBTITLES_OFF = 'off';

/** English names for the language codes streams commonly carry (ISO 639-1 and 639-2, both 639-2 forms). */
const LANGUAGE_NAMES: Record<string, string> = {
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
 * A track's display label: a bare language code (AVPlay labels tracks by language only) becomes its English name;
 * any other label is kept. Labels that repeat get " (2)", " (3)" in list order.
 */
function trackLabels(tracks: readonly TrackInfo[]): string[] {
  const seen = new Map<string, number>();
  return tracks.map((t) => {
    const raw = oneSpace(t.label);
    const base = LANGUAGE_NAMES[raw.toLowerCase()] ?? raw;
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

/** The next-episode card: "Next: S2 · E5 · Title in 7 s". */
export function nextCardText(label: string, secondsLeft: number): string {
  return `Next: ${label} in ${secondsLeft} s`;
}

/** How close the playhead must come to the start position before the start counts as landed. */
export const START_LANDED_MS = 5000;

/**
 * Whether playhead progress saves are armed (latching). Until then a save could overwrite the saved resume point:
 * before the first frame the playhead reads the start position, and an engine that dropped the start seek plays
 * from 0. A start at 0 and a user seek arm at once. Otherwise only an attempt that plays (`playing`: status
 * 'playing' for this attempt) can arm: its playhead within START_LANDED_MS of `startMs`, or a user pause.
 */
export function progressSaveArmed(s: {
  armed: boolean;
  startMs: number;
  playing: boolean;
  posMs: number | undefined;
  userSeeked?: boolean;
  userPaused?: boolean;
}): boolean {
  if (s.armed || s.startMs <= 0 || s.userSeeked) return true;
  if (!s.playing) return false;
  if (s.userPaused) return true;
  return s.posMs !== undefined && Number.isFinite(s.posMs) && s.posMs >= s.startMs - START_LANDED_MS;
}

/** The page hid: pause a title that plays (ended or failed: nothing to pause). Visible again never resumes by itself. */
export function pauseOnHidden(s: { hidden: boolean; paused: boolean; problem: boolean }): boolean {
  return s.hidden && !s.paused && !s.problem;
}

/**
 * The remembered tracks are due when an engine attempt plays that they were not applied to yet (`appliedAt`: the
 * `startedAttempts` value they were last applied for). Once per attempt, so applying never loops. Also due when the
 * engine's track lists changed since (`shape`: "<audio count>/<subtitle count>"): native in-band tracks can appear
 * after the first frame.
 */
export function tracksDue(
  appliedAt: number | undefined,
  startedAttempts: number,
  playing: boolean,
  appliedShape?: string,
  shape?: string,
): boolean {
  if (!playing || startedAttempts <= 0) return false;
  return startedAttempts !== appliedAt || appliedShape !== shape;
}

/**
 * Whether the player's 250 ms tick looks for late tracks now (`ticks`: ticks since the tracks were last applied): once
 * a second for the first 10 s. Reading the track lists is a native call on AVPlay, so never on every tick for a whole film.
 */
export function shapeCheckDue(ticks: number): boolean {
  return ticks > 0 && ticks <= 40 && ticks % 4 === 0;
}

/** The track lists' shape for `tracksDue`. */
export function trackShape(audio: readonly unknown[], text: readonly unknown[]): string {
  return `${audio.length}/${text.length}`;
}

/** The id the audio and subtitle choices are remembered under: the series for an episode, the item for a movie. */
export function tracksKeyId(p: VodPlayable): string {
  return p.kind === 'episode' && p.series ? p.series.id : p.itemId;
}
