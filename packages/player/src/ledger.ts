/**
 * Stream sessions per source and host, shared by every supervisor (multiview windows). It never refuses a session: it
 * says how many were open when one began, so a refusal can be scoped to its window, keeps the peak for diagnostics,
 * and reports begins, first frames and drops so a source that cuts the oldest stream can be noticed.
 * A session counts from `begin` until `closed()`, or until `closingGraceMs` after `closing()` or `dropped()` (a hung
 * teardown). Holds source ids and hosts in memory only; never URLs.
 */
export interface LedgerSession {
  /** The stream showed its first frame. */
  playing(): void;
  /** The stream ended by itself or failed (`code`: the error code, e.g. EOS, NETWORK, AUTH); it is closing. */
  dropped(code: string): void;
  /** The attempt ended; the engine is tearing its connection down. */
  closing(): void;
  /** The engine's connection is gone. */
  closed(): void;
}

/**
 * `tile`: the label the session began under (the supervisor's pool slot). `session`: the session's own number, 1 up
 * per ledger, so a label reused by a later stream (a zap, a reconnect) can be told apart.
 */
export type LedgerEvent =
  | { k: 'begin'; key: string; host: string; tile: number; at: number; session: number }
  | { k: 'playing'; key: string; host: string; tile: number; at: number; session: number }
  /** `playedMs`: how long the stream had played before it dropped (0 when it never showed a frame). */
  | { k: 'dropped'; key: string; host: string; tile: number; at: number; code: string; playedMs: number; session: number };

export interface LedgerRow {
  tile: number;
  host: string;
  since: number;
  playingSince?: number;
  closing: boolean;
}

interface Entry { key: string; host: string; tile: number; since: number; playingSince?: number; closingAt?: number; closed: boolean }

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
  private readonly listeners = new Set<(e: LedgerEvent) => void>();
  private serial = 0;

  constructor(opts: { now?: () => number; closingGraceMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.graceMs = opts.closingGraceMs ?? CLOSING_GRACE_MS;
  }

  begin(key: string, url: string, tile: number): { session: LedgerSession; concurrent: number } {
    const host = hostOf(url);
    const concurrent = this.concurrent(key, host);
    const e: Entry = { key, host, tile, since: this.now(), closed: false };
    const session = ++this.serial;
    this.entries.push(e);
    this.peak.set(key, Math.max(this.peak.get(key) ?? 0, this.concurrent(key)));
    this.emit({ k: 'begin', key, host, tile, at: e.since, session });
    const closing = () => { e.closingAt ??= this.now(); };
    return {
      concurrent,
      session: {
        playing: () => {
          if (e.playingSince !== undefined) return;
          e.playingSince = this.now();
          this.emit({ k: 'playing', key, host, tile, at: e.playingSince, session });
        },
        dropped: (code) => {
          const at = this.now();
          closing();
          this.emit({ k: 'dropped', key, host, tile, at, code, playedMs: e.playingSince === undefined ? 0 : at - e.playingSince, session });
        },
        closing,
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

  /** Diagnostics: the counted sessions of `key`, oldest first. Numbers and hosts only. */
  snapshot(key: string): LedgerRow[] {
    this.prune();
    return this.entries.filter((e) => e.key === key).map((e) => {
      const row: LedgerRow = { tile: e.tile, host: e.host, since: e.since, closing: e.closingAt !== undefined };
      if (e.playingSince !== undefined) row.playingSince = e.playingSince;
      return row;
    });
  }

  onEvent(fn: (e: LedgerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: LedgerEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch {
        // diagnostics only
      }
    }
  }

  private prune(): void {
    const t = this.now();
    this.entries = this.entries.filter((e) => !e.closed && (e.closingAt === undefined || t - e.closingAt < this.graceMs));
  }
}
