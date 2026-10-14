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
  | { kind: 'failed'; reason: 'unavailable' | 'unsupported' | 'refused' };

export interface LiveInfo {
  behindLiveS?: number;
  source?: LatencySource;
  bufferAheadS?: number;
  targetS: number;
  stalls: number;
  reconnects: number;
}

export interface PlayOptions { sourceKey?: string }

const ERROR_CODES = new Set<string>(['NETWORK', 'MEDIA', 'DECODE', 'UNSUPPORTED', 'EOS', 'AUTH']);
const LIVE_EVERY_TICKS = 8; // the delay controller runs every ~2 s
const PERSIST_EVERY_MS = 60_000;
const RESUME_GO_LIVE_MS = 30_000;

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
 * - alternates, AUTH and UNSUPPORTED handling, and a slow give-up retry.
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
  private sourceKey: string | undefined;
  private attemptCounter = 0;
  private currentAttempt: number | undefined;
  private started = false; // first frame seen in the current attempt
  private isPlaying = false;
  private playerState: PlayerState = 'idle';
  private stableSince: number | undefined;
  private stalledWhilePlaying = false;
  private watch: WatchState = newWatch(0, 0);
  private delay: LiveDelayController | undefined;
  private rate = 1;
  private tickCount = 0;
  private lastPersistAt = 0;
  private lastHealth: PlaybackHealth | undefined;
  private stalls = 0;
  private reconnects = 0;
  private givingUp = false;
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
    this.budget = new ReconnectBudget(opts.budget ?? DEFAULT_BUDGET, () => this.now());
    this.unsubscribe = player.onState((s, d) => this.onPlayerState(s, d));
  }

  play(url: string, alternates?: string | readonly string[], opts: PlayOptions = {}): void {
    if (this.disposed) return;
    this.persistRaise();
    this.clearTimers();
    this.gen++;
    this.active = true;
    this.givingUp = false;
    this.urls = [url, ...(alternates === undefined ? [] : typeof alternates === 'string' ? [alternates] : alternates)];
    this.urlIndex = 0;
    this.fails = 0;
    this.authRetried = false;
    this.sourceKey = opts.sourceKey;
    this.budget.reset();
    this.stalls = 0;
    this.reconnects = 0;
    this.rate = 1;
    this.lastHealth = undefined;
    const now = this.now();
    const learned = this.sourceKey !== undefined ? this.readRaise(this.sourceKey) : 0;
    this.delay = new LiveDelayController(this.preset(), this.allowRate, learned, now);
    this.lastPersistAt = now;
    this.endAttempt();
    this.playerState = 'loading';
    this.player.releaseLastFrame?.();
    this.player.stop();
    this.emit({ kind: 'loading' });
    this.openCurrent();
  }

  stop(): void {
    this.persistRaise();
    this.clearTimers();
    this.gen++;
    this.active = false;
    this.givingUp = false;
    this.endAttempt();
    if (!this.disposed) {
      this.player.releaseLastFrame?.();
      this.player.stop();
    }
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
    return info;
  }

  /** "Go live": seek to the target, or reopen when the engine cannot seek. */
  goLive(): void {
    if (!this.active || !this.isPlaying || !this.delay) return;
    if (!(this.player.seekToLive?.(this.delay.targetS()) ?? false)) this.reopen();
  }

  /** A user seek or pause: drift correction holds off for a moment. */
  notifyUserAction(): void {
    this.delay?.userAction(this.now());
  }

  /** The app was in the background for `awayMs`: past 30 s the stream is behind, so jump to live. */
  onResume(awayMs: number): void {
    if (awayMs > RESUME_GO_LIVE_MS) this.goLive();
  }

  // ---- attempts ----

  private openCurrent(): void {
    const gen = this.gen;
    const id = ++this.attemptCounter;
    this.currentAttempt = id;
    this.started = false;
    this.stableSince = undefined;
    this.tickCount = 0;
    this.rate = 1;
    const p = this.policy;
    const pending = () => gen === this.gen && this.active && this.currentAttempt === id && !this.started;
    this.player.setLiveProfile?.({ preset: this.preset(), targetS: this.delay?.targetS() ?? 0, allowRate: this.allowRate });
    this.noBytesTimer = this.clock.setTimeout(() => {
      this.noBytesTimer = undefined;
      if (!pending()) return;
      const h = this.player.health?.();
      if (h?.tracksBytes && h.lastByteAt === undefined) this.fail('NETWORK', true);
    }, p.noBytesStartTimeoutMs);
    this.firstFrameTimer = this.clock.setTimeout(() => {
      this.firstFrameTimer = undefined;
      if (pending()) this.fail('NETWORK', true);
    }, p.firstFrameTimeoutMs);
    this.startTicker();
    let opened: Promise<void>;
    try {
      opened = this.player.open(this.urls[this.urlIndex] ?? '', id);
    } catch (e) {
      this.fail(codeOf(e));
      return;
    }
    opened.catch((e: unknown) => {
      // Stale attempt (already failed, replaced or stopped): ignore, so one failure is never counted twice.
      if (gen !== this.gen || !this.active || this.currentAttempt !== id) return;
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
      if (!this.started) {
        this.started = true;
        this.clearStartTimers();
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
        this.stalls++;
        this.delay?.stallEnded(now);
      }
      if (prev !== 'playing') {
        this.stableSince = now;
        this.watch = newWatch(this.player.health?.().positionMs ?? this.player.position(), now);
      }
    } else if (s === 'buffering') {
      if (this.isPlaying && prev === 'playing') this.stalledWhilePlaying = true;
      this.stableSince = undefined;
    } else if (s === 'error') {
      this.fail(d?.code);
    }
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
    observe(this.watch, h, p, now);
    if (this.playerState === 'playing' && this.stableSince !== undefined && now - this.stableSince >= p.stableMs) {
      this.fails = 0; // stable long enough: the next failure retries at once again
    }
    const d = decide(h, this.watch, p, now);
    if (d.do === 'gapJump') {
      this.watch.gapJumpsAt.push(now);
      this.watch.lastGapJumpAt = now;
      this.player.recover?.('gapJump');
      return;
    }
    if (d.do === 'seekLive') {
      this.watch.lastSeekAt = now;
      if (!(this.player.seekToLive?.(this.delay?.targetS() ?? 0) ?? false)) this.fail('NETWORK', true);
      return;
    }
    if (d.do === 'reconnect') {
      this.fail('NETWORK', true);
      return;
    }
    if (++this.tickCount % LIVE_EVERY_TICKS === 0 && this.playerState === 'playing') this.liveTick(h, now);
  }

  private liveTick(h: PlaybackHealth, now: number): void {
    const delay = this.delay;
    if (!delay) return;
    const a = delay.tick({
      behindLiveS: h.behindLiveS,
      source: h.behindLiveSource ?? 'buffer',
      bufferAheadS: h.bufferAheadS ?? 0,
      targetDurationS: h.targetDurationS,
      paused: false,
    }, now);
    if (a.do === 'rate') {
      if (this.allowRate && this.player.setPlaybackRate && a.rate !== this.rate) {
        this.rate = a.rate;
        this.player.setPlaybackRate(a.rate);
      }
    } else if (a.do === 'seek') {
      if (!(this.player.seekToLive?.(delay.targetS()) ?? false)) this.reopen(true);
    } else if (a.do === 'reopen') {
      this.reopen(true);
    }
    if (now - this.lastPersistAt >= PERSIST_EVERY_MS) {
      this.lastPersistAt = now;
      this.persistRaise();
    }
  }

  // ---- failures and reconnects ----

  /** `inline`: called from one of our own timer callbacks, so a zero-delay reconnect may run right here. */
  private fail(code?: ErrorCode, inline = false): void {
    if (!this.active || this.retryTimer !== undefined) return; // a reconnect is already pending
    const wasPlaying = this.isPlaying;
    this.endAttempt();
    if (wasPlaying) {
      this.stalls++;
      this.delay?.stallEnded(this.now());
    }
    if (this.givingUp) {
      this.scheduleGiveUpRetry();
      return;
    }
    if (code === 'UNSUPPORTED') {
      if (!this.nextUrl()) this.terminal('unsupported');
      return;
    }
    if (code === 'AUTH') {
      if (!this.authRetried) {
        this.authRetried = true;
        this.scheduleReconnect(0, inline);
      } else if (!this.nextUrl()) {
        this.terminal('refused');
      }
      return;
    }
    if (code === 'EOS') {
      this.scheduleReconnect(0, inline);
      return;
    }
    this.fails++;
    if (this.fails >= this.policy.failuresBeforeAlternate && this.nextUrl()) return;
    const delays = this.policy.reconnectDelaysMs;
    this.scheduleReconnect(delays[Math.min(this.fails - 1, delays.length - 1)] ?? 0, inline);
  }

  /** Reopen at once (live drift, "go live"): spends budget, does not count as a failure. */
  private reopen(inline = false): void {
    if (!this.active || this.retryTimer !== undefined) return;
    this.endAttempt();
    this.scheduleReconnect(0, inline);
  }

  private scheduleReconnect(delayMs: number, inline = false): void {
    if (!this.budget.tryTake()) {
      this.terminal('unavailable');
      return;
    }
    this.reconnects++;
    this.player.holdLastFrame?.();
    this.startSpinner();
    const wait = this.jitter(delayMs);
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

  /** Switches to the next alternate URL; false when there is none. */
  private nextUrl(): boolean {
    if (this.urlIndex + 1 >= this.urls.length) return false;
    this.urlIndex++;
    this.fails = 0;
    this.authRetried = false;
    this.player.stop();
    this.emit({ kind: 'loading' });
    this.openCurrent();
    return true;
  }

  private terminal(reason: 'unavailable' | 'unsupported' | 'refused'): void {
    this.clearTimers();
    this.endAttempt();
    this.emit({ kind: 'failed', reason });
    if (reason === 'unavailable') {
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
      this.urlIndex = 0;
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
    if (this.sourceKey === undefined || !this.delay || !this.store) return;
    try {
      this.store.set(this.sourceKey, this.delay.learnedRaiseS());
    } catch {
      // storage problems never affect playback
    }
  }

  // ---- housekeeping ----

  /** The current attempt is over: its late events are ignored and its timers stop. */
  private endAttempt(): void {
    this.clearStartTimers();
    this.stopTicker();
    this.currentAttempt = undefined;
    this.started = false;
    this.isPlaying = false;
    this.stableSince = undefined;
    this.stalledWhilePlaying = false;
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
