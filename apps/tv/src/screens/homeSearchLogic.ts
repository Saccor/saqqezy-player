// apps/tv/src/screens/homeSearchLogic.ts
/**
 * Pure model of Home's search bar (unit-tested): search mode and what it saves and restores, Ok on a result and
 * the groups column while searching. `Home.tsx` only wires it.
 */
import { LAYOUT } from '../shell/theme.ts';
import type { GroupLite } from './homeLogic.ts';
import type { SearchRow } from './searchLogic.ts';

/** Home's groups column (layout A: 22 % of the safe width). The compact search keyboard covers exactly this. */
export const HOME_GROUP_W = Math.round((LAYOUT.width - LAYOUT.safeX * 2) * 0.22);

export const SEARCH_GROUP_ID = 'search';
export const SEARCH_GROUP_NAME = 'Search results';
export const SEARCH_HINT = 'Ok play · Ok again: fullscreen · Back: end search';
export const BAR_PLACEHOLDER = 'Search channels and programmes';

export type ListMode = 'browse' | 'search';

/** Where browsing was when search started: the group, its focused channel and the list scroll. */
export interface BrowsePosition { groupId: string; channelId?: string; top: number }

/** Search mode, kept across Home visits (each push/pop re-creates the screen). */
export interface HomeSearchState {
  /** Bar text: '' while browsing, never blank while searching. */
  query: string;
  /** The focused result row, restored when Home comes back from the Player or the Guide. */
  focus: number;
  /** The next settled answer restores `focus` (Ok opened the Player or the Guide). */
  returning: boolean;
  saved?: BrowsePosition;
  /** The source that was searched: a Home visit on another source starts in browse mode. */
  sourceId?: string;
}

export const BROWSE: HomeSearchState = { query: '', focus: 0, returning: false };

export function isSearching(s: HomeSearchState): boolean {
  return s.query !== '';
}

export function listMode(query: string): ListMode {
  return query === '' ? 'browse' : 'search';
}

/** Home's 700 ms focus preview runs only while browsing: typing and moving through results never start a stream. */
export function previewAllowed(mode: ListMode): boolean {
  return mode === 'browse';
}

export type QueryChange =
  | { kind: 'enter' | 'update' | 'none'; state: HomeSearchState }
  | { kind: 'exit'; state: HomeSearchState; restore?: BrowsePosition };

/**
 * New bar text. The first non-blank text enters search mode and saves `from` (the browse position) and the
 * source. Blank text (empty or whitespace only) leaves search mode, or changes nothing while browsing.
 */
export function applyQuery(s: HomeSearchState, text: string, from: BrowsePosition | undefined, sourceId: string | undefined): QueryChange {
  const blank = text.trim() === '';
  if (!isSearching(s)) {
    if (blank) return { kind: 'none', state: s };
    return { kind: 'enter', state: { query: text, focus: 0, returning: false, saved: from, sourceId } };
  }
  if (blank) return exitSearch(s);
  return { kind: 'update', state: { ...s, query: text, returning: false } };
}

/** Leaves search mode (Back, a cleared bar, a chosen group): browse mode and the position to restore. */
export function exitSearch(s: HomeSearchState): { kind: 'exit'; state: HomeSearchState; restore?: BrowsePosition } {
  return { kind: 'exit', state: BROWSE, restore: s.saved };
}

/** Ok opened the Player or the Guide from result `focus`: coming back restores it. */
export function leaveTo(s: HomeSearchState, focus: number): HomeSearchState {
  return { ...s, focus, returning: true };
}

/** The user handled a key in the results: their own position wins over a pending restore. */
export function userNavigated(s: HomeSearchState): HomeSearchState {
  return s.returning ? { ...s, returning: false } : s;
}

/** On Home mount: a remembered search comes back only on the same active source. */
export function restoreOnMount(s: HomeSearchState, activeSourceId: string | undefined): HomeSearchState {
  return isSearching(s) && s.sourceId === activeSourceId ? s : BROWSE;
}

export type OkAction = 'preview' | 'fullscreen' | 'guide' | 'none';

/** The channel of a selectable result row. */
export function rowChannelId(row: SearchRow | undefined): string | undefined {
  if (row?.kind === 'channel') return row.channel.id;
  if (row?.kind === 'onNow' || row?.kind === 'later') return row.hit.channel.id;
  return undefined;
}

/**
 * Ok on a result: a channel or on-now row plays in the small video unless that channel is already playing, which
 * goes fullscreen. A coming-up row opens the Guide at that time. Headers and notes do nothing.
 */
export function okAction(row: SearchRow | undefined, playingId: string | undefined): OkAction {
  if (row?.kind === 'later') return 'guide';
  const id = rowChannelId(row);
  if (id === undefined) return 'none';
  return id === playingId ? 'fullscreen' : 'preview';
}

/**
 * The groups column. While searching, a temporary `Search results` entry with the result count sits on top and is
 * the selected row. It is not a real group and is never stored.
 */
export function groupColumn(groups: readonly GroupLite[], searching: boolean, resultCount: number, selected: number):
  { rows: GroupLite[]; selected: number } {
  if (!searching) return { rows: [...groups], selected };
  return { rows: [{ id: SEARCH_GROUP_ID, name: SEARCH_GROUP_NAME, count: resultCount }, ...groups], selected: 0 };
}

/** Index into the real groups for a groups-column row; undefined for the `Search results` entry. */
export function groupChoice(index: number, searching: boolean): number | undefined {
  if (!searching) return index;
  return index === 0 ? undefined : index - 1;
}
