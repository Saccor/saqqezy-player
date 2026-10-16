import { SourceRefusedError } from '../errors.ts';
import type { Storage } from '../storage.ts';
import type { FetchFn } from '../types.ts';
import { parseRetryAfter } from './retryAfter.ts';

/**
 * HTTP statuses that mean "the source refuses us". 458 and 509 are limit statuses some panels use. Asking again
 * while refused is what turns a refusal into an IP ban (docs/research/source-friendliness-2026-10.md).
 */
export const REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 429, 458, 503, 509]);

/** The cooldown ladder: the first refusal waits 2 min, the second 10 min, the third waits for a manual retry. */
export const COOLDOWN_STEPS_MS: readonly number[] = [2 * 60_000, 10 * 60_000];
const MANUAL_STEP = COOLDOWN_STEPS_MS.length + 1;

/** A refusal's `Retry-After` replaces the step's wait, clamped to this range. */
export const RETRY_AFTER_MIN_MS = 30_000;
export const RETRY_AFTER_MAX_MS = 60 * 60_000;

/** The unreachable breaker: this many failures in a row within the window trip it. */
export const UNREACHABLE_FAILS = 3;
export const UNREACHABLE_WINDOW_MS = 5 * 60_000;
/** Its ladder: 1 min, 5 min, then 15 min for every further failed probe. A trip whose wait ended more than
 * `UNREACHABLE_WINDOW_MS` ago has decayed: the next failure starts a new run instead of moving up. */
export const UNREACHABLE_STEPS_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];

/**
 * What the UI shows for a source. `clear` also covers "a wait ended and the next request is a probe". `reason` says
 * which ladder blocks: the source refused us, or it did not answer at all.
 */
export type SourceCooldown =
  | { state: 'clear' }
  | { state: 'waiting'; until: number; reason: 'refused' | 'unreachable' }
  | { state: 'manual'; reason: 'refused' };

/** Stored as `refusal:{key}`. `until` null: blocked until a manual retry. */
interface RefusalRecord { step: number; until: number | null }

/**
 * Stored as `unreachable:{key}`. `step` 0: a run of failures is being counted (`fails` since `windowStart`) and
 * nothing is blocked; from 1 the breaker tripped and blocks until `until`.
 */
interface UnreachableRecord { step: number; until: number; fails: number; windowStart: number }

export interface RefusalGuardDeps {
  storage: Pick<Storage, 'getMeta' | 'setMeta'>;
  now?: () => number;
  timer?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/**
 * Why the cooldown of a source changed: a refusal, the breaker tripped (the source did not answer), an answer that
 * cleared the record (a probe got through), a manual retry, the end of a wait, or the source was forgotten. Only
 * `expired` and `answered` say "talk to the source again".
 */
export type CooldownCause = 'refused' | 'unreachable' | 'answered' | 'retry' | 'expired' | 'forget';
export type CooldownListener = (key: string, cooldown: SourceCooldown, cause: CooldownCause) => void;

const metaKey = (key: string) => `refusal:${key}`;
const unreachableKey = (key: string) => `unreachable:${key}`;

function isRecord(v: unknown): v is RefusalRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<RefusalRecord>;
  return typeof r.step === 'number' && r.step >= 1 && (r.until === null || typeof r.until === 'number');
}

function isUnreachableRecord(v: unknown): v is UnreachableRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<UnreachableRecord>;
  return typeof r.step === 'number' && r.step >= 0 && typeof r.until === 'number'
    && typeof r.fails === 'number' && typeof r.windowStart === 'number';
}

/** The caller cancelled the request itself: not something the source did. */
function isUserCancel(err: unknown, signal: AbortSignal | null | undefined): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError' && signal?.aborted === true;
}

/** Which records a `commit` changes: a missing field is kept, `null` drops the record. */
interface Patch { refusal?: RefusalRecord | null; unreachable?: UnreachableRecord | null }

/**
 * Per-source cooldown (keyed by source id) with two ladders.
 * - **Refused:** after a refusal nothing is sent to the source until the wait on the ladder ends (a `Retry-After`
 *   replaces the step's wait). A refused probe moves one step up, any other answer clears the record.
 * - **Unreachable:** 3 failures in a row within 5 min (a 5xx other than 503, a timeout or a network error, or a
 *   stream that never played) trip a breaker that blocks for 1, 5, then 15 min. A failed probe moves one step up;
 *   the first answer clears it. A refusal replaces it with the refusal ladder.
 * After either wait exactly one request (the probe) may run until it answers. Outcomes that land while the source is
 * already blocked (requests that were in flight) are not counted again. Records are persisted, so a reload keeps
 * waiting instead of firing a new burst.
 */
export class RefusalGuard {
  private readonly storage: RefusalGuardDeps['storage'];
  private readonly now: () => number;
  private readonly timer: NonNullable<RefusalGuardDeps['timer']>;
  private readonly records = new Map<string, RefusalRecord>();
  private readonly unreachable = new Map<string, UnreachableRecord>();
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

  /** From the loaded records only (a key not loaded yet reads as clear). */
  statusNow(key: string): SourceCooldown {
    const rec = this.records.get(key);
    if (rec && this.blocks(rec)) {
      return rec.until === null
        ? { state: 'manual', reason: 'refused' }
        : { state: 'waiting', until: rec.until, reason: 'refused' };
    }
    const unr = this.unreachable.get(key);
    if (unr && this.unreachableBlocks(unr)) return { state: 'waiting', until: unr.until, reason: 'unreachable' };
    return { state: 'clear' };
  }

  isBlocked(key: string): boolean {
    return this.statusNow(key).state !== 'clear';
  }

  /**
   * Records how the source answered a request made outside `wrap` (a stream open). `failed`: it did not answer at
   * all. `retryAfterMs` (a refusal's `Retry-After`) replaces this step's wait, clamped to 30 s … 60 min.
   */
  async report(key: string, outcome: 'refused' | 'answered' | 'failed', opts?: { retryAfterMs?: number }): Promise<void> {
    await this.load(key);
    const rec = this.records.get(key);
    // Outcomes that land while refused come from requests sent before the block: none of them counts.
    // (A rate limit may refuse one request and answer its sibling; the answer must not wipe the refusal.)
    if (rec && this.blocks(rec)) return;
    const unr = this.unreachable.get(key);
    if (outcome === 'answered') {
      if (!rec && !unr) return;
      // A run of failures that never tripped changes nothing the UI shows: dropped quietly.
      const shown = rec !== undefined || (unr !== undefined && this.tripped(unr));
      await this.commit(
        key,
        { refusal: rec ? null : undefined, unreachable: unr ? null : undefined },
        shown ? 'answered' : undefined,
      );
      return;
    }
    if (outcome === 'failed') {
      await this.failed(key, unr);
      return;
    }
    const step = Math.min((rec?.step ?? 0) + 1, MANUAL_STEP);
    const retryAfter = opts?.retryAfterMs;
    const wait = retryAfter !== undefined
      ? Math.min(Math.max(retryAfter, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS)
      : COOLDOWN_STEPS_MS[step - 1];
    await this.commit(
      key,
      { refusal: { step, until: wait === undefined ? null : this.now() + wait }, unreachable: unr ? null : undefined },
      'refused',
    );
  }

  /** The user asked to try again: one probe may go out now. The step is kept, so a refused or failed retry moves up. */
  async retry(key: string): Promise<void> {
    await this.load(key);
    const rec = this.records.get(key);
    if (rec && this.blocks(rec)) {
      await this.commit(key, { refusal: { step: rec.step, until: this.now() } }, 'retry');
      return;
    }
    const unr = this.unreachable.get(key);
    if (unr && this.unreachableBlocks(unr)) {
      await this.commit(key, { unreachable: { ...unr, until: this.now() } }, 'retry');
    }
  }

  /** The source is gone: drop its records. */
  async forget(key: string): Promise<void> {
    await this.load(key);
    this.probing.delete(key);
    const had = this.records.has(key) || this.unreachable.has(key);
    await this.commit(key, { refusal: null, unreachable: null }, had ? 'forget' : undefined);
  }

  onChange(fn: CooldownListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * `fetchFn` behind the guard for source `key`: throws `SourceRefusedError` without sending while blocked. A refusal
   * status is a refusal (with its `Retry-After`); another 5xx, or a thrown fetch that is not the caller's own cancel,
   * is a failure (and rethrown); anything else is an answer.
   */
  wrap(key: string, fetchFn: FetchFn): FetchFn {
    return async (url, init) => {
      await this.load(key);
      const blocked = this.statusNow(key);
      if (blocked.state !== 'clear') throw new SourceRefusedError(blocked.reason);
      const unr = this.unreachable.get(key);
      const refusalProbe = this.records.has(key);
      const probe = refusalProbe || (unr !== undefined && this.tripped(unr));
      if (probe) {
        if (this.probing.has(key)) throw new SourceRefusedError(refusalProbe ? 'refused' : 'unreachable');
        this.probing.add(key);
      }
      try {
        let res: Response;
        try {
          res = await fetchFn(url, init);
        } catch (err) {
          if (!isUserCancel(err, init?.signal)) await this.report(key, 'failed');
          throw err;
        }
        if (REFUSAL_STATUSES.has(res.status)) {
          const retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'), this.now());
          await this.report(key, 'refused', { retryAfterMs });
        } else {
          await this.report(key, res.status >= 500 ? 'failed' : 'answered');
        }
        return res;
      } finally {
        if (probe) this.probing.delete(key);
      }
    };
  }

  /** A failure: counts toward the breaker, or moves a tripped one up a step when its probe failed. */
  private async failed(key: string, unr: UnreachableRecord | undefined): Promise<void> {
    if (unr && this.unreachableBlocks(unr)) return;
    const now = this.now();
    if (unr && this.tripped(unr)) {
      await this.trip(key, Math.min(unr.step + 1, UNREACHABLE_STEPS_MS.length), now);
      return;
    }
    // A decayed trip counts as no run at all.
    const inRun = unr !== undefined && unr.step === 0 && now - unr.windowStart < UNREACHABLE_WINDOW_MS;
    const fails = inRun ? unr.fails + 1 : 1;
    if (fails >= UNREACHABLE_FAILS) {
      await this.trip(key, 1, now);
      return;
    }
    await this.commit(key, { unreachable: { step: 0, until: 0, fails, windowStart: inRun ? unr.windowStart : now } }, undefined);
  }

  private trip(key: string, step: number, now: number): Promise<void> {
    const until = now + UNREACHABLE_STEPS_MS[step - 1]!;
    return this.commit(key, { unreachable: { step, until, fails: 0, windowStart: now } }, 'unreachable');
  }

  private blocks(rec: RefusalRecord): boolean {
    return rec.until === null || this.now() < rec.until;
  }

  private unreachableBlocks(rec: UnreachableRecord): boolean {
    return rec.step >= 1 && this.now() < rec.until;
  }

  /** The breaker tripped and has not decayed: a failure moves it up, and requests go out one probe at a time. */
  private tripped(rec: UnreachableRecord): boolean {
    return rec.step >= 1 && this.now() - rec.until <= UNREACHABLE_WINDOW_MS;
  }

  private load(key: string): Promise<void> {
    let p = this.loads.get(key);
    if (!p) {
      const read = (k: string) => this.storage.getMeta<unknown>(k).catch(() => undefined); // unreadable: no record
      p = Promise.all([read(metaKey(key)), read(unreachableKey(key))]).then(([r, u]) => {
        if (isRecord(r) && !this.records.has(key)) this.records.set(key, r);
        if (isUnreachableRecord(u) && !this.unreachable.has(key)) this.unreachable.set(key, u);
        this.schedule(key);
      });
      this.loads.set(key, p);
    }
    return p;
  }

  /** `cause` undefined: no event. */
  private async commit(key: string, patch: Patch, cause: CooldownCause | undefined): Promise<void> {
    const writes: Promise<void>[] = [];
    if (patch.refusal !== undefined) {
      if (patch.refusal) this.records.set(key, patch.refusal);
      else this.records.delete(key);
      writes.push(this.storage.setMeta(metaKey(key), patch.refusal));
    }
    if (patch.unreachable !== undefined) {
      if (patch.unreachable) this.unreachable.set(key, patch.unreachable);
      else this.unreachable.delete(key);
      writes.push(this.storage.setMeta(unreachableKey(key), patch.unreachable));
    }
    this.schedule(key);
    if (cause) this.announce(key, cause);
    // Kept in memory for this session; a failed write must not fail the request.
    await Promise.allSettled(writes);
  }

  /** Arms the end-of-wait event for `key` (and drops an older one). */
  private schedule(key: string): void {
    const old = this.timers.get(key);
    if (old !== undefined) this.timer.clear(old);
    this.timers.delete(key);
    const rec = this.records.get(key);
    const unr = this.unreachable.get(key);
    const until = Math.max(rec?.until ?? 0, unr && unr.step >= 1 ? unr.until : 0);
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
