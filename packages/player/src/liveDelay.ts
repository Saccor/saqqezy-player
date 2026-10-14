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

/**
 * Keeps one stream near its target delay: raises the target after stalls, eases it back after a quiet minute,
 * and asks for a seek, a gentle rate (only when allowed) or a reopen. Pure: the caller passes the clock.
 */
export class LiveDelayController {
  private raise: number;
  private td: number | undefined;
  private lastSource: LatencySource = 'buffer';
  private lastEaseAt: number;
  private overCount = 0;
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
      return NONE;
    }
    const target = this.targetS();
    const measure = s.source !== 'buffer' && s.behindLiveS !== undefined ? Math.max(0, s.behindLiveS) : s.bufferAheadS;
    const excess = measure - target;
    const userGuard = now - this.userActionAt < USER_GUARD_MS;
    if (excess > reopenThresholdS(this.preset) && !userGuard) {
      this.overCount = 0;
      return { do: 'reopen' };
    }
    if (excess > seekThresholdS(this.preset, target)) {
      this.overCount++;
      if (this.overCount >= 2 && now - this.lastSeekAt >= SEEK_MIN_GAP_MS && !userGuard) {
        this.overCount = 0;
        this.lastSeekAt = now;
        return { do: 'seek' };
      }
      return this.allowRate ? { do: 'rate', rate: CATCH_UP_RATE } : NONE;
    }
    this.overCount = 0;
    if (!this.allowRate) return NONE;
    return { do: 'rate', rate: excess > 1 && s.bufferAheadS > 2 ? CATCH_UP_RATE : 1 };
  }
}
