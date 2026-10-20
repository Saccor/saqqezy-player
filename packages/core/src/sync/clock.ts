import type { Storage, SyncMetaEntry } from '../storage.ts';
import { decodeHlc, encodeHlc, isHlc, isNodeId, receiveHlc, tickHlc, type Hlc } from './hlc.ts';

/** `syncMeta` scope of the clock state: `node` (this device's node id) and `last` (the newest stamp handed out). */
export const CLOCK_SCOPE = '#clock';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** A random 6-character node id (about 31 bits; collisions only matter between one account's ≤ 10 devices). */
export function newNodeId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 36];
  return out;
}

export interface SyncClockDeps {
  storage: Storage;
  now?: () => number;
  /** Node id for a device that has none yet (default `newNodeId`). */
  nodeId?: () => string;
}

/**
 * The device's hybrid logical clock, persisted in `syncMeta` so stamps keep growing across restarts. Its state loads
 * lazily on the first stamp: nothing is read on cold start or while zapping. Stamps are handed out one at a time;
 * their storage writes are batched (`stamp`).
 */
export class SyncClock {
  private readonly storage: Storage;
  private readonly now: () => number;
  private readonly makeNode: () => string;
  private state: Promise<{ node: string; last?: Hlc }> | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly queue: { sourceId: string; keys: readonly string[]; resolve: (t: string | undefined) => void; reject: (e: unknown) => void }[] = [];
  private draining: Promise<void> | undefined;

  constructor(deps: SyncClockDeps) {
    this.storage = deps.storage;
    this.now = deps.now ?? Date.now;
    this.makeNode = deps.nodeId ?? newNodeId;
  }

  /**
   * One stamp for one user write: every key (a `clockKey`) of `sourceId` gets it. No keys: nothing happens. Resolves
   * to the stamp once it is stored.
   *
   * Writes are batched: stamps asked for while a write runs are handed out in call order (each its own stamp) and
   * stored together, with the clock state, in one storage write. A caller may therefore fire and forget: the order
   * of its calls is the order of the stamps (`idle()` waits for them).
   */
  stamp(sourceId: string, keys: readonly string[]): Promise<string | undefined> {
    if (!keys.length) return Promise.resolve(undefined);
    return new Promise<string | undefined>((resolve, reject) => {
      this.queue.push({ sourceId, keys, resolve, reject });
      this.kick();
    });
  }

  /** Resolves once every stamp asked for so far is stored (or failed). */
  async idle(): Promise<void> {
    while (this.draining || this.queue.length) {
      if (!this.draining) this.kick();
      await this.draining;
    }
    await this.chain;
  }

  /**
   * Stores stamps written elsewhere (a restore's winning records) as they are, in one write, and moves the clock past
   * the newest of them, so the next local write wins over what was adopted.
   */
  adopt(sourceId: string, stamps: readonly { key: string; t: string }[]): Promise<void> {
    const valid = stamps.filter((s) => isHlc(s.t));
    if (!valid.length) return Promise.resolve();
    return this.serial(async () => {
      const st = await this.load();
      let newest = valid[0]!.t;
      for (const s of valid) if (s.t > newest) newest = s.t;
      const next = receiveHlc(st.last, decodeHlc(newest)!, this.now(), st.node);
      const entries: SyncMetaEntry[] = valid.map((s) => ({ scope: sourceId, key: s.key, value: s.t }));
      entries.push({ scope: CLOCK_SCOPE, key: 'last', value: encodeHlc(next) });
      await this.storage.putSyncMeta(entries);
      st.last = next;
    });
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = this.drain();
  }

  /** Stores queued stamps batch by batch; a stamp asked for while it was finishing starts the next drain. */
  private async drain(): Promise<void> {
    try {
      await this.drainLoop();
    } finally {
      this.draining = undefined;
      if (this.queue.length) this.kick();
    }
  }

  private async drainLoop(): Promise<void> {
    while (this.queue.length) {
      const batch = this.queue.splice(0);
      try {
        const stamps = await this.serial(async () => {
          const st = await this.load();
          const now = this.now();
          const out: string[] = [];
          const entries = new Map<string, SyncMetaEntry>();
          let last = st.last;
          for (const req of batch) {
            last = tickHlc(last, now, st.node);
            const t = encodeHlc(last);
            out.push(t);
            // A key written by several queued writes keeps the newest stamp (Map order: last set wins).
            for (const key of req.keys) entries.set(`${req.sourceId}
${key}`, { scope: req.sourceId, key, value: t });
          }
          entries.set('#last', { scope: CLOCK_SCOPE, key: 'last', value: out[out.length - 1]! });
          await this.storage.putSyncMeta([...entries.values()]);
          st.last = last;
          return out;
        });
        batch.forEach((req, i) => req.resolve(stamps[i]));
      } catch (err) {
        for (const req of batch) req.reject(err);
      }
    }
  }

  /** Moves the clock past a remote stamp (clamped to local + 24 h), so the next local stamp wins over it. */
  receive(remote: string): Promise<void> {
    const r = decodeHlc(remote);
    if (!r) return Promise.resolve();
    return this.serial(async () => {
      const st = await this.load();
      const next = receiveHlc(st.last, r, this.now(), st.node);
      await this.storage.putSyncMeta([{ scope: CLOCK_SCOPE, key: 'last', value: encodeHlc(next) }]);
      st.last = next;
    });
  }

  /** The stamps of `sourceId`'s user state, by clock key. */
  async clocks(sourceId: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const e of await this.storage.listSyncMeta(sourceId)) if (isHlc(e.value)) out.set(e.key, e.value);
    return out;
  }

  private load(): Promise<{ node: string; last?: Hlc }> {
    if (!this.state) {
      const p = (async () => {
        const [node, last] = await Promise.all([this.storage.getSyncMeta(CLOCK_SCOPE, 'node'), this.storage.getSyncMeta(CLOCK_SCOPE, 'last')]);
        if (isNodeId(node)) return { node, last: typeof last === 'string' ? decodeHlc(last) : undefined };
        const fresh = this.makeNode();
        await this.storage.putSyncMeta([{ scope: CLOCK_SCOPE, key: 'node', value: fresh }]);
        return { node: fresh };
      })();
      this.state = p;
      // A failed read is retried on the next stamp.
      p.catch(() => { if (this.state === p) this.state = undefined; });
    }
    return this.state;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}
