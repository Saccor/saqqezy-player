import { PRESETS, maxRaiseS, presetTargetS, reopenThresholdS, seekThresholdS } from './presets.ts';
import type { LatencySource, LivePreset } from './types.ts';

export interface DelaySample {
  behindLiveS?: number | undefined;
  source: LatencySource;
  bufferAheadS: number;
  targetDurationS?: number | undefined;
  paused: boolean;
}

export type DelayAction = { do: 'none' } | { do: 'rate'; rate: number } | { do: 'seek' } | { do: 'reopen' };

const NONE: DelayAction = { do: 'none' };
const EASE_EVERY_MS = 60_000;
const EASE_STEP_S = 0.5;
const SEEK_MIN_GAP_MS = 20_000;
const USER_GUARD_MS = 5_000;
/** Assumed HLS segment duration while a live-edge source has not told us its own. */
const ASSUMED_TD_S = 6;
const CATCH_UP_RATE = 1.05;
const MAX_STORED_RAISE_S = 10;
/** Consecutive samples above the reopen line before a drift reopen. */
const REOPEN_SAMPLES = 2;
/** A drift reopen must bring the next sample down by at least this share, or drift reopens stop. */
const REOPEN_MIN_GAIN = 0.25;

/**
 * Keeps one stream near its target delay: raises the target after stalls, eases it back after a quiet minute,
 * and asks for a seek, a gentle rate (only when allowed) or a reopen. Pure: the caller passes the clock.
 * One instance per `play()`: a reopen that did not help stops drift reopens until the next `play()`.
 */
export class LiveDelayController {
  private raise: number;
  private td: number | undefined;
  private lastSource: LatencySource = 'buffer';
  private lastEaseAt: number;
  private overCount = 0;
  private reopenCount = 0;
  /** The measure that triggered the last drift reopen, until the next sample is compared with it. */
  private reopenFromS: number | undefined;
  private reopensOff = false;
  private lastSeekAt = Number.NEGATIVE_INFINITY;
  private userActionAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly preset: LivePreset, private readonly allowRate: boolean, initialRaiseS: number, now: number) {
    this.raise = Number.isFinite(initialRaiseS) ? Math.min(MAX_STORED_RAISE_S, Math.max(0, initialRaiseS)) : 0;
    this.lastEaseAt = now;
  }

  private effectiveTd(): number | undefined {
    return this.td ?? (this.lastSource === 'buffer' ? undefined : ASSUMED_TD_S);
  }

  targetS(): number {
    return presetTargetS(this.preset, this.effectiveTd()) + this.learnedRaiseS();
  }

  /** The raise above the preset target, for persistence per source. */
  learnedRaiseS(): number {
    return Math.min(this.raise, maxRaiseS(this.preset, this.effectiveTd()));
  }

  stallEnded(now: number): void {
    this.raise = Math.min(this.raise + PRESETS[this.preset].stallIncrementS, maxRaiseS(this.preset, this.effectiveTd()));
    this.lastEaseAt = now;
  }

  userAction(now: number): void {
    this.userActionAt = now;
    this.overCount = 0;
    this.reopenCount = 0;
  }

  /** True once a drift reopen failed to bring the delay down; then only seeks (and rate) steer. */
  reopensStopped(): boolean {
    return this.reopensOff;
  }

  tick(s: DelaySample, now: number): DelayAction {
    if (s.targetDurationS !== undefined && s.targetDurationS > 0) this.td = s.targetDurationS;
    this.lastSource = s.source;
    if (this.raise > 0 && now - this.lastEaseAt >= EASE_EVERY_MS) {
      this.raise = Math.max(0, this.raise - EASE_STEP_S);
      this.lastEaseAt = now;
    }
    if (s.paused) {
      this.overCount = 0;
      this.reopenCount = 0;
      return NONE;
    }
    const target = this.targetS();
    const measure = s.source !== 'buffer' && s.behindLiveS !== undefined ? Math.max(0, s.behindLiveS) : s.bufferAheadS;
    if (this.reopenFromS !== undefined) {
      // The first sample after a drift reopen: if it did not help, reopening again would only loop.
      if (measure > this.reopenFromS * (1 - REOPEN_MIN_GAIN)) this.reopensOff = true;
      this.reopenFromS = undefined;
    }
    const excess = measure - target;
    const userGuard = now - this.userActionAt < USER_GUARD_MS;
    if (excess > reopenThresholdS(this.preset) && !userGuard && !this.reopensOff) {
      if (++this.reopenCount >= REOPEN_SAMPLES) {
        this.reopenCount = 0;
        this.overCount = 0;
        this.reopenFromS = measure;
        return { do: 'reopen' };
      }
    } else {
      this.reopenCount = 0;
    }
    if (excess > seekThresholdS(this.preset, target)) {
      this.overCount++;
      if (this.overCount >= 2 && now - this.lastSeekAt >= SEEK_MIN_GAP_MS && !userGuard) {
        this.overCount = 0;
        this.lastSeekAt = now;
        return { do: 'seek' };
      }
      if (!this.allowRate) return NONE;
      return { do: 'rate', rate: s.bufferAheadS > 2 ? CATCH_UP_RATE : 1 };
    }
    this.overCount = 0;
    if (!this.allowRate) return NONE;
    return { do: 'rate', rate: excess > 1 && s.bufferAheadS > 2 ? CATCH_UP_RATE : 1 };
  }
}
