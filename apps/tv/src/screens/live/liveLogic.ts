/** Live TV (UI revamp phase 2): the merged channel guide's pure layout, keys, OK and menu rules. */
import type { Rect } from '@iptv/player';
import { CATCHUP_COPY } from '../../copy.ts';
import { LAYOUT } from '../../shell/theme.ts';
import { guideOkAction } from '../../vod/catchupLogic.ts';
import { pickGroup, type GroupLite } from '../homeLogic.ts';
import { buildChannelMenu, type ChannelMenuAction, type ListLite } from '../homeMenuLogic.ts';

const GROUP_ALL = 'all';

/** The mini video window (the hole in the canvas the video shows through). */
export const LIVE_PREVIEW_RECT: Rect = { x: LAYOUT.contentX, y: LAYOUT.safeY, w: 416, h: 234 };
/** The focused programme's block, right of the video; it ends left of the shell's offline badge. */
export const INFO_X = LIVE_PREVIEW_RECT.x + LIVE_PREVIEW_RECT.w + 40;
export const INFO_W = 764;
/** The guide's ruler row; rows start 44 px below it. */
export const GRID_Y = 312;
/** The companion-phone badge: top right, inside the safe area. */
export const PHONE_BADGE_POS = { x: LAYOUT.width - LAYOUT.safeX - 144, y: LAYOUT.safeY } as const;

export type LivePlace = 'rail' | 'groups' | 'channels' | 'grid';
export type LiveKey = 'up' | 'down' | 'left' | 'right' | 'back';
export interface LiveKeyCtx { row: number; total: number; hasGroups: boolean }

/**
 * Where a key leads from a place. 'move' = the place handles it itself (rows, time); 'exit' = let Back bubble to the
 * shell's exit question. Left inside the grid is 'move' (stepLeft decides when the time edge hands over to the
 * channel column).
 */
export function liveKey(place: LivePlace, key: LiveKey, ctx: LiveKeyCtx): LivePlace | 'move' | 'exit' {
  const content: LivePlace = ctx.total > 0 ? 'grid' : ctx.hasGroups ? 'groups' : 'rail';
  if (place === 'rail') return key === 'back' ? 'exit' : key === 'right' ? content : 'move';
  if (place === 'groups') {
    if (key === 'left') return 'rail';
    if (key === 'down' || key === 'back') return ctx.total > 0 ? 'grid' : key === 'back' ? 'rail' : 'groups';
    return 'groups';
  }
  if (key === 'back' || (key === 'left' && ctx.total === 0)) return 'rail';
  if (ctx.total === 0) return ctx.hasGroups ? 'groups' : 'rail'; // nothing to move over
  if (key === 'up' && ctx.row === 0 && ctx.hasGroups) return 'groups';
  if (place === 'channels') {
    if (key === 'left') return 'rail';
    if (key === 'right') return 'grid';
  }
  return 'move';
}

export function liveOkAction(o: {
  channelId: string; onAir: boolean; archive: Parameters<typeof guideOkAction>[0]; playingId?: string; requestedId?: string;
}): 'preview' | 'fullscreen' | 'catchup' | 'details' {
  const g = guideOkAction(o.archive, o.onAir);
  if (g !== 'live') return g;
  return o.channelId === o.playingId || o.channelId === o.requestedId ? 'fullscreen' : 'preview';
}

/** "12 min left", "1 h 5 min left", "2 h left"; '' once it has ended. Minutes round up. */
export function timeLeftLabel(stop: number, now: number): string {
  if (stop <= now) return '';
  const mins = Math.ceil((stop - now) / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min left`;
  return m === 0 ? `${h} h left` : `${h} h ${m} min left`;
}

/**
 * The group and row Live TV opens at: `prefer` (else All, else the first group), at the first candidate it holds.
 * `pinned` (a requested channel, the Player's last channel, the playing one) is tried first, and one outside the group
 * switches to All, as Home did. `others` (remembered, init's last) never change the group: none found is row 0.
 * The common cold start costs one lookup.
 */
export async function locateFocus(o: {
  groups: readonly GroupLite[];
  prefer: string | undefined;
  pinned: readonly (string | undefined)[];
  others: readonly (string | undefined)[];
  indexOf: (groupId: string, channelId: string) => Promise<number>;
}): Promise<{ g: string | undefined; index: number }> {
  const g = pickGroup(o.groups, o.prefer);
  if (g === undefined) return { g, index: 0 };
  const hasAll = g !== GROUP_ALL && o.groups.some((x) => x.id === GROUP_ALL);
  const pinned = new Set(o.pinned.filter((id): id is string => id !== undefined));
  const tried = new Set<string>();
  for (const id of [...o.pinned, ...o.others]) {
    if (id === undefined || tried.has(id)) continue;
    tried.add(id);
    const i = await o.indexOf(g, id);
    if (i >= 0) return { g, index: i };
    if (hasAll && pinned.has(id)) {
      const j = await o.indexOf(GROUP_ALL, id);
      if (j >= 0) return { g: GROUP_ALL, index: j };
    }
  }
  return { g, index: 0 };
}

interface InfoProg { title: string; start: number; stop: number; desc?: string }
/** What the info block shows: the focused channel and its focused block (none on the channel cell). */
export interface InfoSource {
  channel: { id: string; number: number; name: string; now?: InfoProg };
  block?: InfoProg & { filler: boolean };
}

const sameProg = (a: InfoProg | undefined, b: InfoProg | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.start === b.start && a.stop === b.stop && a.title === b.title
    && a.desc === b.desc);

/** Equal when the info block would draw the same: a rebuilt row or block with the same content does not count as new. */
export function sameInfo(a: InfoSource | undefined, b: InfoSource | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const ca = a.channel;
  const cb = b.channel;
  if (ca.id !== cb.id || ca.number !== cb.number || ca.name !== cb.name) return false;
  if ((a.block === undefined) !== (b.block === undefined)) return false;
  if (a.block && b.block) return a.block.filler === b.block.filler && sameProg(a.block, b.block);
  return sameProg(ca.now, cb.now);
}

export type LiveMenuAction = ChannelMenuAction | 'fromStart' | 'goToDay';

/** One menu for Menu / long Ok: the programme's items first, then the channel's (spec phase 2 decisions). */
export function liveMenuItems(o: {
  channel: { inListId?: string; isHidden: boolean; isFavourite: boolean; lists: readonly ListLite[] };
  fromStart: boolean; goToDay: boolean;
}): { action: LiveMenuAction; label: string }[] {
  return [
    ...(o.fromStart ? [{ action: 'fromStart' as const, label: CATCHUP_COPY.fromStart }] : []),
    ...(o.goToDay ? [{ action: 'goToDay' as const, label: CATCHUP_COPY.goToDay }] : []),
    ...buildChannelMenu(o.channel),
  ];
}
