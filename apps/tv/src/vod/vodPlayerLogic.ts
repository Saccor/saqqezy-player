import { dvFromFourCC, subtitleText, wrongColoursWithoutDv, type VideoRange } from '@iptv/core';
import type { StreamInfo, SupervisorStatus, Support } from '@iptv/player';
import type { VodPlayable } from '@iptv/app-api';
import { FAILURE_COPY } from '../copy/failure.ts';
import { MOTION } from '../shell/theme.ts';
import { oneSpace } from './tracks.ts';

/** Track helpers (keys, labels, rows): moved to `tracks.ts`; re-exported so existing imports keep working. */
export { LANGUAGE_NAMES, SUBTITLES_OFF, findTrack, oneSpace, trackKey, trackRows } from './tracks.ts';

export const OVERLAY_HIDE_MS = MOTION.autoHide;
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

/** What a remembered subtitle choice stores for "Subtitles off" (`trackKey` always contains ':', so never this). */
export const SUBTITLE_KEY_OFF = 'off';

/**
 * A subtitle cue for display: markup removed and line breaks kept (`subtitleText`, also applied where each engine
 * hands its text over), whitespace runs collapsed per line, blank lines dropped; '' when nothing is left.
 */
export function cueText(text: string | null): string {
  if (!text) return '';
  return subtitleText(text);
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

/**
 * The toast when the picture plays but the device decodes none of the sound (desktop browsers lack AC-3 / E-AC-3,
 * common in films). With more than one audio track, another one may play.
 */
export const DV_COLOURS_TEXT = "Colours may look wrong on this TV: this video is in Dolby Vision, which it can't show.";

/**
 * Warn that the colours may be wrong: the video is Dolby Vision without a base layer this display can show (profile 5,
 * or DV named only in the title), and the display has no Dolby Vision (`dv5` caps 'none'; unknown never warns). The
 * player's own DV-only fourCC overrides what the source says.
 */
export function dvColoursWarning(hint: VideoRange | undefined, info: StreamInfo, dv5: Support | undefined): boolean {
  if (dv5 !== 'none') return false;
  return wrongColoursWithoutDv(dvFromFourCC(info.videoCodec) ?? hint);
}

export function noSoundText(audioTrackCount: number): string {
  return audioTrackCount > 1 ? FAILURE_COPY.noSoundTryTrack : FAILURE_COPY.noSound;
}

/**
 * Whether VodPlay covers the video area with an opaque view: until the first `playing` of this open, so whatever sits on
 * the hardware plane (a frozen frame of the last stream) never shows. `played` latches after that first picture, so a
 * later buffer or reconnect keeps the picture visible.
 */
export function coverVideo(status: SupervisorStatus | undefined, played: boolean, armed = true): boolean {
  return !played && !(armed && status?.kind === 'playing');
}

/**
 * The `played` latch, armed only for the stream this screen opened. On an episode switch the screen remounts while the
 * status can still read `playing` from the previous episode; that stale value is ignored until the status first leaves
 * `playing` (playVod sets loading). Only a `playing` after that counts as this open's first picture.
 */
export function coverLatch(
  s: { armed: boolean; played: boolean },
  kind: SupervisorStatus['kind'] | undefined,
): { armed: boolean; played: boolean } {
  if (s.played) return s;
  if (kind !== 'playing') return s.armed ? s : { ...s, armed: true };
  return s.armed ? { armed: true, played: true } : s;
}
