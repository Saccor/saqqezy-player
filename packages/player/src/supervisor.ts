import type { Player, PlayerState } from './types.ts';

export interface SupervisorOptions {
  retries?: number; // default 3
  backoffMs?: number[]; // default [1000, 2000, 4000]
  stallMs?: number; // default 8000
  startTimeoutMs?: number; // default 10000
  clock?: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
  };
}

export type SupervisorStatus =
  | { kind: 'loading' }
  | { kind: 'playing' }
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'failed'; reason: 'unavailable' | 'unsupported' };

const POLL_MS = 1000;

export class PlaybackSupervisor {
  private readonly retries: number;
  private readonly backoffMs: number[];
  private readonly stallMs: number;
  private readonly startTimeoutMs: number;
  private readonly clock: NonNullable<SupervisorOptions['clock']>;
  private readonly listeners = new Set<(s: SupervisorStatus) => void>();
  private readonly unsubscribe: () => void;

  private gen = 0;
  private active = false;
  private disposed = false;
  private currentUrl = '';
  private alternateUrl: string | undefined;
  private altTried = false;
  private attempt = 0;
  private playerState: PlayerState = 'idle';
  private isPlaying = false;
  private lastPos = 0;
  private stalledMs = 0;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly player: Player, opts: SupervisorOptions = {}) {
    this.retries = opts.retries ?? 3;
    this.backoffMs = opts.backoffMs ?? [1000, 2000, 4000];
    this.stallMs = opts.stallMs ?? 8000;
    this.startTimeoutMs = opts.startTimeoutMs ?? 10000;
    // Resolve the globals at call time so fake timers installed later are honoured.
    this.clock = opts.clock ?? {
      setTimeout: ((...a: Parameters<typeof setTimeout>) => globalThis.setTimeout(...a)) as typeof setTimeout,
      clearTimeout: ((...a: Parameters<typeof clearTimeout>) => globalThis.clearTimeout(...a)) as typeof clearTimeout,
      setInterval: ((...a: Parameters<typeof setInterval>) => globalThis.setInterval(...a)) as typeof setInterval,
      clearInterval: ((...a: Parameters<typeof clearInterval>) => globalThis.clearInterval(...a)) as typeof clearInterval,
    };
    this.unsubscribe = player.onState((s, d) => this.onPlayerState(s, d));
  }

  play(url: string, alternateUrl?: string): void {
    if (this.disposed) return;
    this.clearTimers();
    this.gen++;
    this.active = true;
    this.currentUrl = url;
    this.alternateUrl = alternateUrl;
    this.altTried = false;
    this.attempt = 0;
    this.isPlaying = false;
    this.playerState = 'loading';
    this.player.stop();
    this.emit({ kind: 'loading' });
    this.openCurrent();
  }

  stop(): void {
    this.clearTimers();
    this.gen++;
    this.active = false;
    this.isPlaying = false;
    if (!this.disposed) this.player.stop();
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

  private emit(s: SupervisorStatus): void {
    for (const l of [...this.listeners]) l(s);
  }

  private openCurrent(): void {
    const gen = this.gen;
    this.startTimer = this.clock.setTimeout(() => {
      this.startTimer = undefined;
      if (gen === this.gen && this.active) this.fail();
    }, this.startTimeoutMs);
    let p: Promise<void>;
    try {
      p = this.player.open(this.currentUrl);
    } catch {
      this.fail();
      return;
    }
    p.catch((e: unknown) => {
      if (gen !== this.gen || !this.active) return;
      this.fail((e as { code?: string } | null)?.code);
    });
  }

  private onPlayerState(s: PlayerState, detail?: { code?: string; message?: string }): void {
    if (!this.active || this.disposed) return;
    this.playerState = s;
    if (s === 'playing') {
      if (this.retryTimer !== undefined) return; // late event from a stream we are replacing
      this.clearStartTimer();
      this.attempt = 0; // a successful start restores the retry budget
      if (!this.isPlaying) {
        this.isPlaying = true;
        this.lastPos = this.player.position();
        this.stalledMs = 0;
        this.startWatchdog();
        this.emit({ kind: 'playing' });
      }
    } else if (s === 'error') {
      this.fail(detail?.code);
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    const gen = this.gen;
    this.watchdog = this.clock.setInterval(() => {
      if (gen !== this.gen || !this.active) return;
      if (this.playerState !== 'playing' && this.playerState !== 'buffering') return;
      const pos = this.player.position();
      if (pos !== this.lastPos) {
        this.lastPos = pos;
        this.stalledMs = 0;
        return;
      }
      this.stalledMs += POLL_MS;
      if (this.stalledMs >= this.stallMs) this.fail();
    }, POLL_MS);
  }

  private fail(code?: string): void {
    if (!this.active || this.retryTimer !== undefined) return; // a retry is already pending
    this.clearTimers();
    this.isPlaying = false;
    if (code === 'UNSUPPORTED') {
      this.active = false;
      this.emit({ kind: 'failed', reason: 'unsupported' });
      return;
    }
    if (this.attempt < this.retries) {
      this.attempt++;
      const attempt = this.attempt;
      const gen = this.gen;
      const delay = this.backoffMs[attempt - 1] ?? this.backoffMs[this.backoffMs.length - 1] ?? 1000;
      this.emit({ kind: 'reconnecting', attempt });
      this.retryTimer = this.clock.setTimeout(() => {
        this.retryTimer = undefined;
        if (gen !== this.gen || !this.active) return;
        this.player.stop();
        this.openCurrent();
      }, delay);
      return;
    }
    if (this.alternateUrl !== undefined && !this.altTried) {
      this.altTried = true;
      this.currentUrl = this.alternateUrl;
      this.attempt = 0;
      this.player.stop();
      this.emit({ kind: 'loading' });
      this.openCurrent();
      return;
    }
    this.active = false;
    this.emit({ kind: 'failed', reason: 'unavailable' });
  }

  private clearStartTimer(): void {
    if (this.startTimer !== undefined) this.clock.clearTimeout(this.startTimer);
    this.startTimer = undefined;
  }

  private stopWatchdog(): void {
    if (this.watchdog !== undefined) this.clock.clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  private clearTimers(): void {
    this.clearStartTimer();
    if (this.retryTimer !== undefined) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.stopWatchdog();
  }
}
