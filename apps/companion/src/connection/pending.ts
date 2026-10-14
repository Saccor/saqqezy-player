import type { TvToPhone } from '@iptv/companion-protocol';

export type ResultMessage = Extract<TvToPhone, { t: 'result' }>;

/** A request that never got its `result`: it timed out, or the connection ended. */
export class RequestError extends Error {
  constructor(readonly reason: 'timeout' | 'closed') {
    super(reason === 'timeout' ? 'request timed out' : 'connection closed');
    this.name = 'RequestError';
  }
}

export const REQUEST_TIMEOUT_MS = 30_000;
/** A stalled idle request is forgotten (rejected as a timeout) this long after it stalled. */
export const STALLED_MAX_MS = 10 * 60_000;

/** An idle request: its timeout restarts on every `touch()`, and running out stalls it instead of failing it. */
export interface IdleOptions {
  /** Called once when the idle time runs out. The request keeps waiting for its result. */
  onStall: () => void;
}

interface Entry {
  resolve: (r: ResultMessage) => void;
  reject: (e: RequestError) => void;
  timer: ReturnType<typeof setTimeout>;
  timeoutMs: number;
  idle: IdleOptions | undefined;
  stalled: boolean;
}

/**
 * Requests waiting for the TV's `result`, keyed by the msgId they were sent with. Each one settles exactly once:
 * with its result (ok or not), with a timeout after REQUEST_TIMEOUT_MS, or rejected when the connection closes.
 *
 * Idle requests (long TV work such as loading a playlist) time out only after `timeoutMs` without any sign of
 * life (`touch()`, called for every message from the TV). Then they stall: `onStall` runs once and the request
 * keeps waiting for its result, up to STALLED_MAX_MS.
 */
export class PendingRequests {
  private readonly entries = new Map<number, Entry>();
  private closed = false;

  get size(): number {
    return this.entries.size;
  }

  add(msgId: number, timeoutMs = REQUEST_TIMEOUT_MS, idle?: IdleOptions): Promise<ResultMessage> {
    if (this.closed) return Promise.reject(new RequestError('closed'));
    this.cancel(msgId);
    return new Promise<ResultMessage>((resolve, reject) => {
      const e: Entry = { resolve, reject, timer: undefined as unknown as ReturnType<typeof setTimeout>, timeoutMs, idle, stalled: false };
      this.entries.set(msgId, e);
      this.arm(msgId, e);
    });
  }

  /** A sign of life from the TV: idle requests that have not stalled get their full idle time again. */
  touch(): void {
    for (const [msgId, e] of this.entries) {
      if (e.idle && !e.stalled) {
        clearTimeout(e.timer);
        this.arm(msgId, e);
      }
    }
  }

  private arm(msgId: number, e: Entry): void {
    e.timer = setTimeout(() => {
      if (e.idle && !e.stalled) {
        e.stalled = true;
        e.timer = setTimeout(() => this.expire(msgId, e), STALLED_MAX_MS);
        e.idle.onStall();
        return;
      }
      this.expire(msgId, e);
    }, e.timeoutMs);
  }

  private expire(msgId: number, e: Entry): void {
    if (this.entries.get(msgId) !== e) return;
    this.entries.delete(msgId);
    e.reject(new RequestError('timeout'));
  }

  /** Settles the request this result answers. False when nobody waits for it (late, or not a tracked request). */
  resolve(result: ResultMessage): boolean {
    const e = this.entries.get(result.requestMsgId);
    if (!e) return false;
    this.entries.delete(result.requestMsgId);
    clearTimeout(e.timer);
    e.resolve(result);
    return true;
  }

  /** Forgets a request without settling it (its answer came another way, e.g. a `source` message). */
  cancel(msgId: number): void {
    const e = this.entries.get(msgId);
    if (!e) return;
    clearTimeout(e.timer);
    this.entries.delete(msgId);
  }

  /** The connection ended: every waiting request is rejected, and so is every later one. */
  closeAll(): void {
    this.closed = true;
    const all = [...this.entries.values()];
    this.entries.clear();
    for (const e of all) {
      clearTimeout(e.timer);
      e.reject(new RequestError('closed'));
    }
  }
}
