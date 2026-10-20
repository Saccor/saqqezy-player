/**
 * Catch-up in the TV app (spec 2026-10-20-catch-up §5): the archive marks' wording, the catch-up player's position,
 * seek plan and end card, and the in-memory "not available" marks. Pure: no Solid, no Lightning.
 */
import type { ArchiveState, CatchupPlayable, VodPlayable } from '@iptv/app-api';
import { CATCHUP_COPY } from '../copy.ts';
import { formatClock } from '../shell/logic.ts';

const DAY = 86_400_000;
/** At most one seek re-open per this long. */
export const REOPEN_MIN_GAP_MS = 2000;
/** A Not available answer keeps the programme unoffered this long (memory only). */
export const MISSING_TTL_MS = 30 * 60_000;
/** A catch-up stream that ends this soon after opening, with no frame, is Not available. */
export const EARLY_END_MS = 3000;

/**
 * The archive state on the TV, mirroring core's `archiveState` (the worker has the same rule): `refined` is the
 * source's own answer for a programme, when its row was refined.
 */
export function archiveStateOf(
  days: number | undefined, prog: { start: number; stop: number }, now: number, refined?: boolean,
): ArchiveState {
  if (days === undefined) return 'none';
  if (prog.start > now) return 'future';
  if (now < prog.stop) return 'onAir';
  if (refined !== undefined) return refined ? 'available' : 'none';
  if (prog.start < now - days * DAY) return 'tooOld';
  return 'available';
}

/** The focused programme's details line (§5.1), or undefined where the Guide shows nothing new (future, no catch-up and on air). */
export function archiveLine(state: ArchiveState, days: number | undefined, prog: { start: number; stop: number }, now: number): string | undefined {
  if (state === 'available' && days !== undefined) {
    return CATCHUP_COPY.daysLeft(Math.max(0, Math.floor(days - (now - prog.start) / DAY)));
  }
  if (state === 'onAir') return CATCHUP_COPY.fromStartAvailable;
  if (state === 'tooOld' && days !== undefined) return CATCHUP_COPY.tooOld(days);
  if (state === 'none' && prog.stop <= now) return CATCHUP_COPY.noArchive;
  return undefined;
}

/** A channel row whose programme on now can play from its start: catch-up and a now programme on air. */
export function canFromStart(ch: { archiveDays?: number; now?: { start: number; stop: number } }, now: number): boolean {
  return ch.archiveDays !== undefined && ch.now !== undefined && ch.now.start <= now && now < ch.now.stop;
}

/** What Ok does on a Guide programme (§5.1): play it from the archive, tune live, or toggle the details. */
export function guideOkAction(state: ArchiveState, onAir: boolean): 'catchup' | 'live' | 'details' {
  if (onAir) return 'live';
  return state === 'available' ? 'catchup' : 'details';
}

/** The catch-up player's subtitle: "{channel} · {weekday} {HH:MM}–{HH:MM}" (local time). */
export function catchupSubtitle(channel: string, start: number, stop: number): string {
  const d = new Date(start);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  return `${channel} · ${day} ${formatClock(d)}–${formatClock(new Date(stop))}`;
}

/** The stand-in VOD title VodPlay plays: no progress, no remembered tracks, the programme's length. */
export function catchupVodPlayable(c: CatchupPlayable): VodPlayable {
  const v: VodPlayable = {
    kind: 'movie', itemId: catchupItemId(c), url: c.url, title: c.title,
    episodeLabel: catchupSubtitle(c.channelName, c.start, c.stop), resumeMs: 0, durationMs: c.stop - c.start, tracks: {},
  };
  if (c.alternateUrl) v.alternateUrl = c.alternateUrl;
  if (c.headers) v.headers = c.headers;
  if (c.cooldownKey) v.cooldownKey = c.cooldownKey;
  if (c.cooldown) v.cooldown = c.cooldown;
  return v;
}

/** The stand-in's item id (never stored: catch-up saves nothing). */
export const catchupItemId = (c: { channelId: string; start: number }): string => `catchup:${c.channelId}:${c.start}`;

/** Position in the programme: where the URL started plus the engine's playhead. */
export const catchupPosition = (openedAtMs: number, engineMs: number): number => openedAtMs + engineMs;

/** How far a seek may go: the programme's end, or for one on air, now (its live edge). */
export function seekLimitMs(c: { start: number; stop: number }, now: number): number {
  const dur = c.stop - c.start;
  return now < c.stop ? Math.max(0, Math.min(dur, now - c.start)) : dur;
}

export type SeekPlan =
  /** The engine can reach the target in what it has open. */
  | { kind: 'inPlace'; engineMs: number }
  /** A new URL starting at `offsetMs` into the programme (floored to the URL's step by the worker). */
  | { kind: 'reopen'; offsetMs: number };

/**
 * Seek to `targetMs` (programme time): in place when the open stream reports a duration that covers it (HLS archive
 * playlists, byte-range files), else a re-open.
 */
export function seekPlan(targetMs: number, openedAtMs: number, engineDurMs: number | undefined): SeekPlan {
  const engineMs = targetMs - openedAtMs;
  if (engineMs >= 0 && engineDurMs !== undefined && Number.isFinite(engineDurMs) && engineDurMs > 0 && engineMs <= engineDurMs) {
    return { kind: 'inPlace', engineMs };
  }
  return { kind: 'reopen', offsetMs: Math.max(0, targetMs) };
}

/**
 * The engine start for a re-opened URL: the remainder below its step when the engine can seek into it (HLS), else 0
 * (a TS archive starts where the URL says: minute precision on `xc`).
 */
export function reopenStartMs(targetMs: number, openedAtMs: number, url: string): number {
  const rest = targetMs - openedAtMs;
  if (rest <= 0) return 0;
  return /\.m3u8(?:[?#]|$)/i.test(url) ? rest : 0;
}

/** A re-open may run now (at most one per `REOPEN_MIN_GAP_MS`). */
export const reopenAllowed = (lastAt: number | undefined, now: number): boolean =>
  lastAt === undefined || now - lastAt >= REOPEN_MIN_GAP_MS || now < lastAt;

/** The end card's buttons: the next programme when it is in the archive, Watch live, Back. */
export function endCardActions(next: CatchupPlayable['next']): { id: 'next' | 'live' | 'back'; label: string }[] {
  return [
    ...(next ? [{ id: 'next' as const, label: CATCHUP_COPY.nextTitle(next.title) }] : []),
    { id: 'live', label: CATCHUP_COPY.watchLive },
    { id: 'back', label: 'Back' },
  ];
}

/**
 * The catch-up stream failed before it played: Not available (§5.5) for a gone or unavailable archive, or a stream that
 * ended within `EARLY_END_MS` with no frame. Refusals, the account limit and an unreachable source keep their copy.
 */
export function notAvailableFailure(
  s: { kind: string; reason?: string; httpStatus?: number } | undefined, played: boolean, openedFor: number,
): boolean {
  if (!s || played) return false;
  if (s.kind === 'ended') return openedFor <= EARLY_END_MS;
  if (s.kind !== 'failed') return false;
  if (s.reason === 'gone') return true;
  const st = s.httpStatus;
  return st === 400 || st === 404 || st === 410 || (st !== undefined && st >= 500 && st < 600 && st !== 503 && st !== 509);
}

/** In-memory "not available" marks: the Guide stops offering a programme for `MISSING_TTL_MS`. Nothing is persisted. */
export function createMissingMarks(ttlMs = MISSING_TTL_MS) {
  const marks = new Map<string, number>();
  const key = (channelId: string, start: number) => `${channelId}\u0000${start}`;
  return {
    mark(channelId: string, start: number, now: number): void {
      marks.set(key(channelId, start), now + ttlMs);
      if (marks.size > 200) {
        for (const [k, until] of marks) if (until <= now) marks.delete(k);
      }
    },
    has(channelId: string, start: number, now: number): boolean {
      const until = marks.get(key(channelId, start));
      if (until === undefined) return false;
      if (until <= now) {
        marks.delete(key(channelId, start));
        return false;
      }
      return true;
    },
  };
}

/** The app's marks (the Guide and the catch-up player share them). */
export const missingArchive = createMissingMarks();
