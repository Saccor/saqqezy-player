import type { TrackInfo } from '@iptv/player';
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

/** A usable duration: the engine's when finite and > 0, else the playable's, else undefined (unknown). */
export function knownDuration(engineMs: number | undefined, fallbackMs: number | undefined): number | undefined {
  const ok = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v) && v > 0;
  if (ok(engineMs)) return engineMs;
  return ok(fallbackMs) ? fallbackMs : undefined;
}

/** What a remembered track choice stores: the language when known, else the label (engine ids change per open). */
export function trackKey(t: TrackInfo): string {
  return t.language || t.label;
}

/** The track matching a remembered choice: by language first, then by label. */
export function findTrack(tracks: readonly TrackInfo[], want: string | undefined): TrackInfo | undefined {
  if (!want) return undefined;
  return tracks.find((t) => t.language === want) ?? tracks.find((t) => t.label === want);
}

/** Collapses runs of whitespace (a double space breaks Lightning text layout) and trims. */
export function oneSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** What a remembered subtitle choice stores for "Subtitles off" (no language code is "off"). */
export const SUBTITLE_KEY_OFF = 'off';

/** A subtitle cue for display: whitespace runs collapsed per line, blank lines dropped; '' when nothing is left. */
export function cueText(text: string | null): string {
  if (!text) return '';
  return text.split(/\r?\n/).map(oneSpace).filter(Boolean).join('\n');
}

/** Picker row id for "Subtitles off". Audio rows are `a:<id>`, subtitle rows `s:<id>`. */
export const SUBTITLES_OFF = 's:off';

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
