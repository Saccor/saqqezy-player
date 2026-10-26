/** The Start page: row kinds, focus movement and labels. Pure: no Solid, no Lightning. */
import type { MatchFilterChip, SportsEventTile, StartCell, StartRow, VodTile } from '@iptv/app-api';
import { HIDDEN_COMPETITIONS_MAX, PINNED_COMPETITIONS_MAX, competitionKey, type AppSettings } from '@iptv/core';
import { CATCHUP_COPY, COMMON_COPY, favToggleLabel, LIVE_COPY } from '../copy.ts';
import { joinMeta, tileStatus } from '../vod/stripLogic.ts';
import { metaLine } from '../vod/posterLogic.ts';
import { LAYOUT } from '../shell/theme.ts';
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
  if (e.start <= now && now < e.stop) return LIVE_COPY.start.live;
  if (e.start > now && e.start - now < 3600_000) return LIVE_COPY.start.inMinutes(Math.max(1, Math.round((e.start - now) / 60_000)));
  const d = new Date(e.start);
  const today = new Date(now);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  // A past start on another day (still running tiles are 'Live' above; a stale one) shows just the time.
  return sameDay || e.start <= now ? formatClock(d) : LIVE_COPY.start.tomorrowAt(formatClock(d));
}

/**
 * Where focus should go when a load finishes: the rows, once they have just appeared and the user wants them
 * (and no overlay owns focus). `undefined` leaves focus alone.
 */
export function focusAfterLoad(prev: { hadRows: boolean }, next: { hasRows: boolean }, preferred: 'rail' | 'rows', overlayOpen: boolean): 'rail' | 'rows' | undefined {
  return !prev.hadRows && next.hasRows && preferred === 'rows' && !overlayOpen ? 'rows' : undefined;
}

export const channelsLabel = (n: number) => (n === 1 ? '1 channel' : `${n} channels`);
/** Compact tiles: "4 ch" (the full form stays for the event picker). */
export const channelsShort = (n: number) => `${n} ch`;

/**
 * Long Ok / Menu on a channel cell: the same choice Home's channel menu leads with (favourite on or off), behind a
 * menu rather than at once, so a long press never flips a favourite by surprise. Cancel is last, like Home's.
 */
export function channelMenuItems(favourite: boolean): { id: 'fav' | 'cancel'; label: string }[] {
  return [{ id: 'fav', label: favToggleLabel(favourite) }, { id: 'cancel', label: COMMON_COPY.cancel }];
}
export const emptyStartText = () => LIVE_COPY.start.empty;

/** Start's dense layout (spec 2026-10-22 §1.1): no info strip, rows from just under the safe top. */
export const START_ROW_Y = LAYOUT.safeY + 26;
/** Start's posters: the compact grid size (`gridLayout('compact')`), so four rows fit at 1080p. */
export const START_POSTER = { w: 144, h: 216 } as const;
/** Fully visible tiles per Start row: posters 144 + 24 from x 160, compact tiles 360 + 24 (the next one peeks). */
export const START_POSTER_VISIBLE = 10;
export const START_WIDE_VISIBLE = 4;

/** The focused poster's text on its row's label line (Start has no info strip); '' for other cells. */
export function focusLabel(c: StartCell | undefined): string {
  if (c?.type !== 'vod') return '';
  const t = c.tile;
  return joinMeta(t.title, metaLine({ year: t.year, rating: t.rating }), tileStatus(t));
}

/** Roughly the strong body face's average glyph width at 1080p: where the focus text after a row title starts. */
const LABEL_GLYPH = 15;
export const labelWidth = (title: string) => Math.ceil(title.length * LABEL_GLYPH);

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
    items.push({ id: `follow:${side}`, label: st.followedTeams.some((f) => sameTeam(f, side)) ? LIVE_COPY.start.unfollow(side) : LIVE_COPY.start.follow(side) });
  }
  if (e.competition) {
    const pinned = st.pinnedCompetitions.includes(competitionKey(e.competition));
    items.push({ id: 'pin', label: pinned ? LIVE_COPY.start.dontPutFirst(e.competition) : LIVE_COPY.start.putFirst(e.competition) });
    items.push({ id: 'hide', label: LIVE_COPY.start.hide(e.competition) });
  }
  items.push({ id: 'cancel', label: COMMON_COPY.cancel });
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
  return competitionPatch(choice, competitionKey(e.competition), st);
}

export function toPosterRow(r: StartRow): RowModel {
  const items = r.cells.flatMap((c) => (c.type === 'vod' ? [c.tile as VodTile] : []));
  const all = r.cells.find((c) => c.type === 'viewAll');
  return { id: r.id, title: r.title, total: all?.type === 'viewAll' ? all.total : items.length, items, loaded: true };
}

/** Start's rows use the shared row slots (`components/rowSlots.ts`); the old names stay for Start's imports. */
export { rowSlots as startRowSlots, type RowFrame as StartRowFrame } from '../components/rowSlots.ts';

/** Matches copy (design note §3.8, spec 2026-10-22): neutral, never sport or league words of our own. */
export const MATCHES_COPY = LIVE_COPY.matches;

/** View all's summary after the title: the chosen sport or competition (guide text) and the count. */
export const matchesSummary = (label: string, n: number) => `${label} · ${n === 1 ? '1 match' : `${n} matches`}`;

const CHIP_MIN_W = 120;
/** A long guide text is cut (one line) rather than pushing the other chips off the screen. */
const CHIP_MAX_W = 320;
const CHIP_PAD = 48;
/** Roughly the body face's average glyph width at 1080p; chips only need to fit their label. */
const CHIP_GLYPH = 17;
/** ActionBar's gap between buttons. */
const CHIP_GAP = 16;

/** Chip widths: each fits its label (at most CHIP_MAX_W); when the bar would pass `maxTotal`, the widest share a cap. */
function sizeChips(list: readonly { id: string; label: string }[], maxTotal: number): { id: string; label: string; width: number }[] {
  const out = list.map((c) => ({ id: c.id, label: c.label, width: Math.min(CHIP_MAX_W, Math.max(CHIP_MIN_W, CHIP_PAD + c.label.length * CHIP_GLYPH)) }));
  let budget = maxTotal - CHIP_GAP * (out.length - 1);
  if (out.reduce((s, c) => s + c.width, 0) <= budget) return out;
  // Water-fill: the narrow chips keep their width, the rest share what is left.
  const asc = [...out].sort((a, b) => a.width - b.width);
  let left = asc.length;
  for (const c of asc) {
    const cap = Math.max(CHIP_MIN_W, Math.floor(budget / left));
    if (c.width > cap) c.width = cap;
    budget -= c.width;
    left--;
  }
  return out;
}

/** See all's category chips: All, then the user's own guide category texts. None when the guide has no categories. */
export function matchChipActions(categories: readonly { id: string; label: string }[], maxTotal = Infinity): { id: string; label: string; width: number }[] {
  if (!categories.length) return [];
  return sizeChips([{ id: 'all', label: LIVE_COPY.start.all }, ...categories], maxTotal);
}

export const COMP_ALL = 'all';
export const COMP_MORE = 'more';
const COMP_PREFIX = 'c:';
/** A competition chip's id: prefixed, so a guide text such as "more" never collides with All or More…. */
export const compChipId = (key: string) => `${COMP_PREFIX}${key}`;
export const compKeyOf = (id: string): string | undefined => (id.startsWith(COMP_PREFIX) ? id.slice(COMP_PREFIX.length) : undefined);

/** View all's second chip row: All <sport>, the sport's competitions (guide text, ★ when pinned), then More…. */
export function competitionChipActions(sportLabel: string, chips: readonly MatchFilterChip[], hasMore: boolean, maxTotal = Infinity): { id: string; label: string; width: number }[] {
  if (!chips.length) return [];
  return sizeChips([
    { id: COMP_ALL, label: LIVE_COPY.start.allOf(sportLabel) },
    ...chips.map((c) => ({ id: compChipId(c.id), label: c.pinned ? `★ ${c.label}` : c.label })),
    ...(hasMore ? [{ id: COMP_MORE, label: MATCHES_COPY.more }] : []),
  ], maxTotal);
}

/** Long Ok / Menu on a competition chip: the match menu's competition choices. */
export function competitionMenuItems(label: string, key: string, st: MatchPrefs): { id: 'pin' | 'hide' | 'cancel'; label: string }[] {
  const pinned = st.pinnedCompetitions.includes(key);
  return [
    { id: 'pin', label: pinned ? LIVE_COPY.start.dontPutFirst(label) : LIVE_COPY.start.putFirst(label) },
    { id: 'hide', label: LIVE_COPY.start.hide(label) },
    { id: 'cancel', label: COMMON_COPY.cancel },
  ];
}

/** The settings change of putting a competition first (or not) or hiding it. New keys go last; the oldest drop at the cap. */
export function competitionPatch(choice: 'pin' | 'hide', key: string, st: MatchPrefs): Partial<MatchPrefs> {
  const pinned = st.pinnedCompetitions.filter((k) => k !== key);
  if (choice === 'pin') {
    return { pinnedCompetitions: pinned.length === st.pinnedCompetitions.length ? [...pinned, key].slice(-PINNED_COMPETITIONS_MAX) : pinned };
  }
  return { hiddenCompetitions: [...st.hiddenCompetitions.filter((k) => k !== key), key].slice(-HIDDEN_COMPETITIONS_MAX), pinnedCompetitions: pinned };
}

/** The chip in effect: the first stored category the guide still offers, else All (a stale one does not filter). */
export function activeMatchChip(chips: readonly { id: string }[], stored: readonly string[]): string {
  return stored.find((id) => chips.some((c) => c.id === id)) ?? 'all';
}
