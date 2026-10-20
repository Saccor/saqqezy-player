import type { AppEvent, ChannelRow, ProgrammeHit, SearchResult, TitleHit, VodTile } from '@iptv/app-api';
import { firstSelectable, scrollTopFor } from '../components/virtualWindow.ts';

/** Debounced search with a stale-result guard (pure: timers and the search call are injected). */

export const SEARCH_DEBOUNCE_MS = 150;
export const SEARCH_LIMIT = 50;

export interface SearchState<T> {
  /** The latest query (trimmed). While `busy`, `results` may still be the previous query's. */
  query: string;
  results: T[];
  /** A search is scheduled or running for the latest query. */
  busy: boolean;
  /** The latest search failed. */
  failed: boolean;
}

export interface Searcher {
  setQuery(raw: string): void;
  dispose(): void;
}

export function createSearcher<T>(
  run: (query: string) => Promise<T[]>,
  onState: (s: SearchState<T>) => void,
  opts: { delayMs?: number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void } = {},
): Searcher {
  const delay = opts.delayMs ?? SEARCH_DEBOUNCE_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timer: unknown;
  let seq = 0;
  let disposed = false;
  /** The last settled results: kept on screen while the next query runs, so the list does not flash empty. */
  let shown: T[] = [];

  const emit = (s: SearchState<T>) => {
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
        emit({ query: '', results: [], busy: false, failed: false });
        return;
      }
      emit({ query: q, results: shown, busy: true, failed: false });
      timer = setTimer(() => {
        timer = undefined;
        run(q).then(
          (results) => { if (mine === seq) emit({ query: q, results, busy: false, failed: false }); },
          () => { if (mine === seq) emit({ query: q, results: [], busy: false, failed: true }); },
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

export const GUIDE_PENDING_NOTE = 'Guide results are being prepared';
export const VOD_PENDING_NOTE = 'Movies and series are being prepared';
const PENDING_NOTES: readonly string[] = [GUIDE_PENDING_NOTE, VOD_PENDING_NOTE];

/** Events after which Search re-runs the open query: a search index became ready, or a guide import finished. */
export function rerunsSearch(e: AppEvent): boolean {
  return e.type === 'searchReady' || (e.type === 'refreshed' && e.what === 'epg');
}

/** One row of the flat result list; headers and notes are drawn but never take focus. */
export type SearchRow =
  | { kind: 'header'; label: string }
  | { kind: 'note'; label: string }
  | { kind: 'channel'; channel: ChannelRow }
  | { kind: 'vod'; tile: VodTile }
  | { kind: 'onNow'; hit: ProgrammeHit }
  | { kind: 'later'; hit: TitleHit };

/**
 * Sections in fixed order (Channels, Movies, Series, On now, Coming up), each under a header; empty sections are
 * left out. Pending notes (guide, then movies and series) come last.
 */
export function flattenResults(r: SearchResult): SearchRow[] {
  const out: SearchRow[] = [];
  if (r.channels.length) {
    out.push({ kind: 'header', label: 'Channels' });
    for (const channel of r.channels) out.push({ kind: 'channel', channel });
  }
  if (r.movies.length) {
    out.push({ kind: 'header', label: 'Movies' });
    for (const tile of r.movies) out.push({ kind: 'vod', tile });
  }
  if (r.series.length) {
    out.push({ kind: 'header', label: 'Series' });
    for (const tile of r.series) out.push({ kind: 'vod', tile });
  }
  if (r.onNow.length) {
    out.push({ kind: 'header', label: 'On now' });
    for (const hit of r.onNow) out.push({ kind: 'onNow', hit });
  }
  if (r.later.length) {
    out.push({ kind: 'header', label: 'Coming up' });
    for (const hit of r.later) out.push({ kind: 'later', hit });
  }
  // Kept even when nothing is selectable, so `resultsMessage` can say what is still being prepared.
  if (r.guidePending) out.push({ kind: 'note', label: GUIDE_PENDING_NOTE });
  if (r.vodPending) out.push({ kind: 'note', label: VOD_PENDING_NOTE });
  return out;
}

/** Where Ok on a movie or series row goes: its detail screen, with the tile to draw until the detail loads. */
export function vodRoute(row: SearchRow | undefined): { screen: 'movieDetail' | 'seriesDetail'; params: { id: string; tile: VodTile } } | undefined {
  if (row?.kind !== 'vod') return undefined;
  return { screen: row.tile.kind === 'movie' ? 'movieDetail' : 'seriesDetail', params: { id: row.tile.id, tile: row.tile } };
}

/**
 * Where Ok on a coming-up row goes: back to Live TV (the root `home`, never a second one), opened at that channel and
 * the programme's start.
 */
export function laterRoute(row: SearchRow | undefined): { screen: 'home'; params: { channelId: string; at: number } } | undefined {
  if (row?.kind !== 'later') return undefined;
  return { screen: 'home', params: { channelId: row.hit.channel.id, at: row.hit.start } };
}

/** A movie or series row's text: compact, no poster (title · year). */
export function vodLine(t: VodTile): string {
  return t.year ? `${t.title} · ${t.year}` : t.title;
}

/** The rows the list draws: none when nothing is selectable (a lone note is shown by `resultsMessage` instead). */
export function listRows(rows: readonly SearchRow[]): readonly SearchRow[] {
  return selectableCount(rows) > 0 ? rows : [];
}

/** True when the answer is still waiting for guide results (it carries the pending note). */
export function isGuidePending(rows: readonly SearchRow[]): boolean {
  return rows.some((r) => r.kind === 'note' && r.label === GUIDE_PENDING_NOTE);
}

/** The first pending note of the answer (guide, or movies and series), if it is still waiting for any results. */
function pendingNote(rows: readonly SearchRow[]): string | undefined {
  for (const r of rows) if (r.kind === 'note' && PENDING_NOTES.includes(r.label)) return r.label;
  return undefined;
}

export interface FocusInput {
  rows: readonly SearchRow[];
  /** Back from the Player or a detail screen: the next full answer restores `memoryFocus`. */
  returning: boolean;
  memoryFocus: number;
  prevFocus: number;
  /** The settled answer's query, and the query of the answer before it. */
  query: string;
  settledQuery: string;
  viewRows: number;
}

export interface FocusDecision {
  focus: number;
  /** New window top; absent when the scroll position is kept (a re-run of the same query). */
  top?: number;
  /** The restore is done: clear `returning`. */
  consumeReturning: boolean;
  /** Move key focus to the result list. */
  focusList: boolean;
}

/**
 * Focus for a settled answer. Returning from the Player or a detail screen restores the saved row, but an
 * answer still waiting for guide, movie or series results only sets a provisional focus and keeps `returning`, so the
 * full answer that follows restores the saved row exactly. A re-run of the same query keeps the focused row; a
 * new query starts at the top.
 */
export function nextFocus(i: FocusInput): FocusDecision {
  const { rows } = i;
  const sel = (n: number) => isSelectable(rows[n]);
  const top = (f: number) => Math.max(0, f - i.viewRows + 1);
  if (i.returning && selectableCount(rows) > 0) {
    const focus = firstSelectable(i.memoryFocus, rows.length, sel);
    return { focus, top: top(focus), consumeReturning: pendingNote(rows) === undefined, focusList: true };
  }
  if (!i.returning && i.query !== '' && i.query === i.settledQuery) {
    return { focus: firstSelectable(Math.min(i.prevFocus, rows.length - 1), rows.length, sel), consumeReturning: false, focusList: false };
  }
  const focus = firstSelectable(0, rows.length, sel);
  return { focus, top: top(focus), consumeReturning: false, focusList: false };
}

export function isSelectable(row: SearchRow | undefined): boolean {
  return row !== undefined && row.kind !== 'header' && row.kind !== 'note';
}

export function selectableCount(rows: readonly SearchRow[]): number {
  let n = 0;
  for (const r of rows) if (isSelectable(r)) n++;
  return n;
}

/** Text for the empty/placeholder area of the results (undefined when there are results). */
export function resultsMessage(s: SearchState<SearchRow>): string | undefined {
  if (s.query === '') return 'Type to search channels, programmes, movies and series';
  if (selectableCount(s.results) > 0) return undefined;
  if (s.busy) return 'Searching…';
  if (s.failed) return "Couldn't search right now.";
  const note = pendingNote(s.results);
  if (note) return `No channels match "${s.query}" · ${note}`;
  return `Nothing matches "${s.query}"`;
}

/** The line above the results: a subtle `Searching…` while a query runs over the shown results, else the count. */
export function countText(s: SearchState<SearchRow>): string {
  const n = selectableCount(s.results);
  if (n === 0) return '';
  if (s.busy) return 'Searching…';
  return `${n} ${n === 1 ? 'result' : 'results'}`;
}

export interface SearchMemory {
  query: string;
  focus: number;
  /** The next answer restores `focus` (set when Ok opened the Player or a detail screen). */
  returning: boolean;
  /** Back left Search: start fresh next time. */
  leaveBack(): void;
  /** Ok opened the Player or a detail screen: Back returns to the same results and row. */
  leaveTo(focus: number): void;
  /** The user handled a key in the results: their own position wins over a pending restore. */
  userNavigated(): void;
}

/** What Search remembers across visits (each push/pop re-creates the screen). */
export function createSearchMemory(): SearchMemory {
  const m: SearchMemory = {
    query: '',
    focus: 0,
    returning: false,
    leaveBack() { m.query = ''; m.focus = 0; m.returning = false; },
    leaveTo(focus) { m.focus = focus; m.returning = true; },
    userNavigated() { m.returning = false; },
  };
  return m;
}

/** The row to scroll to for `focus`: the section header right above it, so the header is not clipped when scrolling up. */
export function scrollAnchor(rows: readonly SearchRow[], focus: number): number {
  return rows[focus - 1]?.kind === 'header' ? focus - 1 : focus;
}

/** Window top for the focus: as `scrollTopFor`, but scrolling up reveals the section header above the focused row. */
export function listTop(rows: readonly SearchRow[], focus: number, top: number, viewRows: number): number {
  const anchor = scrollAnchor(rows, focus);
  return scrollTopFor(anchor < top ? anchor : focus, top, viewRows, rows.length);
}
