/** Live TV (UI revamp phase 2): the merged channel guide's pure layout, keys, OK and menu rules. */
import { keyTableFor, mapKey } from '@iptv/platform';
import type { Rect } from '@iptv/player';
import { CATCHUP_COPY, LIVE_MENU_COPY, MULTIVIEW_COPY } from '../../copy.ts';
import { LAYOUT, TYPE } from '../../shell/theme.ts';
import { guideOkAction } from '../../vod/catchupLogic.ts';
import { dayLabel } from '../guideLogic.ts';
import { formatRange, pickGroup, type GroupLite } from '../homeLogic.ts';
import { buildChannelMenu, emptyGroupText, type ChannelMenuAction, type ListLite } from '../homeMenuLogic.ts';

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

/**
 * The info block's progress track: at `minX` after today's "20:00–21:30" (about 132 px at meta size), `w` wide, then
 * `gap` before the time left.
 */
export const INFO_TRACK = { minX: 152, w: 160, gap: 16 } as const;
/** Lightning measures text late, so the time line's width is estimated: 0.6 em a character at meta size. */
const INFO_CHAR_W = 0.6 * TYPE.meta;

/**
 * The info block's time line: "20:00–21:30" for a programme starting today, else "Yesterday · 23:00–01:00",
 * "Tomorrow · …" or "Thu 22 Oct · …" (`dayLabel`). `trackX`: where the progress track starts, clear of the text.
 */
export function infoTimeLine(start: number, stop: number, now: number): { text: string; trackX: number } {
  const range = formatRange(start, stop);
  const day = dayLabel(start, now);
  if (day === 'Today') return { text: range, trackX: INFO_TRACK.minX };
  const text = `${day} · ${range}`;
  return { text, trackX: Math.max(INFO_TRACK.minX, Math.ceil(text.length * INFO_CHAR_W) + INFO_TRACK.gap) };
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
 * switches to All, as Home did. `others` (remembered, init's last) never change the group: none found is
 * `fallbackRow` (the remembered row, clamped to the group's count) when `prefer` itself opened, else row 0.
 * The common cold start costs one lookup.
 */
export async function locateFocus(o: {
  groups: readonly GroupLite[];
  prefer: string | undefined;
  pinned: readonly (string | undefined)[];
  others: readonly (string | undefined)[];
  fallbackRow?: number;
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
  if (o.fallbackRow === undefined || g !== o.prefer) return { g, index: 0 };
  const count = o.groups.find((x) => x.id === g)?.count ?? 0;
  return { g, index: Math.max(0, Math.min(o.fallbackRow, count - 1)) };
}

interface InfoProg { title: string; start: number; stop: number; desc?: string }
/** What the info block shows: the focused channel and its focused block (none on the channel cell). */
export interface InfoSource {
  channel: { id: string; number: number; name: string; now?: InfoProg; sourceCount?: number; quality?: string };
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
  if (ca.sourceCount !== cb.sourceCount || ca.quality !== cb.quality) return false;
  if ((a.block === undefined) !== (b.block === undefined)) return false;
  if (a.block && b.block) return a.block.filler === b.block.filler && sameProg(a.block, b.block);
  return sameProg(ca.now, cb.now);
}

export type LiveMenuAction = ChannelMenuAction | 'watch' | 'preview' | 'fromStart' | 'goToDay' | 'addToMultiview';

/**
 * One menu for OK, Menu and long OK: "Watch" (full screen) and "Preview" (the mini window) first, then the programme's
 * items, then the channel's (spec phase 2 decisions; owner 2026-10-22: OK opens the options).
 */
export function liveMenuItems(o: {
  channel: { inListId?: string; isHidden: boolean; isFavourite: boolean; lists: readonly ListLite[]; sources?: number };
  fromStart: boolean; goToDay: boolean;
  /** "Watch": full screen (live, or the programme's archive). */
  watch?: boolean;
  /** "Preview": plays in the mini window; offered while another channel is there. */
  preview?: boolean;
  /** This device can play 2 or more channels at once: "Add to multiview" (spec 2026-10-20-multiview §2.1). */
  multiview?: boolean;
}): { action: LiveMenuAction; label: string }[] {
  return [
    ...(o.watch ? [{ action: 'watch' as const, label: LIVE_MENU_COPY.watch }] : []),
    ...(o.preview ? [{ action: 'preview' as const, label: LIVE_MENU_COPY.preview }] : []),
    ...(o.fromStart ? [{ action: 'fromStart' as const, label: CATCHUP_COPY.fromStart }] : []),
    ...(o.goToDay ? [{ action: 'goToDay' as const, label: CATCHUP_COPY.goToDay }] : []),
    ...(o.multiview ? [{ action: 'addToMultiview' as const, label: MULTIVIEW_COPY.addToMultiview }] : []),
    ...buildChannelMenu(o.channel),
  ];
}

/** The browser key table: which letters the remote layer maps (m Menu, i Info). */
const BROWSER_KEYS = keyTableFor('browser');

/**
 * A hardware key that hands off to Search (seeded with it): a letter or a digit (Live TV gives digits no meaning; number
 * entry lives in the Player), without Ctrl, Cmd or Alt. Letters the remote layer maps (m Menu, i Info) stay remote keys.
 */
export function liveTypedChar(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): string | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey || Array.from(e.key).length !== 1) return undefined;
  const ch = e.key;
  const digit = ch >= '0' && ch <= '9';
  if (!digit && ch.toLowerCase() === ch.toUpperCase()) return undefined; // not a letter
  return digit || mapKey(BROWSER_KEYS, { key: ch, keyCode: 0 }) === undefined ? ch : undefined;
}

export const NO_LIVE_TEXT = 'This source has no live channels. Movies and series are in the menu on the left.';

/** The first read of the groups failed (the worker, not the source): Live TV reads them again (`groupsRetryMs`). */
export const GROUPS_FAILED_TEXT = 'Could not read the channels. Trying again…';

/** The delay before read `attempt` + 1 of the groups after a failure: 2 s, doubling, at most a minute. */
export function groupsRetryMs(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt));
}

/**
 * The source has no live channels (and none are on their way): the empty-state text, and focus goes to the rail.
 * Not after a failed read (`failed`): the count is unknown then.
 */
export function hasNoLive(o: { waiting: boolean; allCount: number; failed?: boolean }): boolean {
  return !o.waiting && o.failed !== true && o.allCount === 0;
}

/**
 * The info block's place while the open group has no channels: the first load, a failed read of the groups, no live
 * channels, or an empty group.
 */
export function liveEmptyText(o: {
  waiting: boolean; failed?: boolean; progressCount?: number; allCount: number; groupId: string | undefined;
}): string {
  if (o.waiting) return o.progressCount !== undefined ? `Loading channels… ${o.progressCount}` : 'Loading channels…';
  if (o.failed === true) return GROUPS_FAILED_TEXT;
  return hasNoLive(o) ? NO_LIVE_TEXT : emptyGroupText(o.groupId);
}

/** A pointer hit on the cell that already has the focus (a click there acts like OK without moving first). */
export function sameCell(
  hit: { area: 'channels'; row: number } | { area: 'grid'; row: number; start: number },
  focus: { row: number; place: LivePlace; focusStart: number | undefined },
): boolean {
  if (hit.row !== focus.row) return false;
  return hit.area === 'channels' ? focus.place === 'channels' : focus.place === 'grid' && hit.start === focus.focusStart;
}

/** The pointer bar's buttons (Live TV's bottom row in pointer mode). */
export const LIVE_POINTER_LABELS = { earlier: '‹ Earlier', later: 'Later ›', search: '⌕ Search', settings: '⚙ Settings' } as const;
