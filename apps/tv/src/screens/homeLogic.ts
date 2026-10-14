/** Pure helpers for the Home screen (unit-tested). */
import type { SupervisorStatus } from '@iptv/player';
import { formatClock } from '../shell/logic.ts';

export interface GroupLite { id: string; name: string; count: number }

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

/** `HH:MM–HH:MM` in local time. */
export function formatRange(start: number, stop: number): string {
  return `${formatClock(new Date(start))}–${formatClock(new Date(stop))}`;
}

/** Elapsed fraction (0..1) of a programme at `now`. */
export function progressOf(p: { start: number; stop: number } | undefined, now: number): number {
  if (!p || p.stop <= p.start) return 0;
  return Math.max(0, Math.min(1, (now - p.start) / (p.stop - p.start)));
}

/** Copy shown in the preview's video hole, or undefined while the picture is playing. */
export function previewMessage(status: SupervisorStatus | undefined, hasChannel: boolean): string | undefined {
  if (!hasChannel || !status) return 'Preview';
  switch (status.kind) {
    case 'playing': return undefined;
    case 'loading': return 'Loading…';
    case 'reconnecting': return 'Reconnecting…';
    case 'failed':
      return status.reason === 'unsupported'
        ? "This channel's format isn't supported on this device"
        : "This channel isn't available right now";
  }
}
