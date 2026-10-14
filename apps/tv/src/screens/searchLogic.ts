/** Debounced search with a stale-result guard (pure: timers and the search call are injected). */

export const SEARCH_DEBOUNCE_MS = 150;
export const SEARCH_LIMIT = 50;

export interface SearchState<T> {
  /** The query the results belong to (trimmed). */
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

  const emit = (s: SearchState<T>) => { if (!disposed) onState(s); };

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
      emit({ query: q, results: [], busy: true, failed: false });
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

/** Text for the empty/placeholder area of the results (undefined when there are results). */
export function resultsMessage(s: SearchState<unknown>): string | undefined {
  if (s.query === '') return 'Type to search channels';
  if (s.results.length > 0) return undefined;
  if (s.busy) return 'Searching…';
  if (s.failed) return "Couldn't search right now.";
  return `No channels match "${s.query}"`;
}
