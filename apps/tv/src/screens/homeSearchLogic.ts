// apps/tv/src/screens/homeSearchLogic.ts
/**
 * Pure model of Home's search bar (unit-tested): search mode and what it saves and restores, Ok on a result, the
 * groups column while searching, focus routing and hardware typing. `Home.tsx` only wires it.
 */
import { applyKey, textEntryKey, type TextKey } from '../components/keyboardLogic.ts';
import { LAYOUT } from '../shell/theme.ts';
import type { GroupLite } from './homeLogic.ts';
import type { SearchRow } from './searchLogic.ts';

/** Home's groups column (layout A: 22 % of the safe width). The compact search keyboard covers exactly this. */
export const HOME_GROUP_W = Math.round((LAYOUT.width - LAYOUT.safeX * 2) * 0.22);

export const SEARCH_GROUP_ID = 'search';
export const SEARCH_GROUP_NAME = 'Search results';
export const SEARCH_HINT = 'Ok play · Ok again: fullscreen · Back: end search';
export const BAR_PLACEHOLDER = 'Search channels and programmes';
/** The longest bar text, on every input path (hardware keys, remote digits, the compact keyboard). */
export const SEARCH_MAX_LENGTH = 100;

/** Cuts bar text to `SEARCH_MAX_LENGTH` characters. */
export function capQuery(text: string): string {
  const chars = [...text];
  return chars.length <= SEARCH_MAX_LENGTH ? text : chars.slice(0, SEARCH_MAX_LENGTH).join('');
}

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
 * Ok on a result: a channel or on-now row plays in the small video unless that channel is already playing (or its
 * preview is still being fetched, `requestedId`), which goes fullscreen. A coming-up row opens the Guide at that
 * time. Headers and notes do nothing.
 */
export function okAction(row: SearchRow | undefined, playingId: string | undefined, requestedId?: string): OkAction {
  if (row?.kind === 'later') return 'guide';
  const id = rowChannelId(row);
  if (id === undefined) return 'none';
  return id === playingId || id === requestedId ? 'fullscreen' : 'preview';
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

/** Where key focus is on Home. `list` is the channel list while browsing and the results while searching. */
export type Place = 'groups' | 'list' | 'bar' | 'keyboard';
export type NavKey = 'up' | 'down' | 'left' | 'right' | 'back' | 'done';

export interface NavContext {
  searching: boolean;
  /** The compact keyboard is open (over the groups column). */
  keyboardOpen: boolean;
  /** At least one result row is selectable. */
  hasResults: boolean;
  /** The open group has channels (browse mode). */
  hasChannels: boolean;
  /** The key hits an edge: the first row (list), the first group (groups), the top row or right end (keyboard). */
  atEdge: boolean;
}

/** `focus`: move there. `exit`: leave search mode, then focus. `stay`: handled, no move. `pass`: run the usual handler. */
export type NavResult =
  | { kind: 'focus'; place: Place }
  | { kind: 'exit'; focus: Place }
  | { kind: 'stay' }
  | { kind: 'pass' };

/** Where focus goes after search mode ends: the list only when the restored group has channels, else the groups. */
export function exitFocusTarget(focusTo: Place, listCount: number): Place {
  return focusTo === 'list' && listCount === 0 ? 'groups' : focusTo;
}

/**
 * Focus on the results when they lose their last selectable row (the query narrowed, a re-run found nothing): it
 * moves to the keyboard while it is open, else to the bar. Undefined: nothing to move.
 */
export function resultsFocusLost(c: { area: Place; searching: boolean; hasResults: boolean; keyboardOpen: boolean }): Place | undefined {
  if (c.area !== 'list' || !c.searching || c.hasResults) return undefined;
  return c.keyboardOpen ? 'keyboard' : 'bar';
}

const focusTo = (place: Place): NavResult => ({ kind: 'focus', place });
const STAY: NavResult = { kind: 'stay' };
const PASS: NavResult = { kind: 'pass' };
const EXIT: NavResult = { kind: 'exit', focus: 'list' };

/** Focus routing between the bar, the compact keyboard, the list (or results) and the groups column. */
export function routeKey(place: Place, key: NavKey, c: NavContext): NavResult {
  const results = c.hasResults ? focusTo('list') : STAY;
  switch (place) {
    case 'bar':
      if (key === 'down') return c.searching ? results : c.hasChannels ? focusTo('list') : STAY;
      if (key === 'left') return focusTo(c.keyboardOpen ? 'keyboard' : 'groups');
      if (key === 'back') return c.searching ? EXIT : PASS;
      return STAY;
    case 'list':
      if (key === 'up' && c.atEdge) return focusTo('bar');
      // The groups are hidden under the open keyboard (also after the bar was cleared): Left goes to its keys.
      if (key === 'left' && c.keyboardOpen) return focusTo('keyboard');
      if (!c.searching) return PASS;
      if (key === 'left') return focusTo(c.keyboardOpen ? 'keyboard' : 'groups');
      if (key === 'back' && !c.keyboardOpen) return EXIT;
      return PASS;
    case 'groups':
      if (key === 'up' && c.atEdge) return focusTo('bar');
      if (c.searching && key === 'back') return c.hasResults ? focusTo('list') : EXIT;
      return PASS;
    case 'keyboard':
      if (key === 'up' && c.atEdge) return focusTo('bar');
      if (key === 'right' && c.atEdge) return results;
      if (key === 'done') return c.hasResults ? focusTo('list') : focusTo('bar');
      return PASS;
  }
}

export interface TypingContext {
  /** A Home layer or a shell dialog is open (a toast does not count). */
  overlayOpen: boolean;
  barFocused: boolean;
  query: string;
}

const isLetter = (ch: string) => ch.toLowerCase() !== ch.toUpperCase();

/**
 * A hardware key on Home (keyboard closed) that types into the bar. Letters start a query from anywhere. Digits,
 * space and symbols type only while the bar has focus, so digits keep their remote meaning elsewhere. Backspace
 * belongs to the bar while it has focus (a no-op on empty text), otherwise it stays Back. Nothing types while an overlay is open.
 */
export function typingKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, c: TypingContext): TextKey | undefined {
  if (c.overlayOpen) return undefined;
  const k = textEntryKey(e);
  if (!k) return undefined;
  // In the bar Backspace is always typing, even with no text left: a held key must not auto-repeat into Back.
  if (k.kind === 'backspace') return c.barFocused ? k : undefined;
  return c.barFocused || isLetter(k.ch) ? k : undefined;
}

/** The bar text after a typed key (characters are written as typed), capped at `SEARCH_MAX_LENGTH`. */
export function typedQuery(query: string, k: TextKey): string {
  return capQuery(applyKey({ value: query, shift: false }, k.kind === 'char' ? { kind: 'text', text: k.ch } : { kind: 'backspace' }).value);
}
