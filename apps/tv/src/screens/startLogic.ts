/** The Start page: row kinds, focus movement and labels. Pure: no Solid, no Lightning. */
import type { SportsEventTile, StartCell, StartRow, VodTile } from '@iptv/app-api';
import { HIDDEN_COMPETITIONS_MAX, PINNED_COMPETITIONS_MAX, competitionKey, type AppSettings } from '@iptv/core';
import { CATCHUP_COPY, favToggleLabel } from '../copy.ts';
import { joinMeta } from '../vod/stripLogic.ts';
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
  if (e.start > now && e.start - now < 3600_000) return `In ${Math.max(1, Math.round((e.start - now) / 60_000))} min`;
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
export function focusAfterLoad(prev: { hadRows: boolean }, next: { hasRows: boolean }, preferred: 'rail' | 'rows', overlayOpen: boolean): 'rail' | 'rows' | undefined {
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

/** A match's strip meta: when, how many channels, then the guide's competition text or sub-title. */
export const eventMeta = (e: SportsEventTile, now: number) => joinMeta(eventWhen(e, now), channelsLabel(e.channelCount), e.competition ?? e.subTitle);

type MatchPrefs = Pick<AppSettings, 'followedTeams' | 'pinnedCompetitions' | 'hiddenCompetitions'>;
const sameTeam = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Long Ok / Menu on a match (design note live-matches-ranking §3.8): From the start when an airing has an archive,
 * Follow or Unfollow each side, Put ‹competition› first (or undo it), Hide ‹competition›, Cancel. The competition is
 * the user's own guide text.
 */
export function eventMenuItems(e: SportsEventTile, st: MatchPrefs, archived: boolean): { id: string; label: string }[] {
  const items: { id: string; label: string }[] = [];
  if (archived) items.push({ id: 'fromStart', label: CATCHUP_COPY.fromStart });
  for (const side of e.sides ?? []) {
    items.push({ id: `follow:${side}`, label: `${st.followedTeams.some((f) => sameTeam(f, side)) ? 'Unfollow' : 'Follow'} ${side}` });
  }
  if (e.competition) {
    const pinned = st.pinnedCompetitions.includes(competitionKey(e.competition));
    items.push({ id: 'pin', label: pinned ? `Don't put ${e.competition} first` : `Put ${e.competition} first` });
    items.push({ id: 'hide', label: `Hide ${e.competition}` });
  }
  items.push({ id: 'cancel', label: 'Cancel' });
  return items;
}

/** The settings change a menu choice makes (undefined: none). New competition keys go last; the oldest drop at the cap. */
export function eventMenuPatch(choice: string, e: SportsEventTile, st: MatchPrefs): Partial<MatchPrefs> | undefined {
  if (choice.startsWith('follow:')) {
    const side = choice.slice(7);
    const on = st.followedTeams.some((f) => sameTeam(f, side));
    return { followedTeams: on ? st.followedTeams.filter((f) => !sameTeam(f, side)) : [...st.followedTeams, side] };
  }
  if (!e.competition || (choice !== 'pin' && choice !== 'hide')) return undefined;
  const key = competitionKey(e.competition);
  const pinned = st.pinnedCompetitions.filter((k) => k !== key);
  if (choice === 'pin') {
    return { pinnedCompetitions: pinned.length === st.pinnedCompetitions.length ? [...pinned, key].slice(-PINNED_COMPETITIONS_MAX) : pinned };
  }
  return { hiddenCompetitions: [...st.hiddenCompetitions.filter((k) => k !== key), key].slice(-HIDDEN_COMPETITIONS_MAX), pinnedCompetitions: pinned };
}

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

/** Start's rows use the shared row slots (`components/rowSlots.ts`); the old names stay for Start's imports. */
export { rowSlots as startRowSlots, type RowFrame as StartRowFrame } from '../components/rowSlots.ts';

/** Matches in your guide copy (design note §3.8): neutral, never sport or league words of our own. */
export const MATCHES_COPY = { title: 'Matches in your guide', empty: 'No matches in your guide right now.' } as const;

const CHIP_MIN_W = 120;
const CHIP_PAD = 48;
/** Roughly the body face's average glyph width at 1080p; chips only need to fit their label. */
const CHIP_GLYPH = 17;

/** See all's category chips: All, then the user's own guide category texts. None when the guide has no categories. */
export function matchChipActions(categories: readonly { id: string; label: string }[]): { id: string; label: string; width: number }[] {
  if (!categories.length) return [];
  const chip = (id: string, label: string) => ({ id, label, width: Math.max(CHIP_MIN_W, CHIP_PAD + label.length * CHIP_GLYPH) });
  return [chip('all', 'All'), ...categories.map((c) => chip(c.id, c.label))];
}
