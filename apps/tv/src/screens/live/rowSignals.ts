import type { EpgChange } from '../epgCache.ts';

export type NumberSignal = [read: () => number, write: (v: number) => void];

export interface RowSignals {
  /** Read by everything that draws row `index`: re-runs when that row's page, or the whole list, changes. */
  track(index: number): void;
  /** Read by what depends on the row count. */
  trackAll(): void;
  /** Bumps the signals a cache change touches. Never reads a signal. */
  apply(change: EpgChange): void;
}

interface Slot { read: () => number; write: (v: number) => void; n: number }

/**
 * Per-page change signals for the guide rows (spec 2026-10-26 §0.3). Before, every page that landed bumped one global
 * `version()`, so all ~15 rows on screen rebuilt their blocks. Now a landing page re-runs only its own rows. Page
 * signals are made on first read; a page nothing reads gets no signal.
 */
export function createRowSignals(rowsPerPage: number, makeSignal: (initial: number) => NumberSignal): RowSignals {
  const slot = (): Slot => {
    const [read, write] = makeSignal(0);
    return { read, write, n: 0 };
  };
  const all = slot();
  const pages = new Map<number, Slot>();
  const bump = (s: Slot) => { s.n += 1; s.write(s.n); };
  return {
    track(index) {
      all.read();
      const p = Math.floor(index / rowsPerPage);
      let s = pages.get(p);
      if (!s) { s = slot(); pages.set(p, s); }
      s.read();
    },
    trackAll() { all.read(); },
    apply(change) {
      if (change.all || change.totalChanged) bump(all);
      if (change.all) return;
      for (const p of change.pages) {
        const s = pages.get(p);
        if (s) bump(s);
      }
    },
  };
}
