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

interface Entry {
  resolve: (r: ResultMessage) => void;
  reject: (e: RequestError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Requests waiting for the TV's `result`, keyed by the msgId they were sent with. Each one settles exactly once:
 * with its result (ok or not), with a timeout after REQUEST_TIMEOUT_MS, or rejected when the connection closes.
 */
export class PendingRequests {
  private readonly entries = new Map<number, Entry>();
  private closed = false;

  get size(): number {
    return this.entries.size;
  }

  add(msgId: number, timeoutMs = REQUEST_TIMEOUT_MS): Promise<ResultMessage> {
    if (this.closed) return Promise.reject(new RequestError('closed'));
    this.cancel(msgId);
    return new Promise<ResultMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.entries.delete(msgId);
        reject(new RequestError('timeout'));
      }, timeoutMs);
      this.entries.set(msgId, { resolve, reject, timer });
    });
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
