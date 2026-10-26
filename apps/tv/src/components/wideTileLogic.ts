/** What a wide or compact tile says, and its size (Start, Search). Pure: no Solid, no Lightning. */
import type { StartCell } from '@iptv/app-api';
import { LIVE_COPY } from '../copy.ts';
import { folderCount, programmeContext, type FolderCell, type ProgrammeCell } from '../screens/searchLogic.ts';
import { channelsLabel, channelsShort, eventWhen } from '../screens/startLogic.ts';

/** A Start cell, a programme from Search's results, or a folder from Search's Folders row. */
export type WideCell = StartCell | ProgrammeCell | FolderCell;

export const WIDE_W = 314;
export const WIDE_H = 176;
/** Start's match and channel rows: three text lines and a small logo (spec 2026-10-22 §1.3). */
export const COMPACT_W = 360;
export const COMPACT_H = 112;
/** View all's grid tile: the compact tile plus a muted detail line (the competition). */
export const MATCH_GRID_H = 136;
export const WIDE_GAP = 24;

export const wideSize = (compact: boolean): { w: number; h: number } =>
  (compact ? { w: COMPACT_W, h: COMPACT_H } : { w: WIDE_W, h: WIDE_H });

/**
 * The bold main line names the thing to watch; the muted context line above it gives context ('' when empty or the
 * same as the main line). Channel: name / programme. Event: when · channels / title. Programme: when · channel / title.
 * View all: just the label. `live`: a match airing now (its context line is drawn in the accent). `short`: compact tiles
 * say "N ch". `sides`: a match's two sides, each drawn on its own line by the compact tile.
 */
export function wideLines(c: WideCell, now: number, channelNumbers = false, short = false): { context: string; main: string; live: boolean; sides?: [string, string] } {
  let context = '';
  let main = '';
  let live = false;
  let sides: [string, string] | undefined;
  if (c.type === 'channel') {
    context = channelNumbers ? `${c.channel.number} · ${c.channel.name}` : c.channel.name;
    main = c.channel.now?.title ?? LIVE_COPY.noGuideInfo;
  } else if (c.type === 'event') {
    live = c.event.start <= now && now < c.event.stop;
    context = `${eventWhen(c.event, now)} · ${(short ? channelsShort : channelsLabel)(c.event.channelCount)}`;
    main = c.event.title;
    sides = c.event.sides;
  } else if (c.type === 'programme') {
    context = programmeContext(c, now);
    main = c.hit.title;
  } else if (c.type === 'folder') {
    context = folderCount(c.hit);
    main = c.hit.name;
  } else if (c.type === 'viewAll') {
    main = LIVE_COPY.tile.viewAll;
  }
  const out: { context: string; main: string; live: boolean; sides?: [string, string] } = { context: context === main ? '' : context, main, live };
  if (sides) out.sides = sides;
  return out;
}
