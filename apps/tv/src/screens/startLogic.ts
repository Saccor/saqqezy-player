/** The Start page: row kinds, focus movement and labels. Pure: no Solid, no Lightning. */
import type { SportsEventTile, StartCell, StartRow, VodTile } from '@iptv/app-api';
import { favToggleLabel } from '../copy.ts';
import { formatClock } from '../shell/logic.ts';
import type { RowModel } from '../vod/browseLogic.ts';

export type StartRowKind = 'poster' | 'wide';
export interface StartFocus { row: number; col: number }
export interface StartMemory extends StartFocus { rowId?: string; cellId?: string }

export const rowKind = (r: StartRow): StartRowKind => (r.cells[0]?.type === 'vod' ? 'poster' : 'wide');

export function cellId(c: StartCell): string {
  switch (c.type) {
    case 'vod': return `v:${c.tile.id}`;
    case 'channel': return `c:${c.channel.id}`;
    case 'event': return `e:${c.event.key}`;
    case 'viewAll': return `all:${c.target}`;
  }
}

const clampCol = (r: StartRow | undefined, col: number) => (r ? Math.max(0, Math.min(col, r.cells.length - 1)) : 0);

export function moveStart(rows: StartRow[], f: StartFocus, key: 'up' | 'down' | 'left' | 'right', cols: Map<string, number>): { focus: StartFocus } | { edge: 'top' } {
  const r = rows[f.row];
  if (!r) return { focus: { row: 0, col: 0 } };
  if (key === 'left') return { focus: { row: f.row, col: clampCol(r, f.col - 1) } };
  if (key === 'right') return { focus: { row: f.row, col: clampCol(r, f.col + 1) } };
  if (key === 'up' && f.row === 0) return { edge: 'top' };
  if (key === 'down' && f.row === rows.length - 1) return { focus: f };
  cols.set(r.id, f.col);
  const next = f.row + (key === 'up' ? -1 : 1);
  const target = rows[next]!;
  return { focus: { row: next, col: clampCol(target, cols.get(target.id) ?? f.col) } };
}

export function locateStart(rows: StartRow[], mem: StartMemory): StartFocus {
  if (rows.length === 0) return { row: 0, col: 0 };
  const row = mem.rowId === undefined ? -1 : rows.findIndex((r) => r.id === mem.rowId);
  if (row < 0) {
    const r = Math.max(0, Math.min(mem.row, rows.length - 1));
    return { row: r, col: clampCol(rows[r], mem.col) };
  }
  const col = mem.cellId === undefined ? -1 : rows[row]!.cells.findIndex((c) => cellId(c) === mem.cellId);
  return { row, col: col >= 0 ? col : clampCol(rows[row], mem.col) };
}

export function eventWhen(e: Pick<SportsEventTile, 'start' | 'stop'>, now: number): string {
  if (e.start <= now && now < e.stop) return 'Live';
  const d = new Date(e.start);
  const today = new Date(now);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  // A past start on another day (still running tiles are 'Live' above; a stale one) shows just the time.
  return sameDay || e.start <= now ? formatClock(d) : `Tomorrow ${formatClock(d)}`;
}

/**
 * Where focus should go when a load finishes: the rows, once they have just appeared and the user wants them
 * (and no overlay owns focus). `undefined` leaves focus alone.
 */
export function focusAfterLoad(prev: { hadRows: boolean }, next: { hasRows: boolean }, preferred: 'tabs' | 'rows', overlayOpen: boolean): 'tabs' | 'rows' | undefined {
  return !prev.hadRows && next.hasRows && preferred === 'rows' && !overlayOpen ? 'rows' : undefined;
}

export const channelsLabel = (n: number) => (n === 1 ? '1 channel' : `${n} channels`);

/**
 * Long Ok / Menu on a channel cell: the same choice Home's channel menu leads with (favourite on or off), behind a
 * menu rather than at once, so a long press never flips a favourite by surprise. Cancel is last, like Home's.
 */
export function channelMenuItems(favourite: boolean): { id: 'fav' | 'cancel'; label: string }[] {
  return [{ id: 'fav', label: favToggleLabel(favourite) }, { id: 'cancel', label: 'Cancel' }];
}
export const emptyStartText = () => 'Your start page fills up as you watch.';

export function toPosterRow(r: StartRow): RowModel {
  const items = r.cells.flatMap((c) => (c.type === 'vod' ? [c.tile as VodTile] : []));
  const all = r.cells.find((c) => c.type === 'viewAll');
  return { id: r.id, title: r.title, total: all?.type === 'viewAll' ? all.total : items.length, items, loaded: true };
}

/** A grid of `count` cells in rows of `cols`: the index after a key, or 'top' above the first row. */
export function gridMove(count: number, cols: number, index: number, key: 'up' | 'down' | 'left' | 'right'): number | 'top' {
  const col = index % cols;
  if (key === 'left') return col === 0 ? index : index - 1;
  if (key === 'right') return col === cols - 1 || index === count - 1 ? index : index + 1;
  if (key === 'up') return index < cols ? 'top' : index - cols;
  const below = index + cols;
  if (below < count) return below;
  const lastRowStart = Math.floor((count - 1) / cols) * cols;
  return index >= lastRowStart ? index : count - 1;
}

/** Where Start's rows go: `top` is the focused row's y, `bottom` the lowest edge any row may reach. */
export interface StartRowFrame { top: number; gap: number; bottom: number; peek: number }

/**
 * The rows on screen, the focused one on top (the page scrolls a row at a time) and the rows after it below, each
 * `gap` under the last. `peek`: a row is drawn while at least `peek` of it (its title and a strip of tiles) shows
 * above `bottom`, so the next row always shows its title. `whole` (pointer mode, which keeps the bottom button row
 * free): only rows that fit entirely. The focused row is always there.
 */
export function startRowSlots(heights: readonly number[], focusRow: number, f: StartRowFrame, mode: 'peek' | 'whole'): { index: number; y: number }[] {
  if (focusRow < 0 || focusRow >= heights.length) return [];
  const out = [{ index: focusRow, y: f.top }];
  let y = f.top + heights[focusRow]! + f.gap;
  for (let i = focusRow + 1; i < heights.length; i++) {
    const need = mode === 'peek' ? Math.min(f.peek, heights[i]!) : heights[i]!;
    if (y + need > f.bottom) break;
    out.push({ index: i, y });
    y += heights[i]! + f.gap;
  }
  return out;
}
