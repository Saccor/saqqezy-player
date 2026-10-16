import type { JournalEvent, JournalInput, JournalSink, ReconnectCause } from './journal.ts';
import { LiveDelayController } from './liveDelay.ts';
import { DEFAULT_BUDGET, ReconnectBudget, type BudgetRule } from './reconnectBudget.ts';
import { DEFAULT_POLICY, decide, newWatch, observe, type RecoveryPolicy, type WatchState } from './recovery.ts';
import type { ErrorCode, LatencySource, LivePreset, PlaybackHealth, Player, PlayerState, StateDetail } from './types.ts';

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
   * Per-source open limit across play() calls and reloads (`SourceOpenRate`). An open that does not fit waits for
   * room; only opens with a `sourceKey` count.
   */
  openRate?: { waitMs(sourceKey: string): number; take(sourceKey: string): void };
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
  | { kind: 'failed'; reason: 'unavailable' | 'unsupported' | 'refused' }
  /** A VOD title played to its end (live never emits it). */
  | { kind: 'ended' };

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
}

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
  /** Something played during this play(). */
  private playedThisPlay = false;
  /** Clock ms of the last `player.open()`, for the minimum gap between connection attempts. */
  private lastOpenAt = Number.NEGATIVE_INFINITY;
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
  private giveUpSince = 0;
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
    this.urls = opts.vod === true
      ? [url]
      : [url, ...(alternates === undefined ? [] : typeof alternates === 'string' ? [alternates] : alternates)];
    this.urlIndex = 0;
    this.fails = 0;
    this.authRetried = false;
    this.refusedBeforePlay = false;
    this.playedThisPlay = false;
    this.sourceKey = opts.sourceKey;
    this.budget.reset();
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
    this.openCurrent();
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

  /** How many attempts reached their first frame so far (never reset): a new value means a new engine attempt plays. */
  startedAttempts(): number {
    return this.startedCount;
  }

  /** Subtitle cues from engines that cannot draw them; a no-op unsubscribe when the engine has none. */
  onSubtitle(fn: (text: string | null) => void): () => void {
    return this.player.onSubtitle?.(fn) ?? (() => undefined);
  }

  // ---- attempts ----

  private openCurrent(): void {
    if (this.openRate && this.sourceKey !== undefined) {
      const wait = this.openRate.waitMs(this.sourceKey);
      if (wait > 0) {
        this.note({ k: 'rateWait', delayMs: wait });
        const gen = this.gen;
        this.retryTimer = this.clock.setTimeout(() => {
          this.retryTimer = undefined;
          if (gen === this.gen && this.active) this.openCurrent();
        }, wait);
        return;
      }
      this.openRate.take(this.sourceKey);
    }
    this.lastOpenAt = this.now();
    const gen = this.gen;
    const id = ++this.attemptCounter;
    this.currentAttempt = id;
    this.note({ k: 'open', attempt: id, urlIndex: this.urlIndex });
    this.started = false;
    this.stableSince = undefined;
    this.tickCount = 0;
    this.rate = 1;
    const p = this.policy;
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
      opened = this.vod
        ? this.player.open(url, id, this.lastPosMs > 0 ? { live: false, startMs: this.lastPosMs } : { live: false })
        : this.player.open(url, id);
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
      this.fail(d?.code);
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
    if (!this.started || this.currentAttempt === undefined || this.retryTimer !== undefined) return;
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
  private fail(code?: ErrorCode, inline = false, cause?: ReconnectCause): void {
    if (!this.active || this.retryTimer !== undefined) return; // a reconnect is already pending
    const why: ReconnectCause = cause ?? code ?? 'NETWORK';
    const wasPlaying = this.isPlaying;
    this.endAttempt();
    // The source ending (EOS) or refusing (AUTH) the stream is not a playback stall.
    if (wasPlaying && code !== 'EOS' && code !== 'AUTH') this.countStall(this.now());
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
    if (!this.active || this.retryTimer !== undefined) return;
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
      this.player.stop();
      this.openCurrent();
      return;
    }
    const gen = this.gen;
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = undefined;
      if (gen !== this.gen || !this.active) return;
      this.player.stop();
      this.openCurrent();
    }, wait);
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
    const switchNow = () => {
      this.player.stop();
      this.emit({ kind: 'loading' });
      this.openCurrent();
    };
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
    return Math.max(0, Math.ceil(this.policy.minOpenGapMs - (this.now() - this.lastOpenAt)));
  }

  private terminal(reason: 'unavailable' | 'unsupported' | 'refused'): void {
    this.clearTimers();
    this.endAttempt();
    this.note({ k: 'failed', reason });
    this.emit({ kind: 'failed', reason });
    // Background retries only bring back a live stream that was playing; a channel that never started stays
    // stopped, and a VOD title waits for the user's "Try again".
    if (reason === 'unavailable' && this.playedThisPlay && !this.vod) {
      this.givingUp = true;
      this.giveUpSince = this.now();
      this.scheduleGiveUpRetry();
    } else {
      this.active = false;
    }
  }

  private scheduleGiveUpRetry(): void {
    const p = this.policy;
    if (this.now() - this.giveUpSince >= p.giveUpRetryForMs) {
      this.givingUp = false;
      this.active = false;
      return;
    }
    const gen = this.gen;
    this.giveUpTimer = this.clock.setTimeout(() => {
      this.giveUpTimer = undefined;
      if (gen !== this.gen || !this.active) return;
      this.note({ k: 'giveUpRetry' });
      // The format that played is kept: background retries never switch formats.
      this.fails = 0;
      this.authRetried = false;
      this.budget.reset();
      this.player.stop();
      this.openCurrent();
    }, p.giveUpRetryEveryMs);
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
      this.journal.add({ ...e, t: this.now() } as JournalEvent);
    } catch {
      // diagnostics only
    }
  }

  /** The current attempt is over: its late events are ignored and its timers stop. */
  private endAttempt(): void {
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
  }
}
