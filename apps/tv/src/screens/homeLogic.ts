/** Pure helpers shared by Live TV, Start, Search and the Player's banner (unit-tested). */
import type { SupervisorStatus } from '@iptv/player';
import { LIVE_COPY } from '../copy.ts';
import { failureText } from '../playback/failureText.ts';
import { formatClock } from '../shell/logic.ts';

export interface GroupLite { id: string; name: string; count: number }

/**
 * The Player's group for a click on Home's small video. The open group only when the video shows the focused row's
 * channel; otherwise (the playing channel is not in the open group's list) All channels, and Home's remembered
 * channel is left alone, so it never points at a channel the list does not hold.
 */
export function videoClickGroup(id: string, focusedId: string | undefined, openGroup: string | undefined):
  { groupId: string; remember: boolean } {
  return openGroup !== undefined && id === focusedId ? { groupId: openGroup, remember: true } : { groupId: 'all', remember: false };
}

/** The group to open: the wanted one if it still exists, else All channels, else the first group. */
export function pickGroup(groups: readonly GroupLite[], wanted: string | undefined): string | undefined {
  if (wanted !== undefined && groups.some((g) => g.id === wanted)) return wanted;
  if (groups.some((g) => g.id === 'all')) return 'all';
  return groups[0]?.id;
}

/**
 * What Home resumes on mount, if anything. Only a channel the user played comes back by itself:
 * - `held` (playback was stopped on purpose, e.g. the sleep timer): nothing;
 * - the playing channel (back from the Player): the same channel again, with no reconnect;
 * - otherwise the last channel from init (`lastChannelId`), once per page (`startupDone`), and only when the list
 *   found it (`found`; a gone or hidden channel is not resumed).
 * A row the user only browsed to is never resumed: browsing never starts a stream.
 */
export function resumeTarget(s: {
  playingId: string | undefined;
  lastChannelId: string | undefined;
  found: string | undefined;
  startupDone: boolean;
  held: boolean;
}): string | undefined {
  if (s.held) return undefined;
  if (s.playingId !== undefined) return s.playingId;
  if (s.startupDone || s.lastChannelId === undefined || s.found !== s.lastChannelId) return undefined;
  return s.lastChannelId;
}

/**
 * Back from Movies, Series or Start (or Live TV on their rail) returns to Home with `fromVod`: the channel they stopped
 * resumes and focus lands on the channel list (you return to what you were watching), not on the rail.
 */
export function returnedToLive(params: { fromVod?: unknown }): boolean {
  return params.fromVod === true;
}

/**
 * Back from Movies or Series (`fromVod`), or Home revealed after Search opened a movie or series (`fromSearch`): the
 * live channel that was playing when it stopped (`returnId`) comes back, through Home's usual play path. Nothing
 * when nothing was playing, after a stop on purpose (`held`), or while the dev resume gate is closed (`gatePaused`).
 * A channel that is already current wins (the caller).
 */
export function vodReturnTarget(s: {
  fromVod: boolean;
  fromSearch?: boolean;
  returnId: string | undefined;
  held: boolean;
  gatePaused: boolean;
}): string | undefined {
  if (!(s.fromVod || s.fromSearch === true) || s.held || s.gatePaused) return undefined;
  return s.returnId;
}

/** `HH:MM–HH:MM` in local time. */
export function formatRange(start: number, stop: number): string {
  return `${formatClock(new Date(start))}–${formatClock(new Date(stop))}`;
}

/** The banner's and Start's text when a channel has no programme on now. */
export const NO_GUIDE_INFO = LIVE_COPY.noGuideInfo;
/** `Now · <title>`: the programme on now (its time range and progress are drawn separately). */
export const nowLine = (p: { title: string }): string => LIVE_COPY.nowNext.now(p.title);
/** `Next · 20:00–21:30 · <title>`: the programme after it, with its time range. */
export const nextLine = (p: { title: string; start: number; stop: number }): string => LIVE_COPY.nowNext.next(formatRange(p.start, p.stop), p.title);
/** The live banner's next line: `Next · 21:00 <title>` (start time only), or '' when nothing is known. */
export function bannerNextLine(next: { start: number; title: string } | undefined): string {
  return next ? LIVE_COPY.nowNext.nextAt(formatClock(new Date(next.start)), next.title) : '';
}
/** One line for both: the Player's info banner and Start's hero say the same thing about a channel. */
export function nowNextLine(c: { now?: { title: string }; next?: { title: string; start: number; stop: number } }): string {
  if (!c.now) return NO_GUIDE_INFO;
  return c.next ? `${nowLine(c.now)} · ${nextLine(c.next)}` : nowLine(c.now);
}

/** Elapsed fraction (0..1) of a programme at `now`. */
export function progressOf(p: { start: number; stop: number } | undefined, now: number): number {
  if (!p || p.stop <= p.start) return 0;
  return Math.max(0, Math.min(1, (now - p.start) / (p.stop - p.start)));
}

/**
 * Copy shown in the preview's video hole, or undefined while the picture is playing. `idle` replaces "Preview" while
 * nothing plays (Home: paused after a reload). `maxConnections` is the active Xtream account's limit, when known.
 */
export function previewMessage(
  status: SupervisorStatus | undefined, hasChannel: boolean, idle = 'Preview', maxConnections?: number,
): string | undefined {
  if (!hasChannel) return idle;
  if (!status) return 'Preview';
  switch (status.kind) {
    case 'playing': return undefined;
    case 'loading': return 'Loading…';
    case 'reconnecting': return 'Reconnecting…';
    case 'failed':
      return failureText({ reason: status.reason, httpStatus: status.httpStatus, maxConnections });
  }
}

/**
 * An empty All group on Home means "channels are still loading", except for a source with only movies and series
 * (`InitState.hasVod`): that source has no live channels to wait for, so Home shows the no-live text at once.
 */
export function waitsForChannels(allCount: number, hasVod: boolean | undefined): boolean {
  return allCount === 0 && hasVod !== true;
}
