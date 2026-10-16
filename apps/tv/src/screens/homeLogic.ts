/** Pure helpers for the Home screen (unit-tested). */
import type { SupervisorStatus } from '@iptv/player';
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
 * Row to focus: the channel's position when it was found (`byId >= 0`), else the remembered row index
 * clamped to the list, else the first row.
 */
export function restoreIndex(byId: number, remembered: number | undefined, total: number): number {
  if (total <= 0) return 0;
  if (byId >= 0) return Math.min(byId, total - 1);
  return Math.max(0, Math.min(remembered ?? 0, total - 1));
}

/**
 * The channel to focus when a group opens: the first candidate (in order, duplicates and blanks skipped) that
 * is in the group. Home passes the playing channel, the remembered channel, then the last channel from init.
 */
export async function resolveFocus(
  candidates: readonly (string | undefined)[],
  indexOf: (id: string) => Promise<number>,
): Promise<{ id: string | undefined; index: number }> {
  const tried = new Set<string>();
  for (const id of candidates) {
    if (id === undefined || tried.has(id)) continue;
    tried.add(id);
    const index = await indexOf(id);
    if (index >= 0) return { id, index };
  }
  return { id: undefined, index: -1 };
}

/**
 * What the preview panel describes: the focused channel (with a "Starting…" hint) while its preview is
 * pending, otherwise the channel that is playing or has failed, otherwise the focused one.
 */
export function panelChannel<T>(focused: T | undefined, playing: T | undefined, pending: boolean):
  { channel: T | undefined; starting: boolean } {
  if (pending && focused !== undefined) return { channel: focused, starting: true };
  return { channel: playing ?? focused, starting: false };
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
 * Back from Movies or Series (`fromVod`): the live channel that was playing when the VOD tab opened (`returnId`)
 * comes back, through Home's usual play path. Nothing when nothing was playing, after a stop on purpose (`held`),
 * or while the dev resume gate is closed (`gatePaused`). A channel that is already current wins (the caller).
 */
export function vodReturnTarget(s: {
  fromVod: boolean;
  returnId: string | undefined;
  held: boolean;
  gatePaused: boolean;
}): string | undefined {
  if (!s.fromVod || s.held || s.gatePaused) return undefined;
  return s.returnId;
}

/**
 * `nowNextUpdated` for `changed`: the preview panel's info for the playing channel must be re-read when that
 * channel is in the update and is not the focused row (the focused row comes from the slice cache, which the
 * same event already refreshes).
 */
export function playingInfoStale(changed: readonly string[], playingId: string | undefined, focusedId: string | undefined): boolean {
  return playingId !== undefined && playingId !== focusedId && changed.includes(playingId);
}

/** `HH:MM–HH:MM` in local time. */
export function formatRange(start: number, stop: number): string {
  return `${formatClock(new Date(start))}–${formatClock(new Date(stop))}`;
}

/** Elapsed fraction (0..1) of a programme at `now`. */
export function progressOf(p: { start: number; stop: number } | undefined, now: number): number {
  if (!p || p.stop <= p.start) return 0;
  return Math.max(0, Math.min(1, (now - p.start) / (p.stop - p.start)));
}

/**
 * Copy shown in the preview's video hole, or undefined while the picture is playing. `idle` replaces "Preview" while
 * nothing plays (Home: paused after a reload).
 */
export function previewMessage(status: SupervisorStatus | undefined, hasChannel: boolean, idle = 'Preview'): string | undefined {
  if (!hasChannel) return idle;
  if (!status) return 'Preview';
  switch (status.kind) {
    case 'playing': return undefined;
    case 'loading': return 'Loading…';
    case 'reconnecting': return 'Reconnecting…';
    case 'failed':
      return status.reason === 'unsupported'
        ? "This channel's format isn't supported on this device"
        : status.reason === 'refused'
          ? 'Your source refused this stream'
          : "This channel isn't available right now";
  }
}

/**
 * An empty All group on Home means "channels are still loading", except for a source with only movies and series
 * (`InitState.hasVod`): that source has no live channels to wait for, so Home shows the no-live text at once.
 */
export function waitsForChannels(allCount: number, hasVod: boolean | undefined): boolean {
  return allCount === 0 && hasVod !== true;
}
