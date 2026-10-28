/** What a wide or compact tile says, and its size (Start, Search). Pure: no Solid, no Lightning. */
import type { StartCell } from '@iptv/app-api';
import { LIVE_COPY } from '../copy.ts';
import { folderCount, programmeContext, type FolderCell, type HiddenCell, type ProgrammeCell } from '../screens/searchLogic.ts';
import { channelsLabel, channelsShort, eventWhen } from '../screens/startLogic.ts';

/** A Start cell, a programme or the hidden-groups card from Search's results, or a folder from Search's Folders row. */
export type WideCell = StartCell | ProgrammeCell | FolderCell | HiddenCell;

export const WIDE_W = 314;
export const WIDE_H = 176;
/** Start's match and channel rows: three text lines and a small logo (spec 2026-10-22 §1.3). */
export const COMPACT_W = 360;
export const COMPACT_H = 112;
/** View all's grid tile: the compact tile plus a muted detail line (the competition). */
export const MATCH_GRID_H = 136;
export const WIDE_GAP = 24;

/**
 * The bold main line names the thing to watch; the muted context line above it gives context ('' when empty or the
 * same as the main line). Channel: name / programme (Search, with numbers: number · programme / name). Event: when · channels / title. Programme: when · channel / title.
 * View all: just the label. `live`: a match airing now (its context line is drawn in `text`, not `muted`). `short`: compact tiles
 * say "N ch". `sides`: a match's two sides, each drawn on its own line by the compact tile.
 */
export function wideLines(c: WideCell, now: number, channelNumbers = false, short = false): { context: string; main: string; live: boolean; sides?: [string, string] } {
  let context = '';
  let main = '';
  let live = false;
  let sides: [string, string] | undefined;
  if (c.type === 'channel') {
    const programme = c.channel.now?.title ?? LIVE_COPY.noGuideInfo;
    // Search: the name the user typed is the main line; the number tells duplicates (HD/SD, regional) apart.
    context = channelNumbers ? `${c.channel.number} · ${programme}` : c.channel.name;
    main = channelNumbers ? c.channel.name : programme;
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
  } else if (c.type === 'hidden') {
    context = LIVE_COPY.tile.hiddenContext;
    main = LIVE_COPY.tile.hiddenMore(c.count);
  } else if (c.type === 'viewAll') {
    main = LIVE_COPY.tile.viewAll;
  }
  const out: { context: string; main: string; live: boolean; sides?: [string, string] } = { context: context === main ? '' : context, main, live };
  if (sides) out.sides = sides;
  return out;
}

const SIDES_SEP = '\u0000';

/**
 * One string for a match's two side names. A tile keyed on it remounts its two lines only when a name changes, not
 * for every refresh's new array (spec 2026-10-26 §0.3).
 */
export function sidesKey(sides: readonly [string, string] | undefined): string | undefined {
  return sides ? `${sides[0]}${SIDES_SEP}${sides[1]}` : undefined;
}

export function sidesFromKey(key: string): [string, string] {
  const i = key.indexOf(SIDES_SEP);
  return [key.slice(0, i), key.slice(i + 1)];
}
