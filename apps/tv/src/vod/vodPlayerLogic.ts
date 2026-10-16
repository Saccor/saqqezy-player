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

/** "Audio & subtitles" picker rows: audio tracks, then subtitles, then "Subtitles off"; the active ones are checked. */
export function trackRows(audio: readonly TrackInfo[], text: readonly TrackInfo[]): PickerRow[] {
  return [
    ...audio.map((t): PickerRow => ({ kind: 'list', id: `a:${t.id}`, label: oneSpace(`Audio: ${t.label}`), checked: t.active })),
    ...text.map((t): PickerRow => ({ kind: 'list', id: `s:${t.id}`, label: oneSpace(`Subtitles: ${t.label}`), checked: t.active })),
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
 * `startedAttempts` value they were last applied for). Once per attempt, so applying never loops.
 */
export function tracksDue(appliedAt: number | undefined, startedAttempts: number, playing: boolean): boolean {
  return playing && startedAttempts > 0 && startedAttempts !== appliedAt;
}

/** The id the audio and subtitle choices are remembered under: the series for an episode, the item for a movie. */
export function tracksKeyId(p: VodPlayable): string {
  return p.kind === 'episode' && p.series ? p.series.id : p.itemId;
}
