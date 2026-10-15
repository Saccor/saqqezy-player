import { SourceRefusedError } from '../errors.ts';
import type { Storage } from '../storage.ts';
import type { FetchFn } from '../types.ts';

/**
 * HTTP statuses that mean "the source refuses us". 458 and 509 are limit statuses some panels use. Asking again
 * while refused is what turns a refusal into an IP ban (docs/research/source-friendliness-2026-10.md).
 */
export const REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 429, 458, 503, 509]);

/** The cooldown ladder: the first refusal waits 2 min, the second 10 min, the third waits for a manual retry. */
export const COOLDOWN_STEPS_MS: readonly number[] = [2 * 60_000, 10 * 60_000];
const MANUAL_STEP = COOLDOWN_STEPS_MS.length + 1;

/** What the UI shows for a source. `clear` also covers "a wait ended and the next request is a probe". */
export type SourceCooldown = { state: 'clear' } | { state: 'waiting'; until: number } | { state: 'manual' };

/** Stored as `refusal:{key}`. `until` null: blocked until a manual retry. */
interface RefusalRecord { step: number; until: number | null }

export interface RefusalGuardDeps {
  storage: Pick<Storage, 'getMeta' | 'setMeta'>;
  now?: () => number;
  timer?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/**
 * Why the cooldown of a source changed: a refusal, an answer that cleared the record (a probe got through), a manual
 * retry, the end of a wait, or the source was forgotten. Only `expired` and `answered` say "talk to the source again".
 */
export type CooldownCause = 'refused' | 'answered' | 'retry' | 'expired' | 'forget';
export type CooldownListener = (key: string, cooldown: SourceCooldown, cause: CooldownCause) => void;

const metaKey = (key: string) => `refusal:${key}`;

function isRecord(v: unknown): v is RefusalRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<RefusalRecord>;
  return typeof r.step === 'number' && r.step >= 1 && (r.until === null || typeof r.until === 'number');
}

/**
 * Per-source refusal cooldown (keyed by source id). After a refusal nothing is sent to the source until the wait on
 * the ladder ends; then exactly one request (the probe) may run until it answers. A refused probe moves one step up,
 * any other answer clears the record. Refusals that land while the source is already blocked (requests that were in
 * flight) are not counted again. Records are persisted, so a reload keeps waiting instead of firing a new burst.
 */
export class RefusalGuard {
  private readonly storage: RefusalGuardDeps['storage'];
  private readonly now: () => number;
  private readonly timer: NonNullable<RefusalGuardDeps['timer']>;
  private readonly records = new Map<string, RefusalRecord>();
  private readonly loads = new Map<string, Promise<void>>();
  private readonly probing = new Set<string>();
  private readonly timers = new Map<string, unknown>();
  private readonly listeners = new Set<CooldownListener>();

  constructor(deps: RefusalGuardDeps) {
    this.storage = deps.storage;
    this.now = deps.now ?? Date.now;
    this.timer = deps.timer ?? {
      set: (fn, ms) => {
        const h = globalThis.setTimeout(fn, ms);
        (h as { unref?: () => void }).unref?.(); // Node (tests): a pending wait must not keep the process alive
        return h;
      },
      clear: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
    };
  }

  async status(key: string): Promise<SourceCooldown> {
    await this.load(key);
    return this.statusNow(key);
  }

  /** From the loaded record only (a key not loaded yet reads as clear). */
  statusNow(key: string): SourceCooldown {
    const rec = this.records.get(key);
    if (!rec || !this.blocks(rec)) return { state: 'clear' };
    return rec.until === null ? { state: 'manual' } : { state: 'waiting', until: rec.until };
  }

  isBlocked(key: string): boolean {
    return this.statusNow(key).state !== 'clear';
  }

  /** Records how the source answered a request made outside `wrap` (a stream open). */
  async report(key: string, outcome: 'refused' | 'answered'): Promise<void> {
    await this.load(key);
    const rec = this.records.get(key);
    // Answers and refusals that land while blocked come from requests sent before the block: neither one counts.
    // (A rate limit may refuse one request and answer its sibling; the answer must not wipe the refusal.)
    if (rec && this.blocks(rec)) return;
    if (outcome === 'answered') {
      if (rec) await this.set(key, undefined, 'answered');
      return;
    }
    const step = Math.min((rec?.step ?? 0) + 1, MANUAL_STEP);
    const wait = COOLDOWN_STEPS_MS[step - 1];
    await this.set(key, { step, until: wait === undefined ? null : this.now() + wait }, 'refused');
  }

  /** The user asked to try again: one probe may go out now. The step is kept, so a refused retry moves up. */
  async retry(key: string): Promise<void> {
    await this.load(key);
    const rec = this.records.get(key);
    if (rec && this.blocks(rec)) await this.set(key, { step: rec.step, until: this.now() }, 'retry');
  }

  /** The source is gone: drop its record. */
  async forget(key: string): Promise<void> {
    await this.load(key);
    this.probing.delete(key);
    await this.set(key, undefined, this.records.has(key) ? 'forget' : undefined);
  }

  onChange(fn: CooldownListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** `fetchFn` behind the guard for source `key`: throws `SourceRefusedError` without sending while blocked. */
  wrap(key: string, fetchFn: FetchFn): FetchFn {
    return async (url, init) => {
      await this.load(key);
      const rec = this.records.get(key);
      if (rec && this.blocks(rec)) throw new SourceRefusedError();
      const probe = rec !== undefined;
      if (probe) {
        if (this.probing.has(key)) throw new SourceRefusedError();
        this.probing.add(key);
      }
      try {
        const res = await fetchFn(url, init);
        await this.report(key, REFUSAL_STATUSES.has(res.status) ? 'refused' : 'answered');
        return res;
      } finally {
        if (probe) this.probing.delete(key);
      }
    };
  }

  private blocks(rec: RefusalRecord): boolean {
    return rec.until === null || this.now() < rec.until;
  }

  private load(key: string): Promise<void> {
    let p = this.loads.get(key);
    if (!p) {
      p = this.storage.getMeta<unknown>(metaKey(key)).then((v) => {
        if (isRecord(v) && !this.records.has(key)) {
          this.records.set(key, v);
          this.schedule(key);
        }
      }, () => { /* unreadable: treat as no record */ });
      this.loads.set(key, p);
    }
    return p;
  }

  /** `cause` undefined: no event. */
  private async set(key: string, rec: RefusalRecord | undefined, cause: CooldownCause | undefined): Promise<void> {
    if (rec) this.records.set(key, rec);
    else this.records.delete(key);
    this.schedule(key);
    if (cause) this.announce(key, cause);
    try {
      await this.storage.setMeta(metaKey(key), rec ?? null);
    } catch {
      // Kept in memory for this session; a failed write must not fail the request.
    }
  }

  /** Arms the end-of-wait event for `key` (and drops an older one). */
  private schedule(key: string): void {
    const old = this.timers.get(key);
    if (old !== undefined) this.timer.clear(old);
    this.timers.delete(key);
    const until = this.records.get(key)?.until;
    if (until === null || until === undefined) return;
    const ms = until - this.now();
    if (ms <= 0) return;
    this.timers.set(key, this.timer.set(() => {
      this.timers.delete(key);
      // The wall clock may have moved back since the timer was armed: still waiting means wait again.
      if (this.isBlocked(key)) this.schedule(key);
      else this.announce(key, 'expired');
    }, ms));
  }

  private announce(key: string, cause: CooldownCause): void {
    const c = this.statusNow(key);
    for (const fn of this.listeners) {
      try {
        fn(key, c, cause);
      } catch {
        // A listener must not break the guard.
      }
    }
  }
}
