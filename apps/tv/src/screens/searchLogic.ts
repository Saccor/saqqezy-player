import type { AppEvent, ChannelRow, FolderHit, ProgrammeHit, SearchResult, TitleHit, VodTile } from '@iptv/app-api';
import { LIVE_COPY } from '../copy.ts';
import { formatClock } from '../shell/logic.ts';
import type { RowModel } from '../vod/browseLogic.ts';
import { dayLabel } from './guideLogic.ts';
import { formatRange } from './homeLogic.ts';

/** Debounced search with a stale-result guard (pure: timers and the search call are injected). */

const SEARCH_DEBOUNCE_MS = 150;
export const SEARCH_LIMIT = 50;

export interface SearchState<R> {
  /** The latest query (trimmed). While `busy`, `results` may still be the previous query's. */
  query: string;
  results: R;
  /** A search is scheduled or running for the latest query. */
  busy: boolean;
  /** The latest search failed. */
  failed: boolean;
}

export interface Searcher {
  setQuery(raw: string): void;
  dispose(): void;
}

/** `empty`: the results of an empty query or a failed search. */
export function createSearcher<R>(
  run: (query: string) => Promise<R>,
  onState: (s: SearchState<R>) => void,
  opts: { empty: R; delayMs?: number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void },
): Searcher {
  const delay = opts.delayMs ?? SEARCH_DEBOUNCE_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const empty = opts.empty;
  let timer: unknown;
  let seq = 0;
  let disposed = false;
  /** The last settled results: kept on screen while the next query runs, so the rows do not flash empty. */
  let shown: R = empty;

  const emit = (s: SearchState<R>) => {
    if (disposed) return;
    if (!s.busy) shown = s.results;
    onState(s);
  };

  return {
    setQuery(raw) {
      const q = raw.trim();
      const mine = ++seq; // supersedes any scheduled or in-flight search
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      if (q === '') {
        emit({ query: '', results: empty, busy: false, failed: false });
        return;
      }
      emit({ query: q, results: shown, busy: true, failed: false });
      timer = setTimer(() => {
        timer = undefined;
        run(q).then(
          (results) => { if (mine === seq) emit({ query: q, results, busy: false, failed: false }); },
          () => { if (mine === seq) emit({ query: q, results: empty, busy: false, failed: true }); },
        );
      }, delay);
    },
    dispose() {
      disposed = true;
      seq++;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
}

export const GUIDE_PENDING_NOTE = LIVE_COPY.search.guidePending;
export const VOD_PENDING_NOTE = LIVE_COPY.search.vodPending;
export const VOD_ROW_LABEL = LIVE_COPY.search.vodRow;
export const FOLDERS_ROW_LABEL = LIVE_COPY.search.foldersRow;
const LIVE_ROW_LABEL = LIVE_COPY.search.liveRow;

/** Events after which Search re-runs the open query: a search index became ready, or a guide import finished. */
export function rerunsSearch(e: AppEvent): boolean {
  return e.type === 'searchReady' || (e.type === 'refreshed' && e.what === 'epg');
}

/** A programme in the live row: one on now (plays its channel) or a coming-up airing (opens Live TV at it). */
export type ProgrammeCell =
  | { type: 'programme'; when: 'onNow'; hit: ProgrammeHit }
  | { type: 'programme'; when: 'later'; hit: TitleHit };
/** Matches in groups Your countries hides: a card after the channels that opens that setting. */
export type HiddenCell = { type: 'hidden'; count: number };
/** A cell of the "Live & guide" row (drawn as a wide card). */
export type LiveCell = { type: 'channel'; channel: ChannelRow } | HiddenCell | ProgrammeCell;
/** A folder (a channel folder or a movie/series category) in the Folders row. */
export type FolderCell = { type: 'folder'; hit: FolderHit };
/** Any focusable result. */
export type SearchCell = { type: 'vod'; tile: VodTile } | LiveCell | FolderCell;

/** The three result rows, plus what is still being prepared. */
export interface SearchRows {
  /** Movies, then series. */
  vod: VodTile[];
  /** Channel folders, then movie and series categories. */
  folders: FolderCell[];
  /** Channels, the hidden-groups card, then programmes on now, then coming up. */
  live: LiveCell[];
  /** Channels shown in `live`, and every channel that matched. */
  channelCount: number;
  channelTotal: number;
  guidePending: boolean;
  vodPending: boolean;
}

export const NO_ROWS: SearchRows = { vod: [], folders: [], live: [], channelCount: 0, channelTotal: 0, guidePending: false, vodPending: false };

export function searchRows(r: SearchResult): SearchRows {
  return {
    vod: [...r.movies, ...r.series],
    folders: r.folders.map((hit): FolderCell => ({ type: 'folder', hit })),
    live: [
      ...r.channels.map((channel): LiveCell => ({ type: 'channel', channel })),
      ...(r.hiddenCount > 0 ? [{ type: 'hidden', count: r.hiddenCount } satisfies LiveCell] : []),
      ...r.onNow.map((hit): LiveCell => ({ type: 'programme', when: 'onNow', hit })),
      ...r.later.map((hit): LiveCell => ({ type: 'programme', when: 'later', hit })),
    ],
    channelCount: r.channels.length,
    channelTotal: Math.max(r.channelTotal, r.channels.length),
    guidePending: r.guidePending,
    vodPending: r.vodPending,
  };
}

/** "Live & guide · 12 channels", or "· 50 of 340 channels" when more matched than are shown. */
export function liveRowLabel(r: SearchRows): string {
  if (r.channelCount === 0) return LIVE_ROW_LABEL;
  const noun = r.channelTotal === 1 ? 'channel' : 'channels';
  const count = r.channelTotal > r.channelCount ? `${r.channelCount} of ${r.channelTotal}` : `${r.channelTotal}`;
  return `${LIVE_ROW_LABEL} · ${count} ${noun}`;
}

/** What is still being prepared: the guide first, then movies and series. */
export function pendingNotes(r: SearchRows): string[] {
  return [...(r.guidePending ? [GUIDE_PENDING_NOTE] : []), ...(r.vodPending ? [VOD_PENDING_NOTE] : [])];
}

const hasResults = (r: SearchRows) => r.vod.length > 0 || r.folders.length > 0 || r.live.length > 0;

/** The VOD row as a poster row (loaded, every title in it: no View all). */
export function vodRowModel(r: SearchRows): RowModel {
  return { id: 'search-vod', title: VOD_ROW_LABEL, total: r.vod.length, items: r.vod, loaded: true };
}

/** A programme card's muted context line: when, then the channel ("20:00–21:30 · News", "Tomorrow 09:05 · News · +2 more"). */
export function programmeContext(c: ProgrammeCell, now: number): string {
  const ch = c.hit.channel.name;
  if (c.when === 'onNow') return `${formatRange(c.hit.start, c.hit.stop)} · ${ch}`;
  const more = c.hit.more > 0 ? ` · +${c.hit.more} more` : '';
  return `${dayLabel(c.hit.start, now)} ${formatClock(new Date(c.hit.start))} · ${ch}${more}`;
}

export type SearchArea = 'keyboard' | 'vod' | 'folders' | 'live';
/** Result rows, top to bottom. */
export const SEARCH_ROW_ORDER = ['vod', 'folders', 'live'] as const;
export type SearchRowArea = (typeof SEARCH_ROW_ORDER)[number];
/** Where the focus is; `col` counts only in a row. */
export interface SearchFocus { area: SearchArea; col: number }

const KEYBOARD: SearchFocus = { area: 'keyboard', col: 0 };
const rowLength = (r: SearchRows, area: SearchArea) =>
  (area === 'vod' ? r.vod.length : area === 'folders' ? r.folders.length : area === 'live' ? r.live.length : 0);
/** The first non-empty row at or after index `from` of the row order, going in `dir` (1: down, -1: up); undefined when none. */
const nearestRow = (r: SearchRows, from: number, dir: 1 | -1): SearchRowArea | undefined => {
  for (let i = from; i >= 0 && i < SEARCH_ROW_ORDER.length; i += dir) if (rowLength(r, SEARCH_ROW_ORDER[i]!) > 0) return SEARCH_ROW_ORDER[i];
  return undefined;
};

export function focusedCell(r: SearchRows, f: SearchFocus): SearchCell | undefined {
  if (f.area === 'vod') { const tile = r.vod[f.col]; return tile ? { type: 'vod', tile } : undefined; }
  if (f.area === 'folders') return r.folders[f.col];
  if (f.area === 'live') return r.live[f.col];
  return undefined;
}

/** The focus moved onto rows that may have changed: an emptied row gives way to the next row down, then up, then the keyboard. */
export function clampSearchFocus(f: SearchFocus, r: SearchRows): SearchFocus {
  if (f.area === 'keyboard') return KEYBOARD;
  const i = SEARCH_ROW_ORDER.indexOf(f.area);
  const area = rowLength(r, f.area) > 0 ? f.area : nearestRow(r, i + 1, 1) ?? nearestRow(r, i - 1, -1);
  if (!area) return KEYBOARD;
  return { area, col: Math.max(0, Math.min(f.col, rowLength(r, area) - 1)) };
}

/**
 * One D-pad step. In a row: Left/Right move along it (Left at column 0 returns to the keyboard), Up/Down go to the
 * nearest other row with results. From the keyboard's edges (the keyboard moves its own cursor): Right goes to the first
 * row with results, Left to the rail.
 */
export function moveSearch(f: SearchFocus, key: 'up' | 'down' | 'left' | 'right', r: SearchRows): SearchFocus | 'keyboard' | 'rail' {
  if (f.area === 'keyboard') {
    if (key === 'left') return 'rail';
    if (key !== 'right') return 'keyboard';
    const first = nearestRow(r, 0, 1);
    return first ? { area: first, col: 0 } : 'keyboard';
  }
  const len = rowLength(r, f.area);
  if (key === 'left') return f.col <= 0 ? 'keyboard' : { area: f.area, col: Math.min(f.col - 1, len - 1) };
  if (key === 'right') return { area: f.area, col: Math.max(0, Math.min(f.col + 1, len - 1)) };
  const i = SEARCH_ROW_ORDER.indexOf(f.area);
  const target = key === 'up' ? nearestRow(r, i - 1, -1) : nearestRow(r, i + 1, 1);
  if (!target) return f;
  return { area: target, col: Math.min(f.col, rowLength(r, target) - 1) };
}

export interface SettleInput {
  rows: SearchRows;
  /** Back from the Player or a detail screen: the next full answer restores `memory`. */
  returning: boolean;
  memory: SearchFocus;
  current: SearchFocus;
  /** The settled answer's query, and the query of the answer before it. */
  query: string;
  settledQuery: string;
}

/**
 * Focus for a settled answer. Returning from the Player or a detail screen restores the saved cell, but an answer still
 * waiting for guide, movie or series results only sets a provisional focus and keeps `returning`, so the full answer
 * that follows restores the saved cell exactly. A re-run of the same query keeps the focused cell; a new query keeps the
 * keyboard, or starts the focused row at its first cell.
 */
export function settleFocus(i: SettleInput): { focus: SearchFocus; consumeReturning: boolean } {
  const { rows } = i;
  if (i.returning && hasResults(rows)) {
    return { focus: clampSearchFocus(i.memory, rows), consumeReturning: pendingNotes(rows).length === 0 };
  }
  if (i.returning || (i.query !== '' && i.query === i.settledQuery)) return { focus: clampSearchFocus(i.current, rows), consumeReturning: false };
  return { focus: clampSearchFocus({ area: i.current.area, col: 0 }, rows), consumeReturning: false };
}

/** Where Ok on a movie or series goes: its detail screen, with the tile to draw until the detail loads. */
export function vodRoute(c: SearchCell | undefined): { screen: 'movieDetail' | 'seriesDetail'; params: { id: string; tile: VodTile } } | undefined {
  if (c?.type !== 'vod') return undefined;
  return { screen: c.tile.kind === 'movie' ? 'movieDetail' : 'seriesDetail', params: { id: c.tile.id, tile: c.tile } };
}

/**
 * Where Ok on a coming-up programme goes: back to Live TV (the root `home`, never a second one), opened at that
 * channel and the programme's start.
 */
export function laterRoute(c: SearchCell | undefined): { screen: 'home'; params: { channelId: string; at: number } } | undefined {
  if (c?.type !== 'programme' || c.when !== 'later') return undefined;
  return { screen: 'home', params: { channelId: c.hit.channel.id, at: c.hit.start } };
}

/** Where Ok on the hidden-groups card goes: Settings at Your countries. */
export function hiddenRoute(c: SearchCell | undefined): { screen: 'settings'; params: { page: 'countries' } } | undefined {
  return c?.type === 'hidden' ? { screen: 'settings', params: { page: 'countries' } } : undefined;
}

/** Where Ok on a folder goes: Live TV at that folder (the root `home`), or the grid of that kind at that category. */
export function folderRoute(c: SearchCell | undefined):
  | { screen: 'home'; params: { groupId: string } }
  | { screen: 'vodGrid'; params: { kind: 'movie' | 'series'; categoryId: string } }
  | undefined {
  if (c?.type !== 'folder') return undefined;
  if (c.hit.kind === 'live') return { screen: 'home', params: { groupId: c.hit.id } };
  return { screen: 'vodGrid', params: { kind: c.hit.kind, categoryId: c.hit.id } };
}

/** A folder tile's muted count line. */
export function folderCount(hit: FolderHit): string {
  const n = hit.count;
  if (hit.kind === 'live') return n === 1 ? '1 channel' : `${n} channels`;
  if (hit.kind === 'movie') return n === 1 ? '1 movie' : `${n} movies`;
  return `${n} series`;
}

/** The channel Ok plays: a channel's own, or an on-now programme's. */
export function channelToPlay(c: SearchCell | undefined): ChannelRow | undefined {
  if (c?.type === 'channel') return c.channel;
  if (c?.type === 'programme' && c.when === 'onNow') return c.hit.channel;
  return undefined;
}

/** Text for the results area when it has no rows (undefined when there are results). */
export function resultsMessage(s: SearchState<SearchRows>): string | undefined {
  if (s.query === '') return LIVE_COPY.search.typeToSearch;
  if (hasResults(s.results)) return undefined;
  if (s.busy) return LIVE_COPY.search.searching;
  if (s.failed) return LIVE_COPY.search.failed;
  const note = pendingNotes(s.results)[0];
  if (note) return LIVE_COPY.search.nothingNote(s.query, note);
  return LIVE_COPY.search.nothing(s.query);
}

/** A subtle note beside the first row while the next query runs over the shown rows (with no rows the message says it). */
export function searchingNote(s: SearchState<SearchRows>): string | undefined {
  return s.busy && hasResults(s.results) ? LIVE_COPY.search.searching : undefined;
}

export interface SearchMemory {
  query: string;
  area: SearchArea;
  col: number;
  /** The next answer restores `area` and `col` (set when Ok opened the Player or a detail screen). */
  returning: boolean;
  /** Back left Search: start fresh next time. */
  leaveBack(): void;
  /** Ok opened the Player or a detail screen: Back returns to the same results and cell. */
  leaveTo(focus: SearchFocus): void;
  /** The user handled a key in the results: their own position wins over a pending restore. */
  userNavigated(): void;
}

/** What Search remembers across visits (each push/pop re-creates the screen). */
export function createSearchMemory(): SearchMemory {
  const m: SearchMemory = {
    query: '',
    area: 'keyboard',
    col: 0,
    returning: false,
    leaveBack() { m.query = ''; m.area = 'keyboard'; m.col = 0; m.returning = false; },
    leaveTo(f) { m.area = f.area; m.col = f.col; m.returning = true; },
    userNavigated() { m.returning = false; },
  };
  return m;
}
