/** What a wide or compact tile says, and its size (Start, Search). Pure: no Solid, no Lightning. */
import type { StartCell } from '@iptv/app-api';
import { programmeContext, type ProgrammeCell } from '../screens/searchLogic.ts';
import { channelsLabel, eventWhen } from '../screens/startLogic.ts';

/** A Start cell, or a programme from Search's results. */
export type WideCell = StartCell | ProgrammeCell;

export const WIDE_W = 314;
export const WIDE_H = 176;
/** Start's match and channel rows: two text lines and a small logo, so more rows fit on the page. */
export const COMPACT_W = 300;
export const COMPACT_H = 100;
export const WIDE_GAP = 24;

export const wideSize = (compact: boolean): { w: number; h: number } =>
  (compact ? { w: COMPACT_W, h: COMPACT_H } : { w: WIDE_W, h: WIDE_H });

/**
 * The bold main line names the thing to watch; the muted context line above it gives context ('' when empty or the
 * same as the main line). Channel: name / programme. Event: when · channels / title. Programme: when · channel / title.
 * View all: just the label. `live`: a match airing now (its context line is drawn in the accent).
 */
export function wideLines(c: WideCell, now: number, channelNumbers = false): { context: string; main: string; live: boolean } {
  let context = '';
  let main = '';
  let live = false;
  if (c.type === 'channel') {
    context = channelNumbers ? `${c.channel.number} · ${c.channel.name}` : c.channel.name;
    main = c.channel.now?.title ?? 'No guide information';
  } else if (c.type === 'event') {
    live = c.event.start <= now && now < c.event.stop;
    context = `${eventWhen(c.event, now)} · ${channelsLabel(c.event.channelCount)}`;
    main = c.event.title;
  } else if (c.type === 'programme') {
    context = programmeContext(c, now);
    main = c.hit.title;
  } else if (c.type === 'viewAll') {
    main = 'View all';
  }
  return { context: context === main ? '' : context, main, live };
}
