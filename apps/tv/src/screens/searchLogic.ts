import type { AppEvent, ChannelRow, ProgrammeHit, SearchResult, TitleHit } from '@iptv/app-api';
import { scrollTopFor } from '../components/virtualWindow.ts';

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

/** Events after which Search re-runs the open query: the title index became ready, or a guide import finished. */
export function rerunsSearch(e: AppEvent): boolean {
  return e.type === 'searchReady' || (e.type === 'refreshed' && e.what === 'epg');
}

/** One row of the flat result list; headers and notes are drawn but never take focus. */
export type SearchRow =
  | { kind: 'header'; label: string }
  | { kind: 'note'; label: string }
  | { kind: 'channel'; channel: ChannelRow }
  | { kind: 'onNow'; hit: ProgrammeHit }
  | { kind: 'later'; hit: TitleHit };

/** Sections in fixed order (Channels, On now, Coming up), each under a header; empty sections are left out. */
export function flattenResults(r: SearchResult): SearchRow[] {
  const out: SearchRow[] = [];
  if (r.channels.length) {
    out.push({ kind: 'header', label: 'Channels' });
    for (const channel of r.channels) out.push({ kind: 'channel', channel });
  }
  if (r.onNow.length) {
    out.push({ kind: 'header', label: 'On now' });
    for (const hit of r.onNow) out.push({ kind: 'onNow', hit });
  }
  if (r.later.length) {
    out.push({ kind: 'header', label: 'Coming up' });
    for (const hit of r.later) out.push({ kind: 'later', hit });
  }
  // Kept even when nothing is selectable, so `resultsMessage` can say the guide is still being prepared.
  if (r.guidePending) out.push({ kind: 'note', label: GUIDE_PENDING_NOTE });
  return out;
}

/** The rows the list draws: none when nothing is selectable (a lone note is shown by `resultsMessage` instead). */
export function listRows(rows: readonly SearchRow[]): readonly SearchRow[] {
  return selectableCount(rows) > 0 ? rows : [];
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
  if (s.query === '') return 'Type to search channels and programmes';
  if (selectableCount(s.results) > 0) return undefined;
  if (s.busy) return 'Searching…';
  if (s.failed) return "Couldn't search right now.";
  if (s.results.some((r) => r.kind === 'note' && r.label === GUIDE_PENDING_NOTE)) {
    return `No channels match "${s.query}" · ${GUIDE_PENDING_NOTE}`;
  }
  return `No channels or programmes match "${s.query}"`;
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
  /** The next answer restores `focus` (set when Ok opened the Player or Guide). */
  returning: boolean;
  /** Back left Search: start fresh next time. */
  leaveBack(): void;
  /** Ok opened the Player or the Guide: Back returns to the same results and row. */
  leaveTo(focus: number): void;
}

/** What Search remembers across visits (each push/pop re-creates the screen). */
export function createSearchMemory(): SearchMemory {
  const m: SearchMemory = {
    query: '',
    focus: 0,
    returning: false,
    leaveBack() { m.query = ''; m.focus = 0; m.returning = false; },
    leaveTo(focus) { m.focus = focus; m.returning = true; },
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
