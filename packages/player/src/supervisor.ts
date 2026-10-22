import type { JournalEvent, JournalInput, JournalSink, ReconnectCause } from './journal.ts';
import type { ConnectionLedger, LedgerSession } from './ledger.ts';
import { LiveDelayController } from './liveDelay.ts';
import { DEFAULT_BUDGET, ReconnectBudget, type BudgetRule } from './reconnectBudget.ts';
import { DEFAULT_POLICY, decide, newWatch, observe, type RecoveryPolicy, type WatchState } from './recovery.ts';
import type {
  ErrorCode, LatencySource, LivePreset, PlaybackHealth, Player, PlayerState, StateDetail, StreamHeaders,
} from './types.ts';

/** Learned raise above the preset target, per source (opaque id; never a URL). */
export interface LiveTargetStore {
  get(sourceKey: string): number | undefined;
  set(sourceKey: string, raiseS: number): void;
}

export interface SupervisorOptions {
  policy?: Partial<RecoveryPolicy>;
  budget?: readonly BudgetRule[];
  preset?: () => LivePreset;
  allowRate?: boolean;
  liveTargets?: LiveTargetStore;
  journal?: JournalSink;
  /**
   * Per-source open limit across play() calls and reloads (`SourceOpenRate`). Only automatic opens count: reconnects,
   * alternates, give-up retries and status probes. An automatic open that does not fit waits for room. A user's
   * play() is paced only by close-before-open (and the gap for what follows); only opens with a `sourceKey` count.
   */
  openRate?: { waitMs(sourceKey: string): number; take(sourceKey: string): void };
  /**
   * The gap between opens shared by every supervisor on a source (`SharedOpenGap`, multiview tiles). Opens and status
   * probes wait for the gap after another supervisor's latest open on the same `sourceKey`, and mark their own.
   */
  openGap?: { waitMs(sourceKey: string, owner: number): number; mark(sourceKey: string, owner: number, gapMs: number): void };
  /**
   * Stream sessions per source and host, shared by every supervisor (`ConnectionLedger`). Each attempt with a
   * `sourceKey` begins a session; a refusal then says how many other sessions of its host were open (`concurrent`).
   */
  ledger?: Pick<ConnectionLedger, 'begin'>;
  /** The multiview slot this supervisor drives (absent: slot 0, the single-view player); put on every journal event. */
  tile?: number | (() => number | undefined);
  /**
   * What a refusal does. `retry` (default): one immediate AUTH reconnect, then the other format, as for single view.
   * `stop` (multiview tiles): the play ends as `failed/refused` at once, from the engine or the status probe: no
   * reconnect, no alternate, no give-up retries. A refused tile is never retried by itself.
   */
  onRefusal?: 'retry' | 'stop' | (() => 'retry' | 'stop');
  /**
   * Asks the source for a stream's HTTP status (one `GET` with `Range: bytes=0-0`, aborted once the headers arrive).
   * Used when an engine that cannot see statuses (`Player.supportsStatus` false or absent) fails before its first
   * frame with a NETWORK error: at most once per `play()`, only after the failed attempt has closed, counted against
   * `openRate`, and never while `blocked`. Resolves `{}` when the status is unknown; never logs the URL.
   */
  probe?: (url: string, signal: AbortSignal) => Promise<{ status?: number; retryAfterMs?: number }>;
  /**
   * True while the stream may not be sent anything (its host's refusal cooldown, or the source's): no probe goes out.
   * `url` is the stream about to be probed (never log it).
   */
  blocked?: (sourceKey: string | undefined, url: string) => boolean;
  /** Statuses that mean "the source refuses us" (core's `REFUSAL_STATUSES`); defaults to the same set. */
  refusalStatuses?: ReadonlySet<number>;
  /** Every random draw (jitter, gap); injectable for tests. */
  random?: () => number;
  clock?: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
    now?: () => number; // defaults to Date.now
  };
}

export type SupervisorStatus =
  | { kind: 'loading' }
  | { kind: 'playing' }
  | { kind: 'reconnecting'; attempt: number }
  /**
   * `gone`: the source answered 404/410 (the stream is not there anymore). `httpStatus` when known (from the engine
   * or the status probe); `retryAfterMs` when a refusal came with a `Retry-After` (probe only), for the cooldown.
   * `urlIndex` (refused only): which URL of the play the source refused (0 the primary, 1+ the alternates), so the
   * cooldown lands on that URL's host. An index, never a URL. `concurrent` (refused only, with a `ledger`, when above
   * 0): other sessions of that host open or closing when the refused attempt opened, so the refusal can stay on its tile.
   */
  | { kind: 'failed'; reason: FailReason; httpStatus?: number; retryAfterMs?: number; urlIndex?: number; concurrent?: number }
  /** A VOD title played to its end (live never emits it). */
  | { kind: 'ended' };

export type FailReason = 'unavailable' | 'unsupported' | 'refused' | 'gone';

export interface LiveInfo {
  /** Seconds behind the live edge: the value the controller steers by (and the pill shows). */
  behindLiveS?: number;
  source?: LatencySource;
  /** Seconds behind by the stream clock (display only). */
  streamClockBehindS?: number;
  /** False for a non-live (file/VOD) stream; left out while unknown. */
  isLive?: boolean;
  bufferAheadS?: number;
  targetS: number;
  stalls: number;
  reconnects: number;
}

export interface PlayOptions {
  sourceKey?: string;
  /** The channel's display name, for the playback journal only. */
  channel?: string;
  /** A finite title (movie, episode): no live-delay logic, reopen at the last position on failure. */
  vod?: boolean;
  /** VOD start position in ms. */
  startMs?: number;
  /**
   * VOD only: keep `alternates` (catch-up's second archive URL form). The alternate is tried once, before anything
   * played, when the primary is gone (404/410) or its reopens ran out. Plain VOD ignores alternates.
   */
  vodAlternate?: boolean;
  /** Request headers for this stream, passed to every open. */
  headers?: StreamHeaders;
  /**
   * The app reopens the stream by itself (coming back from the background), not the user: the open waits for room under
   * the per-source open rate and counts against it, and the fail count and reconnect budget are kept, not reset.
   */
  automatic?: boolean;
  /**
   * A user open that still waits for room under the per-source open rate and counts against it (a multiview tile's
   * first open, a tile Retry). Unlike `automatic`, the fail count and reconnect budget start afresh.
   */
  countOpen?: boolean;
}

/** Same values as `REFUSAL_STATUSES` in @iptv/core (this package does not depend on core). */
const DEFAULT_REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 429, 458, 503, 509]);
/** The longest wait for an engine's teardown before the next open or probe: a hung teardown never blocks zapping. */
const CLOSE_WAIT_MAX_MS = 1500;
/** The supervisor's own cap on a status probe; past it the status is unknown. */
const PROBE_TIMEOUT_MS = 5000;

const ERROR_CODES = new Set<string>(['NETWORK', 'MEDIA', 'DECODE', 'UNSUPPORTED', 'EOS', 'AUTH']);
const LIVE_EVERY_TICKS = 8; // the delay controller runs every ~2 s
const PERSIST_EVERY_MS = 60_000;
const RESUME_GO_LIVE_MS = 30_000;
/** After a seek or recovery we issued, a waiting/playing pair is our own doing, not a stall. */
const SELF_ACTION_GRACE_MS = 2_000;
/** VOD: a stall or network error reopens at the last position at most this many times in a row (stable playback resets it). */
const VOD_MAX_REOPENS = 3;
/**
 * VOD: after a seek or resume the ladder rests until the playhead first moves, or this long at most. Engines
 * report odd buffers while a seek lands (two ranges, data ahead of a frozen playhead): not a stall.
 */
const VOD_SEEK_GRACE_MS = 10_000;

type Timer = ReturnType<typeof setTimeout>;

/** Each supervisor's id in a shared open gap. */
let nextOwner = 0;

function codeOf(e: unknown): ErrorCode | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && ERROR_CODES.has(c) ? (c as ErrorCode) : undefined;
}

/**
 * Drives one `Player` for one channel at a time (spec 2026-10-14-live-delay-and-recovery):
 * - start timers (no bytes 4 s, first frame 15 s);
 * - a 250 ms tick running the stall ladder (`decide`) and, every ~2 s, the live delay controller;
 * - reconnects (first one immediate, then 0.5/1/2/4/5 s with jitter) within a rolling budget, holding the last frame;
 * - alternates (only before anything played in this play(): a stream that played keeps its format), AUTH and
 *   UNSUPPORTED handling, and a slow give-up retry.
 * Every timer and event is tied to the play generation and the attempt id.
 */
export class PlaybackSupervisor {
  private readonly policy: RecoveryPolicy;
  private readonly clock: NonNullable<SupervisorOptions['clock']>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly preset: () => LivePreset;
  private readonly allowRate: boolean;
  private readonly store: LiveTargetStore | undefined;
  private readonly journal: JournalSink | undefined;
  private readonly openRate: SupervisorOptions['openRate'];
  private readonly openGap: SupervisorOptions['openGap'];
  private readonly owner = ++nextOwner;
  private readonly ledger: SupervisorOptions['ledger'];
  private readonly tileOpt: SupervisorOptions['tile'];
  private readonly refusalOpt: SupervisorOptions['onRefusal'];
  /** The current attempt's ledger session, and sessions waiting for the engine's teardown. */
  private session: LedgerSession | undefined;
  private closingSessions: LedgerSession[] = [];
  /** Other sessions of the host when the latest attempt opened; and when the attempt the source refused opened. */
  private attemptConcurrent = 0;
  private refusedConcurrent = 0;
  private readonly probe: SupervisorOptions['probe'];
  private readonly blocked: SupervisorOptions['blocked'];
  private readonly refusalStatuses: ReadonlySet<number>;
  private readonly budget: ReconnectBudget;
  private readonly listeners = new Set<(s: SupervisorStatus) => void>();
  private readonly unsubscribe: () => void;

  private gen = 0;
  private active = false;
  private disposed = false;
  private urls: string[] = [];
  private urlIndex = 0;
  private fails = 0; // consecutive failures on the current URL
  private authRetried = false;
  /** The source refused (AUTH) during this play() before anything played. */
  private refusedBeforePlay = false;
  /** The URL index of the latest attempt the source refused in this play() (AUTH, or a probe's refusal status). */
  private refusedIndex: number | undefined;
  /** Something played during this play(). */
  private playedThisPlay = false;
  /** Clock ms of the last `player.open()`, for the minimum gap between connection attempts. */
  private lastOpenAt = Number.NEGATIVE_INFINITY;
  /** The gap the next open keeps after the last one (drawn per open). */
  private openGapMs = 0;
  private headers: StreamHeaders | undefined;
  /** The status probe ran (or started) in this play() (VOD: on the current URL; an alternate may be probed again). */
  private probedThisPlay = false;
  /** What the failure status carries: the last known HTTP status and a refusal's Retry-After. */
  private failInfo: { httpStatus?: number; retryAfterMs?: number } = {};
  /** Waiting for a teardown or a probe: no other failure, reopen or tick acts meanwhile. */
  private waiting = false;
  private closeTimer: Timer | undefined;
  private probeTimer: Timer | undefined;
  private probeAbort: AbortController | undefined;
  /** Index of the next background retry wait. */
  private giveUpStep = 0;
  private sourceKey: string | undefined;
  private attemptCounter = 0;
  private currentAttempt: number | undefined;
  private started = false; // first frame seen in the current attempt
  private isPlaying = false;
  private playerState: PlayerState = 'idle';
  private stableSince: number | undefined;
  private stalledWhilePlaying = false;
  private stallStartedAt: number | undefined;
  private watch: WatchState = newWatch(0, 0);
  private delay: LiveDelayController | undefined;
  private rate = 1;
  private tickCount = 0;
  private lastPersistAt = 0;
  private lastHealth: PlaybackHealth | undefined;
  private stalls = 0;
  private reconnects = 0;
  private givingUp = false;
  /** Last `isLive` an engine reported for the current play(); undefined while unknown. */
  private streamLive: boolean | undefined;
  /** Latch: `isLive === true` was seen during this play(); a later false (e.g. ENDLIST) does not demote it. */
  private sawLive = false;
  private selfActionAt = Number.NEGATIVE_INFINITY;
  private hidden = false;
  /** The current play() is a finite title (VOD). */
  private vod = false;
  /** VOD: paused by the user; the stall ladder rests. */
  private userPaused = false;
  /** VOD: the last known position (ms); reopens start here. */
  private lastPosMs = 0;
  /** VOD: reopens after a stall or a network/media error since the last stable stretch. */
  private vodReopens = 0;
  /** Attempts that reached their first frame (never reset): a change means a new engine attempt is playing. */
  private startedCount = 0;
  /** VOD seek/resume grace: clock ms it ends at most, undefined when none. */
  private graceUntil: number | undefined;
  /** Grace: positions below this - 1 s mean the seek has not landed yet. */
  private graceBaseMs = 0;
  /** Grace: the first landed position; progress is measured from here. */
  private graceAnchorMs: number | undefined;
  private lastStatus: SupervisorStatus['kind'] | undefined;
  private noBytesTimer: Timer | undefined;
  private firstFrameTimer: Timer | undefined;
  private retryTimer: Timer | undefined;
  private spinnerTimer: Timer | undefined;
  private giveUpTimer: Timer | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly player: Player, opts: SupervisorOptions = {}) {
    this.policy = { ...DEFAULT_POLICY, ...opts.policy };
    // Resolve the globals at call time so fake timers installed later are honoured.
    this.clock = opts.clock ?? {
      setTimeout: ((...a: Parameters<typeof setTimeout>) => globalThis.setTimeout(...a)) as typeof setTimeout,
      clearTimeout: ((...a: Parameters<typeof clearTimeout>) => globalThis.clearTimeout(...a)) as typeof clearTimeout,
      setInterval: ((...a: Parameters<typeof setInterval>) => globalThis.setInterval(...a)) as typeof setInterval,
      clearInterval: ((...a: Parameters<typeof clearInterval>) => globalThis.clearInterval(...a)) as typeof clearInterval,
    };
    this.now = this.clock.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
    this.preset = opts.preset ?? (() => 'balanced');
    this.allowRate = opts.allowRate ?? false;
    this.store = opts.liveTargets;
    this.journal = opts.journal;
    this.openRate = opts.openRate;
    this.openGap = opts.openGap;
    this.ledger = opts.ledger;
    this.tileOpt = opts.tile;
    this.refusalOpt = opts.onRefusal;
    this.probe = opts.probe;
    this.blocked = opts.blocked;
    this.refusalStatuses = opts.refusalStatuses ?? DEFAULT_REFUSAL_STATUSES;
    this.openGapMs = this.policy.minOpenGapMs;
    this.budget = new ReconnectBudget(opts.budget ?? DEFAULT_BUDGET, () => this.now());
    this.unsubscribe = player.onState((s, d) => this.onPlayerState(s, d));
  }

  play(url: string, alternates?: string | readonly string[], opts: PlayOptions = {}): void {
    if (this.disposed) return;
    this.persistRaise();
    this.streamLive = undefined;
    this.sawLive = false;
    this.selfActionAt = Number.NEGATIVE_INFINITY;
    this.clearTimers();
    this.gen++;
    this.active = true;
    this.givingUp = false;
    // A VOD title has one URL: the "other format" alternates are a live-channel fallback, so VOD ignores them.
    this.urls = opts.vod === true && opts.vodAlternate !== true
      ? [url]
      : [url, ...(alternates === undefined ? [] : typeof alternates === 'string' ? [alternates] : alternates)];
    this.urlIndex = 0;
    if (opts.automatic !== true) this.fails = 0;
    this.authRetried = false;
    this.refusedBeforePlay = false;
    this.refusedIndex = undefined;
    this.refusedConcurrent = 0;
    this.playedThisPlay = false;
    this.sourceKey = opts.sourceKey;
    this.headers = opts.headers;
    this.probedThisPlay = false;
    this.failInfo = {};
    this.giveUpStep = 0;
    if (opts.automatic !== true) this.budget.reset();
    this.stalls = 0;
    this.reconnects = 0;
    this.rate = 1;
    this.lastHealth = undefined;
    this.vod = opts.vod === true;
    this.userPaused = false;
    this.lastPosMs = this.vod ? Math.max(0, opts.startMs ?? 0) : 0;
    this.vodReopens = 0;
    this.graceUntil = undefined;
    const now = this.now();
    if (this.vod) {
      // A finite title has no live edge: nothing is learned, read or steered.
      this.delay = undefined;
    } else {
      const learned = this.sourceKey !== undefined ? this.readRaise(this.sourceKey) : 0;
      this.delay = new LiveDelayController(this.preset(), this.allowRate, learned, now);
    }
    this.lastPersistAt = now;
    this.endAttempt();
    this.playerState = 'loading';
    this.player.releaseLastFrame?.();
    this.player.stop();
    this.note({ k: 'play', channel: opts.channel, preset: this.preset(), urls: this.urls.length });
    this.emit({ kind: 'loading' });
    // A new play() never overlaps the old stream's teardown and keeps the minimum gap after the last open. It is the
    // user's open: the open-rate cap neither holds nor counts it.
    this.afterClosed(() => this.openAfterGap(opts.automatic === true || opts.countOpen === true));
  }

  stop(): void {
    const wasActive = this.active;
    this.persistRaise();
    this.clearTimers();
    this.gen++;
    this.active = false;
    this.givingUp = false;
    this.userPaused = false;
    this.endAttempt();
    if (!this.disposed) {
      this.player.releaseLastFrame?.();
      this.player.stop();
    }
    if (wasActive) this.note({ k: 'stop' });
  }

  onStatus(fn: (s: SupervisorStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose(): void {
    if (this.disposed) return;
    this.clearTimers();
    this.gen++;
    this.active = false;
    this.disposed = true;
    this.unsubscribe();
    this.listeners.clear();
  }

  liveInfo(): LiveInfo {
    const h = this.lastHealth;
    const info: LiveInfo = { targetS: this.delay?.targetS() ?? 0, stalls: this.stalls, reconnects: this.reconnects };
    if (h?.behindLiveS !== undefined) info.behindLiveS = h.behindLiveS;
    if (h?.behindLiveSource !== undefined) info.source = h.behindLiveSource;
    if (h?.bufferAheadS !== undefined) info.bufferAheadS = h.bufferAheadS;
    if (h?.streamClockBehindS !== undefined) info.streamClockBehindS = h.streamClockBehindS;
    if (this.streamLive !== undefined) info.isLive = this.streamLive;
    return info;
  }

  /** "Go live": seek to the target, or reopen when the engine cannot seek. Nothing on a non-live stream. */
  goLive(): void {
    if (!this.active || !this.isPlaying || !this.delay || this.notLive()) return;
    this.selfActionAt = this.now();
    if (!(this.player.seekToLive?.(this.delay.targetS()) ?? false)) this.reopen(false, 'goLive');
  }

  /** A user seek or pause: drift correction holds off for a moment. */
  notifyUserAction(): void {
    this.delay?.userAction(this.now());
  }

  /** The app was in the background for `awayMs`: past 30 s the stream is behind, so jump to live. */
  onResume(awayMs: number): void {
    if (awayMs > RESUME_GO_LIVE_MS) this.goLive();
  }

  /**
   * The page is hidden (or visible again). Hidden pages present no frames, so the stall ladder and the delay
   * controller pause; on return the watch starts afresh, so the hidden time never counts as a stall.
   */
  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    if (!hidden) this.watch = newWatch(this.player.health?.().positionMs ?? this.player.position(), this.now());
  }

  // ---- VOD controls (no-ops for live) ----

  /**
   * VOD: pauses the title; the stall ladder rests until `resume()`. The pause survives a reopen (the new attempt
   * pauses on its first frame). Before the first frame it is only recorded: pausing an engine whose initial play is
   * still pending would withhold that frame and let the start timeout burn a reopen. Nothing happens when the engine
   * cannot pause.
   */
  pause(): void {
    if (!this.vod || !this.active || !this.player.pause) return;
    this.userPaused = true;
    this.stalledWhilePlaying = false;
    this.stallStartedAt = undefined;
    if (this.started && this.currentAttempt !== undefined) this.player.pause();
  }

  /** VOD: plays on; the watch starts afresh and the waiting/playing pair that may follow is our own doing. */
  resume(): void {
    if (!this.vod || !this.active || !this.userPaused) return;
    this.userPaused = false;
    const now = this.now();
    const pos = this.player.health?.().positionMs ?? this.player.position();
    this.selfActionAt = now;
    this.watch = newWatch(pos, now);
    this.startGrace(pos, now);
    this.player.play?.();
  }

  /** VOD: seeks to `ms`; when the engine cannot, reopens there. */
  seek(ms: number): void {
    if (!this.vod || !this.active) return;
    const now = this.now();
    this.selfActionAt = now;
    const dur = this.player.duration?.();
    const max = dur !== undefined && dur > 0 ? Math.max(0, dur - 1000) : Number.POSITIVE_INFINITY;
    this.lastPosMs = Math.min(Math.max(0, ms), max);
    if (this.player.seek?.(this.lastPosMs) ?? false) {
      this.watch = newWatch(this.lastPosMs, now);
      this.startGrace(this.lastPosMs, now);
      // A title that had ended plays again from here: the ladder resumes.
      if (this.started && this.ticker === undefined) this.startTicker();
    } else {
      this.reopen(false, 'seek');
    }
  }

  private startGrace(baseMs: number, now: number): void {
    this.graceUntil = now + VOD_SEEK_GRACE_MS;
    this.graceBaseMs = baseMs;
    this.graceAnchorMs = undefined;
  }

  /** True while the VOD seek/resume grace lasts: until the playhead first moves, or VOD_SEEK_GRACE_MS. */
  private inGrace(posMs: number, now: number): boolean {
    if (this.graceUntil === undefined) return false;
    if (now >= this.graceUntil) {
      this.graceUntil = undefined;
      return false;
    }
    if (posMs < this.graceBaseMs - 1000) return true; // the seek has not landed yet
    if (this.graceAnchorMs === undefined || posMs < this.graceAnchorMs) {
      this.graceAnchorMs = posMs;
      return true;
    }
    if (posMs - this.graceAnchorMs >= this.policy.minProgressS * 1000) {
      this.graceUntil = undefined; // it plays: the ladder watches again
      return false;
    }
    return true;
  }

  /** The playhead in ms: the engine's while an attempt plays; for VOD between attempts, the last known position. */
  positionMs(): number | undefined {
    if (this.started && this.currentAttempt !== undefined) return this.player.health?.().positionMs ?? this.player.position();
    return this.vod ? this.lastPosMs : undefined;
  }

  durationMs(): number | undefined {
    return this.player.duration?.();
  }

  paused(): boolean {
    return this.vod && this.userPaused;
  }

  /**
   * True while a live stream that played has failed and the slow background retries (30/60/120 s) are still scheduled
   * or one is opening. False once they end, on `stop()`, and for a stream that failed for good.
   */
  isGivingUp(): boolean {
    return this.active && this.givingUp;
  }

  /** How many attempts reached their first frame so far (never reset): a new value means a new engine attempt plays. */
  startedAttempts(): number {
    return this.startedCount;
  }

  /** Subtitle cues from engines that cannot draw them; a no-op unsubscribe when the engine has none. */
  onSubtitle(fn: (text: string | null) => void): () => void {
    return this.player.onSubtitle?.(fn) ?? (() => undefined);
  }

  // ---- attempts ----

  /** `automatic`: a reconnect, alternate or give-up retry, which the open-rate cap holds and counts. */
  private openCurrent(automatic: boolean): void {
    if (automatic && this.openRate && this.sourceKey !== undefined) {
      const room = this.openRate.waitMs(this.sourceKey);
      if (room > 0) {
        // Wake a little after the slot frees, so many waiting TVs do not all knock at the same moment.
        const wait = room + Math.round(this.policy.openRateWakeJitterMs * this.random());
        this.note({ k: 'rateWait', delayMs: wait });
        const gen = this.gen;
        this.retryTimer = this.clock.setTimeout(() => {
          this.retryTimer = undefined;
          // Through the gap again: another tile may have opened on this source meanwhile.
          if (gen === this.gen && this.active) this.openAfterGap(true);
        }, wait);
        return;
      }
      this.openRate.take(this.sourceKey);
    }
    this.markOpen();
    // A status belongs to the attempt that reported it; only a refusal before anything played still governs this play.
    if (!this.refusedBeforePlay) this.failInfo = {};
    const p = this.policy;
    const gen = this.gen;
    const id = ++this.attemptCounter;
    this.currentAttempt = id;
    this.beginSession();
    // A window's open says how many other streams of its host were open (single view's stays as it was).
    const windowed = this.ledger !== undefined && this.sourceKey !== undefined && this.tileId() !== undefined;
    this.note(windowed
      ? { k: 'open', attempt: id, urlIndex: this.urlIndex, concurrent: this.attemptConcurrent }
      : { k: 'open', attempt: id, urlIndex: this.urlIndex });
    this.started = false;
    this.stableSince = undefined;
    this.tickCount = 0;
    this.rate = 1;
    const pending = () => gen === this.gen && this.active && this.currentAttempt === id && !this.started;
    if (!this.vod) this.player.setLiveProfile?.({ preset: this.preset(), targetS: this.delay?.targetS() ?? 0, allowRate: this.allowRate });
    this.noBytesTimer = this.clock.setTimeout(() => {
      this.noBytesTimer = undefined;
      if (!pending()) return;
      const h = this.player.health?.();
      if (h?.tracksBytes && h.lastByteAt === undefined) {
        this.note({ k: 'error', code: 'NETWORK', detail: 'noBytesAtStart', engine: h.engine });
        this.fail('NETWORK', true, 'startTimeout');
      }
    }, p.noBytesStartTimeoutMs);
    this.firstFrameTimer = this.clock.setTimeout(() => {
      this.firstFrameTimer = undefined;
      if (pending()) {
        this.note({ k: 'error', code: 'NETWORK', detail: 'noFirstFrame', engine: this.player.health?.().engine });
        this.fail('NETWORK', true, 'startTimeout');
      }
    }, p.firstFrameTimeoutMs);
    this.startTicker();
    let opened: Promise<void>;
    try {
      const url = this.urls[this.urlIndex] ?? '';
      const headers = this.headers ? { headers: this.headers } : undefined;
      if (this.vod) {
        const at = this.lastPosMs > 0 ? { live: false, startMs: this.lastPosMs } : { live: false };
        opened = this.player.open(url, id, { ...at, ...headers });
      } else {
        // A live open without headers passes no options, as before.
        opened = headers ? this.player.open(url, id, headers) : this.player.open(url, id);
      }
    } catch (e) {
      this.note({ k: 'error', code: codeOf(e) ?? 'UNKNOWN', detail: 'openThrew' });
      this.fail(codeOf(e));
      return;
    }
    opened.catch((e: unknown) => {
      // Stale attempt (already failed, replaced or stopped): ignore, so one failure is never counted twice.
      if (gen !== this.gen || !this.active || this.currentAttempt !== id) return;
      this.note({ k: 'error', code: codeOf(e) ?? 'UNKNOWN', detail: 'openRejected' });
      this.fail(codeOf(e));
    });
  }

  private onPlayerState(s: PlayerState, d?: StateDetail): void {
    if (!this.active || this.disposed || this.currentAttempt === undefined) return;
    if (d?.attemptId !== undefined && d.attemptId !== this.currentAttempt) return; // stale stream
    const prev = this.playerState;
    this.playerState = s;
    const now = this.now();
    if (s === 'playing') {
      this.playedThisPlay = true;
      if (!this.started) {
        this.note({ k: 'playing', attempt: this.currentAttempt ?? 0, firstFrameMs: now - this.lastOpenAt, engine: this.player.health?.().engine });
        this.started = true;
        this.startedCount++;
        this.session?.playing();
        this.clearStartTimers();
        // Paused by the user before this attempt's first frame (the first attempt or a reopen): it stays paused.
        if (this.vod && this.userPaused) this.player.pause?.();
      }
      this.clearSpinner();
      if (!this.isPlaying) {
        this.isPlaying = true;
        this.givingUp = false;
        this.clearGiveUp();
        this.emit({ kind: 'playing' });
      }
      if (this.stalledWhilePlaying) {
        this.stalledWhilePlaying = false;
        if (this.stallStartedAt !== undefined) this.note({ k: 'stall', phase: 'end', durationMs: now - this.stallStartedAt });
        this.stallStartedAt = undefined;
        this.countStall(now);
      }
      if (prev !== 'playing') {
        this.stableSince = now;
        this.watch = newWatch(this.player.health?.().positionMs ?? this.player.position(), now);
      }
    } else if (s === 'buffering') {
      // Right after our own seek or recovery, waiting is our doing, not a stall.
      if (this.isPlaying && prev === 'playing' && now - this.selfActionAt >= SELF_ACTION_GRACE_MS) {
        if (!this.stalledWhilePlaying) {
          this.stallStartedAt = now;
          this.note({ k: 'stall', phase: 'start', bufferAheadS: this.lastHealth?.bufferAheadS });
        }
        this.stalledWhilePlaying = true;
      }
      this.stableSince = undefined;
    } else if (s === 'error') {
      this.note({ k: 'error', code: d?.code ?? 'UNKNOWN', httpStatus: d?.httpStatus, detail: d?.detail, engine: this.player.health?.().engine });
      if (d?.httpStatus !== undefined) this.failInfo = { httpStatus: d.httpStatus };
      this.fail(d?.code, false, undefined, d?.httpStatus);
    } else if (s === 'idle' && this.started) {
      // A non-live stream played to its end: nothing to recover, so the ladder stops (no reconnect).
      this.stalledWhilePlaying = false;
      this.stopTicker();
      if (this.vod && this.isPlaying) {
        this.isPlaying = false;
        this.emit({ kind: 'ended' });
      }
    }
  }

  /** A stall ended: count it and raise the target, but only for a stream that may be live. */
  private countStall(now: number): void {
    if (this.notLive()) return;
    this.stalls++;
    this.delay?.stallEnded(now);
  }

  private noteLive(live: boolean): void {
    if (live) this.sawLive = true;
    this.streamLive = this.sawLive ? true : live;
  }

  /** True when the engine says the stream is not live (file/VOD): no live-only behaviour applies. */
  private notLive(): boolean {
    const live = this.player.health?.().isLive;
    if (live !== undefined) this.noteLive(live);
    return this.streamLive === false;
  }

  // ---- tick ----

  private startTicker(): void {
    this.stopTicker();
    const gen = this.gen;
    this.ticker = this.clock.setInterval(() => {
      if (gen === this.gen && this.active) this.tick();
    }, this.policy.tickMs);
  }

  private tick(): void {
    if (!this.started || this.currentAttempt === undefined || this.busy()) return;
    const p = this.policy;
    const now = this.now();
    const h: PlaybackHealth = this.player.health?.() ?? { positionMs: this.player.position() };
    this.lastHealth = h;
    if (h.isLive !== undefined) this.noteLive(h.isLive);
    if (this.vod && this.playerState === 'playing') this.lastPosMs = h.positionMs;
    if (this.hidden || this.userPaused) return; // no frames while hidden or paused: the ladder and the controller rest
    observe(this.watch, h, p, now);
    if (this.playerState === 'playing' && this.stableSince !== undefined && now - this.stableSince >= p.stableMs) {
      this.fails = 0; // stable long enough: the next failure retries at once again
      this.vodReopens = 0; // and a VOD title gets its full reopen allowance back
    }
    if (this.vod && this.inGrace(h.positionMs, now)) return; // a seek or resume is still landing
    // VOD (finite): no gap jump, live-edge seek or no-bytes rung; emptyBuffer, frozenVideo and backstop reopen at
    // the last position.
    const d = decide(h, this.watch, p, now, this.vod);
    if (d.do === 'gapJump') {
      this.watch.gapJumpsAt.push(now);
      this.watch.lastGapJumpAt = now;
      this.selfActionAt = now;
      this.note({ k: 'ladder', action: 'gapJump', bufferAheadS: h.bufferAheadS });
      this.player.recover?.('gapJump');
      return;
    }
    if (d.do === 'seekLive') {
      this.watch.lastSeekAt = now;
      this.selfActionAt = now;
      // The edge seek is a recovery step, not a failure: when impossible, reopen without counting one.
      this.note({ k: 'ladder', action: 'seekLive', bufferAheadS: h.bufferAheadS });
      if (!(this.player.seekToLive?.(this.delay?.targetS() ?? 0) ?? false)) this.reopen(true, 'edgeSeekFailed');
      return;
    }
    if (d.do === 'reconnect') {
      this.note({ k: 'ladder', action: 'reconnect', reason: d.reason, bufferAheadS: h.bufferAheadS });
      this.fail('NETWORK', true, d.reason);
      return;
    }
    if (!this.vod && ++this.tickCount % LIVE_EVERY_TICKS === 0 && this.playerState === 'playing') this.liveTick(h, now);
  }

  /**
   * The live delay controller. Runs only for a stream that may be live and whose engine set the measure source
   * explicitly (an edge distance, or the buffer for raw TS); otherwise there is nothing sound to steer by.
   */
  private liveTick(h: PlaybackHealth, now: number): void {
    const delay = this.delay;
    if (!delay || this.streamLive === false || h.behindLiveSource === undefined) return;
    const behindS = h.behindLiveS ?? h.bufferAheadS;
    const a = delay.tick({
      behindLiveS: h.behindLiveS,
      source: h.behindLiveSource,
      bufferAheadS: h.bufferAheadS ?? 0,
      targetDurationS: h.targetDurationS,
      paused: false,
    }, now);
    if (a.do === 'rate') {
      if (this.allowRate && this.player.setPlaybackRate && a.rate !== this.rate) {
        this.rate = a.rate;
        this.player.setPlaybackRate(a.rate);
        this.note({ k: 'drift', action: 'rate', rate: a.rate, behindS, targetS: delay.targetS() });
      }
    } else if (a.do === 'seek') {
      this.selfActionAt = now;
      this.note({ k: 'drift', action: 'seek', behindS, targetS: delay.targetS() });
      if (!(this.player.seekToLive?.(delay.targetS()) ?? false)) this.reopen(true, 'drift');
    } else if (a.do === 'reopen') {
      this.note({ k: 'drift', action: 'reopen', behindS, targetS: delay.targetS() });
      this.reopen(true, 'drift');
    }
    if (now - this.lastPersistAt >= PERSIST_EVERY_MS) {
      this.lastPersistAt = now;
      this.persistRaise();
    }
  }

  // ---- failures and reconnects ----

  /**
   * `inline` is true only when called from the supervisor's own timer or tick callbacks (start timers, the 250 ms
   * tick, the retry timer); only there may a zero-delay reconnect or an alternate switch tear the engine down and
   * reopen on the spot. Everything else (player state events, a rejected `open()`, a synchronous throw from
   * `open()`) is not inline: the teardown is deferred one macrotask through the retry timer (0 ms), so it never
   * runs inside an engine callback.
   */
  private fail(code?: ErrorCode, inline = false, cause?: ReconnectCause, httpStatus?: number): void {
    if (!this.active || this.busy()) return; // a reconnect (or a probe) is already pending
    const why: ReconnectCause = cause ?? code ?? 'NETWORK';
    const wasPlaying = this.isPlaying;
    const beforeFirstFrame = !this.started;
    // Read before anything else touches the engine: it describes the attempt that just failed.
    const statusAware = this.player.supportsStatus?.() === true;
    // The ledger hears why the stream went (a source that cuts the oldest stream shows up as such drops).
    this.session?.dropped(code ?? 'UNKNOWN');
    this.endAttempt();
    // The source ending (EOS) or refusing (AUTH) the stream is not a playback stall.
    if (wasPlaying && code !== 'EOS' && code !== 'AUTH') this.countStall(this.now());
    // VOD (catch-up) before anything played: an engine that saw 404/410 itself takes the probe's "gone" branch at
    // once, instead of reopening a programme the archive does not have. Live keeps the NETWORK path (the other
    // format may still play), as does a title that played (a reopen at the position).
    if (code === 'NETWORK' && this.vod && !this.playedThisPlay && (httpStatus === 404 || httpStatus === 410)) {
      this.onGone(httpStatus, inline);
      return;
    }
    if (code === 'NETWORK' && beforeFirstFrame && !statusAware && this.mayProbe()) {
      if (inline) {
        this.runProbe(why);
        return;
      }
      // Not from our own timer: the teardown for the probe waits one macrotask, never inside an engine callback.
      const gen = this.gen;
      this.retryTimer = this.clock.setTimeout(() => {
        this.retryTimer = undefined;
        if (gen === this.gen && this.active) this.runProbe(why);
      }, 0);
      return;
    }
    this.afterFail(code, inline, why);
  }

  /** The probe may run: injected, not yet used in this play(), the source not blocked, and room in the open rate. */
  private mayProbe(): boolean {
    if (!this.probe || this.probedThisPlay || this.urls[this.urlIndex] === undefined) return false;
    // The probe runs in the browser and cannot send a custom User-Agent or Referer: against a header-gated source it
    // could falsely read a 403. Such plays keep the NETWORK path (spec §5).
    if (this.headers?.userAgent || this.headers?.referrer) return false;
    try {
      if (this.blocked?.(this.sourceKey, this.urls[this.urlIndex]!)) return false;
    } catch {
      return false;
    }
    return !(this.openRate && this.sourceKey !== undefined && this.openRate.waitMs(this.sourceKey) > 0);
  }

  /**
   * The engine cannot tell the status: stop the failed attempt, wait for its teardown, then ask the source once.
   * The answer decides the path (spec 2026-10-16-source-retry §2.1).
   */
  private runProbe(why: ReconnectCause): void {
    const probe = this.probe!;
    const url = this.urls[this.urlIndex]!;
    this.probedThisPlay = true;
    if (this.openRate && this.sourceKey !== undefined) this.openRate.take(this.sourceKey);
    this.player.holdLastFrame?.();
    this.startSpinner();
    this.player.stop();
    const gen = this.gen;
    this.afterClosed(() => this.afterSharedGap(() => {
      this.waiting = true;
      this.markOpen(); // the probe is a connection too: the next open keeps the gap after it
      const ctl = new AbortController();
      this.probeAbort = ctl;
      let settled = false;
      let timer: Timer | undefined;
      const finish = (r: { status?: number; retryAfterMs?: number }) => {
        if (settled) return;
        settled = true;
        // Only this probe's own timer and controller: a stale probe must never disarm a newer play's.
        if (timer !== undefined) this.clock.clearTimeout(timer);
        if (this.probeTimer === timer) this.probeTimer = undefined;
        if (this.probeAbort === ctl) this.probeAbort = undefined;
        if (gen !== this.gen || !this.active) return;
        this.waiting = false;
        this.onProbe(r, why);
      };
      timer = this.clock.setTimeout(() => {
        ctl.abort();
        finish({});
      }, PROBE_TIMEOUT_MS);
      this.probeTimer = timer;
      let answer: Promise<{ status?: number; retryAfterMs?: number }>;
      try {
        answer = probe(url, ctl.signal);
      } catch {
        answer = Promise.resolve({});
      }
      answer.then((r) => finish(r ?? {}), () => finish({}));
    }));
  }

  /** Runs `fn` once no other supervisor's open on this source is within its gap (at once without a shared gap). */
  private afterSharedGap(fn: () => void): void {
    const wait = this.sharedGapWait();
    if (wait <= 0) {
      fn();
      return;
    }
    const gen = this.gen;
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = undefined;
      if (gen === this.gen && this.active) this.afterSharedGap(fn);
    }, wait);
  }

  /** Maps the probe's answer: a refusal takes the AUTH path, 404/410 ends as gone, anything else stays NETWORK. */
  private onProbe(r: { status?: number; retryAfterMs?: number }, why: ReconnectCause): void {
    const status = typeof r.status === 'number' && Number.isFinite(r.status) ? r.status : undefined;
    if (status === undefined) {
      this.afterFail('NETWORK', false, why);
      return;
    }
    this.note({ k: 'error', code: 'NETWORK', httpStatus: status, detail: 'probe' });
    if (this.refusalStatuses.has(status)) {
      const retryAfterMs = typeof r.retryAfterMs === 'number' && Number.isFinite(r.retryAfterMs) ? r.retryAfterMs : undefined;
      this.failInfo = retryAfterMs === undefined ? { httpStatus: status } : { httpStatus: status, retryAfterMs };
      this.refusedIndex = this.urlIndex;
      this.refusedConcurrent = this.attemptConcurrent;
      if (this.givingUp) {
        // A refusal during the background retries: stop them instead of knocking again.
        this.givingUp = false;
        this.terminal('refused');
        return;
      }
      // A confirmed refusal: no second try on this URL; the other format once (before anything played), else refused.
      this.authRetried = true;
      if (!this.playedThisPlay) this.refusedBeforePlay = true;
      this.afterFail('AUTH', false, 'AUTH');
      return;
    }
    this.failInfo = { httpStatus: status };
    if (status === 404 || status === 410) {
      this.onGone(status, false);
      return;
    }
    this.afterFail('NETWORK', false, why);
  }

  /** The source answered 404/410 (from the probe, or from an engine that sees statuses): the stream is not there. */
  private onGone(status: number, inline: boolean): void {
    this.failInfo = { httpStatus: status };
    // Catch-up: the other archive URL form, once, before anything played.
    if (this.vod && !this.playedThisPlay && this.nextUrl(inline)) {
      this.vodReopens = 0;
      return;
    }
    this.givingUp = false;
    this.terminal('gone');
  }

  /** The failure's path once its code is known (the part of `fail` after the attempt has ended). */
  private afterFail(code: ErrorCode | undefined, inline: boolean, why: ReconnectCause): void {
    if (code === 'AUTH' && this.refusalMode() === 'stop') {
      // A tile: the source refused it, so it stops here and shows why; only the user's Retry opens it again.
      this.refusedIndex = this.urlIndex;
      this.refusedConcurrent = this.attemptConcurrent;
      this.givingUp = false;
      this.terminal('refused');
      return;
    }
    if (this.givingUp) {
      this.scheduleGiveUpRetry();
      return;
    }
    if (this.vod && (code === 'UNSUPPORTED' || code === 'DECODE')) {
      this.terminal('unsupported'); // this device cannot play the title: no reopen loop
      return;
    }
    if (code === 'UNSUPPORTED') {
      // The other format only for a channel that never played in this play(): a stream that played keeps its format.
      if (this.playedThisPlay || !this.nextUrl(inline)) this.terminal('unsupported');
      return;
    }
    // Once the source has refused this channel, a later failure before anything played is the same refusal in
    // disguise (a cross-origin 403 reaches the page as a plain network error): stop instead of retrying a source
    // that is refusing us, which can keep a temporary block alive.
    // The source refused this URL's attempt: the cooldown lands on its host.
    if (code === 'AUTH') {
      this.refusedIndex = this.urlIndex;
      this.refusedConcurrent = this.attemptConcurrent;
    }
    if (this.refusedBeforePlay && !this.playedThisPlay) {
      if (!this.nextUrl(inline)) this.terminal('refused');
      return;
    }
    if (code === 'AUTH') {
      if (!this.playedThisPlay) this.refusedBeforePlay = true;
      if (!this.authRetried) {
        this.authRetried = true;
        this.scheduleReconnect(0, inline, why);
      } else if (this.playedThisPlay || !this.nextUrl(inline)) {
        this.terminal('refused');
      }
      return;
    }
    if (this.vod) {
      // A stall or a network/media error: reopen at the last position, at most VOD_MAX_REOPENS times in a row.
      if (++this.vodReopens > VOD_MAX_REOPENS) {
        // Catch-up: the other archive URL form, once, before anything played.
        if (!this.playedThisPlay && this.nextUrl(inline)) {
          this.vodReopens = 0;
          return;
        }
        this.terminal('unavailable');
        return;
      }
      const delays = this.policy.reconnectDelaysMs;
      this.scheduleReconnect(delays[Math.min(this.vodReopens - 1, delays.length - 1)] ?? 0, inline, why);
      return;
    }
    if (code === 'EOS') {
      this.scheduleReconnect(0, inline, why);
      return;
    }
    this.fails++;
    // A channel that never played: two tries, then the other format once, then it stops quietly instead of knocking
    // on the source again and again. A stream that played keeps its format on every reconnect (no alternating).
    if (this.fails >= this.policy.failuresBeforeAlternate && !this.playedThisPlay) {
      if (!this.nextUrl(inline)) this.terminal('unavailable');
      return;
    }
    const delays = this.policy.reconnectDelaysMs;
    this.scheduleReconnect(delays[Math.min(this.fails - 1, delays.length - 1)] ?? 0, inline, why);
  }

  /** Reopen at once (live drift, "go live"): spends budget, does not count as a failure. */
  private reopen(inline = false, cause: ReconnectCause = 'drift'): void {
    if (!this.active || this.busy()) return;
    this.endAttempt();
    this.scheduleReconnect(0, inline, cause);
  }

  private scheduleReconnect(delayMs: number, inline = false, cause: ReconnectCause = 'NETWORK'): void {
    if (!this.budget.tryTake()) {
      this.terminal('unavailable');
      return;
    }
    this.reconnects++;
    this.player.holdLastFrame?.();
    this.startSpinner();
    const wait = Math.max(this.jitter(delayMs), this.gapWait());
    this.note({ k: 'reconnect', delayMs: wait, cause });
    if (inline && wait === 0) {
      this.restart();
      return;
    }
    const gen = this.gen;
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = undefined;
      if (gen !== this.gen || !this.active) return;
      this.restart();
    }, wait);
  }

  /**
   * Stops the engine, waits for its teardown (at most CLOSE_WAIT_MAX_MS), then for whatever is left of the minimum
   * gap since the last open, then opens. `beforeOpen` runs right before the open.
   */
  private restart(beforeOpen?: () => void): void {
    this.player.stop();
    this.afterClosed(() => this.openAfterGap(true, beforeOpen));
  }

  /** Opens once the minimum gap since the last open (or probe) has passed. */
  private openAfterGap(automatic: boolean, beforeOpen?: () => void): void {
    const open = () => {
      beforeOpen?.();
      this.openCurrent(automatic);
    };
    const gap = this.gapWait();
    if (gap <= 0) {
      open();
      return;
    }
    const gen = this.gen;
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = undefined;
      // Checked again on waking: another tile on this source may have opened meanwhile.
      if (gen === this.gen && this.active) this.openAfterGap(automatic, beforeOpen);
    }, gap);
  }

  /** A connection goes out now: the gap to the next one is drawn afresh (1000–1300 ms by default). */
  private markOpen(): void {
    const p = this.policy;
    this.lastOpenAt = this.now();
    this.openGapMs = p.minOpenGapMs + (p.openGapSpreadMs > 0 ? Math.round(p.openGapSpreadMs * this.random()) : 0);
    if (this.openGap && this.sourceKey !== undefined) this.openGap.mark(this.sourceKey, this.owner, this.openGapMs);
  }

  /**
   * Runs `fn` once the engine's previous session is torn down (`Player.closed`), or after CLOSE_WAIT_MAX_MS at most;
   * at once when the engine does not say. Dropped when a newer play() or stop() came first.
   */
  private afterClosed(fn: () => void): void {
    // The sessions of the attempts stopped so far are gone once this teardown is (the ledger's grace covers a hang).
    const ending = this.closingSessions;
    this.closingSessions = [];
    const ended = () => { for (const s of ending) s.closed(); };
    let closing: Promise<void> | undefined;
    try {
      closing = this.player.closed?.();
    } catch {
      closing = undefined;
    }
    if (!closing) {
      ended();
      fn();
      return;
    }
    closing.then(ended, ended);
    const gen = this.gen;
    this.waiting = true;
    let done = false;
    let timer: Timer | undefined;
    const go = () => {
      if (done) return;
      done = true;
      // Only this wait's own cap: a late close from an older play must never disarm a newer play's cap.
      if (timer !== undefined) this.clock.clearTimeout(timer);
      if (this.closeTimer === timer) this.closeTimer = undefined;
      if (gen !== this.gen || !this.active) return;
      this.waiting = false;
      fn();
    };
    timer = this.clock.setTimeout(go, CLOSE_WAIT_MAX_MS);
    this.closeTimer = timer;
    closing.then(go, go);
  }

  /** A reconnect, alternate switch, probe or teardown wait is pending. */
  private busy(): boolean {
    return this.retryTimer !== undefined || this.waiting;
  }

  /**
   * Switches to the next alternate URL; false when there is none. Inline, it switches at once; otherwise one
   * macrotask later through the retry timer, with the same generation guard.
   */
  private nextUrl(inline = false): boolean {
    if (this.urlIndex + 1 >= this.urls.length) return false;
    this.urlIndex++;
    this.note({ k: 'alternate', urlIndex: this.urlIndex });
    this.fails = 0;
    this.authRetried = false;
    // Catch-up: the alternate archive form is another URL (often another path or script), so its own status may be
    // asked once too; a missing programme then ends as Not available in seconds. Live keeps one probe per play.
    if (this.vod) this.probedThisPlay = false;
    const switchNow = () => this.restart(() => this.emit({ kind: 'loading' }));
    const wait = this.gapWait();
    if (inline && wait === 0) {
      switchNow();
      return true;
    }
    const gen = this.gen;
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = undefined;
      if (gen !== this.gen || !this.active) return;
      switchNow();
    }, wait);
    return true;
  }

  /** How long until another connection attempt is allowed (the minimum gap since the last open). */
  private gapWait(): number {
    return Math.max(0, Math.ceil(this.openGapMs - (this.now() - this.lastOpenAt)), this.sharedGapWait());
  }

  /** The wait for other supervisors' opens on this source (0 without a shared gap or a source key). */
  private sharedGapWait(): number {
    if (!this.openGap || this.sourceKey === undefined) return 0;
    try {
      return this.openGap.waitMs(this.sourceKey, this.owner);
    } catch {
      return 0;
    }
  }

  private terminal(reason: FailReason): void {
    this.clearTimers();
    this.endAttempt();
    this.note({ k: 'failed', reason });
    const { httpStatus, retryAfterMs } = this.failInfo;
    const carries = reason === 'refused' || reason === 'gone';
    this.emit({
      kind: 'failed', reason,
      ...(carries && httpStatus !== undefined ? { httpStatus } : {}),
      ...(reason === 'refused' && retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(reason === 'refused' ? { urlIndex: this.refusedIndex ?? this.urlIndex } : {}),
      ...(reason === 'refused' && this.refusedConcurrent > 0 ? { concurrent: this.refusedConcurrent } : {}),
    });
    // Background retries only bring back a live stream that was playing; a channel that never started stays
    // stopped, and a VOD title waits for the user's "Try again".
    if (reason === 'unavailable' && this.playedThisPlay && !this.vod) {
      this.givingUp = true;
      this.giveUpStep = 0;
      this.scheduleGiveUpRetry();
    } else {
      this.active = false;
    }
  }

  /**
   * The next background retry (30 s, 60 s, 120 s with jitter by default), or the end of them. The reconnect budget
   * is never refilled: each retry takes from it, and a step with no room is skipped (the next wait follows).
   */
  private scheduleGiveUpRetry(): void {
    const delays = this.policy.giveUpRetryDelaysMs;
    if (this.giveUpStep >= delays.length) {
      this.givingUp = false;
      this.active = false;
      return;
    }
    const wait = this.jitter(delays[this.giveUpStep++] ?? 0);
    const gen = this.gen;
    this.giveUpTimer = this.clock.setTimeout(() => {
      this.giveUpTimer = undefined;
      if (gen !== this.gen || !this.active) return;
      if (!this.budget.tryTake()) {
        this.scheduleGiveUpRetry();
        return;
      }
      this.note({ k: 'giveUpRetry' });
      // The format that played is kept: background retries never switch formats.
      this.fails = 0;
      this.authRetried = false;
      this.restart();
    }, wait);
  }

  private startSpinner(): void {
    if (this.spinnerTimer !== undefined) return;
    const gen = this.gen;
    this.spinnerTimer = this.clock.setTimeout(() => {
      this.spinnerTimer = undefined;
      if (gen === this.gen && this.active && !this.isPlaying && !this.givingUp) {
        this.emit({ kind: 'reconnecting', attempt: Math.max(1, this.fails) });
      }
    }, this.policy.showSpinnerAfterMs);
  }

  private jitter(ms: number): number {
    if (ms <= 0) return 0;
    return Math.round(ms * (1 + this.policy.jitter * (2 * this.random() - 1)));
  }

  // ---- persistence ----

  private readRaise(key: string): number {
    try {
      return this.store?.get(key) ?? 0;
    } catch {
      return 0;
    }
  }

  private persistRaise(): void {
    // Nothing is learned from a non-live stream.
    if (this.sourceKey === undefined || !this.delay || !this.store || this.streamLive === false) return;
    try {
      this.store.set(this.sourceKey, this.delay.learnedRaiseS());
    } catch {
      // storage problems never affect playback
    }
  }

  // ---- housekeeping ----

  /** Records one journal event; a faulty journal never affects playback. */
  private note(e: JournalInput): void {
    if (!this.journal) return;
    try {
      const tile = this.tileId();
      this.journal.add({ ...e, t: this.now(), ...(tile !== undefined ? { tile } : {}) } as JournalEvent);
    } catch {
      // diagnostics only
    }
  }

  /** The slot's role may change (a window that becomes the single-view player): both are read when used. */
  private tileId(): number | undefined {
    const t = this.tileOpt;
    return typeof t === 'function' ? t() : t;
  }

  private refusalMode(): 'retry' | 'stop' {
    const r = this.refusalOpt;
    return (typeof r === 'function' ? r() : r) ?? 'retry';
  }

  /** The attempt's stream session in the shared ledger (only with a ledger and a source key). */
  private beginSession(): void {
    this.attemptConcurrent = 0;
    if (!this.ledger || this.sourceKey === undefined) return;
    try {
      const b = this.ledger.begin(this.sourceKey, this.urls[this.urlIndex] ?? '', this.tileId() ?? 0);
      this.session = b.session;
      this.attemptConcurrent = b.concurrent;
    } catch {
      // diagnostics and scoping only: playback never depends on it
    }
  }

  /** The current attempt is over: its late events are ignored and its timers stop. */
  private endAttempt(): void {
    if (this.session) {
      this.session.closing();
      this.closingSessions.push(this.session);
      this.session = undefined;
    }
    this.clearStartTimers();
    this.stopTicker();
    this.currentAttempt = undefined;
    this.started = false;
    this.isPlaying = false;
    this.stableSince = undefined;
    this.stalledWhilePlaying = false;
    if (this.stallStartedAt !== undefined) {
      this.note({ k: 'stall', phase: 'end', durationMs: this.now() - this.stallStartedAt });
    }
    this.stallStartedAt = undefined;
  }

  private emit(s: SupervisorStatus): void {
    // A quick reconnect that never showed "reconnecting" stays "playing": no duplicate event.
    if (s.kind === 'playing' && this.lastStatus === 'playing') return;
    this.lastStatus = s.kind;
    for (const l of [...this.listeners]) l(s);
  }

  private clearStartTimers(): void {
    if (this.noBytesTimer !== undefined) this.clock.clearTimeout(this.noBytesTimer);
    if (this.firstFrameTimer !== undefined) this.clock.clearTimeout(this.firstFrameTimer);
    this.noBytesTimer = undefined;
    this.firstFrameTimer = undefined;
  }

  private stopTicker(): void {
    if (this.ticker !== undefined) this.clock.clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private clearSpinner(): void {
    if (this.spinnerTimer !== undefined) this.clock.clearTimeout(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

  private clearGiveUp(): void {
    if (this.giveUpTimer !== undefined) this.clock.clearTimeout(this.giveUpTimer);
    this.giveUpTimer = undefined;
  }

  private clearTimers(): void {
    this.clearStartTimers();
    this.stopTicker();
    this.clearSpinner();
    this.clearGiveUp();
    if (this.retryTimer !== undefined) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.closeTimer !== undefined) this.clock.clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
    if (this.probeTimer !== undefined) this.clock.clearTimeout(this.probeTimer);
    this.probeTimer = undefined;
    this.probeAbort?.abort();
    this.probeAbort = undefined;
    this.waiting = false;
  }
}
