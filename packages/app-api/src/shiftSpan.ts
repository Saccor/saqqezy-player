import type { Channel } from '@iptv/core';

const HOUR = 3600_000;

/** The smallest and largest per-channel guide shift (hours; an unshifted channel counts as 0). */
export interface ShiftSpan {
  min: number;
  max: number;
}

/** One pass over the channels, once per index (not per search keystroke). */
export function shiftSpan(channels: readonly Channel[]): ShiftSpan {
  let min = 0;
  let max = 0;
  for (const c of channels) {
    const s = c.epgShift ?? 0;
    if (s < min) min = s;
    else if (s > max) max = s;
  }
  return { min, max };
}

/**
 * The largest |offset + shift| over every channel, in ms: how far before now a programme search must look so a
 * shifted programme airing now is found. |offset + s| is largest at an end of the span (0 is inside it, which
 * also covers the offset alone).
 */
export function maxShiftMs(span: ShiftSpan, offsetHours: number): number {
  return Math.max(Math.abs(offsetHours + span.min), Math.abs(offsetHours + span.max)) * HOUR;
}
