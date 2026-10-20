/**
 * Whether a programme can be played from the source's archive (spec 2026-10-20-catch-up §2). One pure rule for the
 * Guide marks, the banner, the Start page menus and the play path, so they always agree. Times are displayed times.
 */
export type ArchiveState = 'available' | 'onAir' | 'tooOld' | 'future' | 'none';

const DAY = 86_400_000;

/**
 * `days`: the channel's archive days (undefined = no catch-up). `refined`: the source's own per-programme answer
 * (Xtream `has_archive`), when known; it overrides the days rule both ways for programmes that have ended.
 */
export function archiveState(
  days: number | undefined, prog: { start: number; stop: number }, now: number, refined?: boolean,
): ArchiveState {
  if (days === undefined) return 'none';
  if (prog.start > now) return 'future';
  if (now < prog.stop) return 'onAir';
  if (refined !== undefined) return refined ? 'available' : 'none';
  if (prog.start < now - days * DAY) return 'tooOld';
  return 'available';
}

/** Whole days the programme stays in a `days` archive (0 = its last day). */
export function daysLeft(days: number, start: number, now: number): number {
  return Math.max(0, Math.floor(days - (now - start) / DAY));
}

/** A state the play path can open: a past archived programme, or the current one from its start. */
export const playableState = (s: ArchiveState): boolean => s === 'available' || s === 'onAir';
