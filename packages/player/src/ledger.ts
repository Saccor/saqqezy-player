/**
 * Stream sessions per source and host, shared by every supervisor (multiview tiles). It never refuses a session: it
 * says how many were open when one began, so a refusal can be scoped to its tile, and keeps the peak for diagnostics.
 * A session counts from `begin` until `closed()`, or until `closingGraceMs` after `closing()` (a hung teardown).
 * Holds source ids and hosts in memory only; never URLs.
 */
export interface LedgerSession {
  /** The stream showed its first frame. */
  playing(): void;
  /** The attempt ended; the engine is tearing its connection down. */
  closing(): void;
  /** The engine's connection is gone. */
  closed(): void;
}

interface Entry { key: string; host: string; tile: number; closingAt?: number; closed: boolean }

/** The stream URL's host and port; '' when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

const CLOSING_GRACE_MS = 1500;

export class ConnectionLedger {
  private readonly now: () => number;
  private readonly graceMs: number;
  private entries: Entry[] = [];
  private readonly peak = new Map<string, number>();

  constructor(opts: { now?: () => number; closingGraceMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.graceMs = opts.closingGraceMs ?? CLOSING_GRACE_MS;
  }

  begin(key: string, url: string, tile: number): { session: LedgerSession; concurrent: number } {
    const host = hostOf(url);
    const concurrent = this.concurrent(key, host);
    const e: Entry = { key, host, tile, closed: false };
    this.entries.push(e);
    this.peak.set(key, Math.max(this.peak.get(key) ?? 0, this.concurrent(key)));
    return {
      concurrent,
      session: {
        playing: () => {},
        closing: () => { e.closingAt ??= this.now(); },
        closed: () => {
          e.closed = true;
          this.prune();
        },
      },
    };
  }

  /** Sessions of `key` that count now (on `host` when given). */
  concurrent(key: string, host?: string): number {
    this.prune();
    return this.entries.filter((e) => e.key === key && (host === undefined || e.host === host)).length;
  }

  maxSeen(key: string): number {
    return this.peak.get(key) ?? 0;
  }

  private prune(): void {
    const t = this.now();
    this.entries = this.entries.filter((e) => !e.closed && (e.closingAt === undefined || t - e.closingAt < this.graceMs));
  }
}
