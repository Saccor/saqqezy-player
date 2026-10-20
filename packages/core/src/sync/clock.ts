import type { Storage } from '../storage.ts';
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
 * lazily on the first stamp: nothing is read on cold start or while zapping. Stamps are handed out one at a time.
 */
export class SyncClock {
  private readonly storage: Storage;
  private readonly now: () => number;
  private readonly makeNode: () => string;
  private state: Promise<{ node: string; last?: Hlc }> | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: SyncClockDeps) {
    this.storage = deps.storage;
    this.now = deps.now ?? Date.now;
    this.makeNode = deps.nodeId ?? newNodeId;
  }

  /**
   * One stamp for one user write: every key (a `clockKey`) of `sourceId` gets it, in one storage write with the clock
   * state. No keys: nothing happens. Returns the stamp.
   */
  stamp(sourceId: string, keys: readonly string[]): Promise<string | undefined> {
    if (!keys.length) return Promise.resolve(undefined);
    return this.serial(async () => {
      const st = await this.load();
      const next = tickHlc(st.last, this.now(), st.node);
      const t = encodeHlc(next);
      const entries = [...new Set(keys)].map((key) => ({ scope: sourceId, key, value: t }));
      entries.push({ scope: CLOCK_SCOPE, key: 'last', value: t });
      await this.storage.putSyncMeta(entries);
      st.last = next;
      return t;
    });
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
