import type { PlaybackHealth } from './types.ts';

/** Timings of the stall ladder (ms unless named S). One place, so measurements can tune them. */
export interface RecoveryPolicy {
  tickMs: number;
  minProgressS: number;
  gapJumpAfterMs: number;
  maxGapJumpsPer30s: number;
  edgeSeekAfterMs: number;
  noBytesReconnectMs: number;
  emptyBufferReconnectMs: number;
  frozenVideoMs: number;
  backstopStallMs: number;
  noBytesStartTimeoutMs: number;
  firstFrameTimeoutMs: number;
  reconnectDelaysMs: number[];
  jitter: number;
  failuresBeforeAlternate: number;
  stableMs: number;
  showSpinnerAfterMs: number;
  giveUpRetryEveryMs: number;
  giveUpRetryForMs: number;
}

export const DEFAULT_POLICY: RecoveryPolicy = {
  tickMs: 250,
  minProgressS: 0.5,
  gapJumpAfterMs: 1000,
  maxGapJumpsPer30s: 3,
  edgeSeekAfterMs: 2000,
  noBytesReconnectMs: 2500,
  emptyBufferReconnectMs: 4000,
  frozenVideoMs: 3000,
  backstopStallMs: 8000,
  noBytesStartTimeoutMs: 4000,
  firstFrameTimeoutMs: 15000,
  reconnectDelaysMs: [0, 500, 1000, 2000, 4000, 5000],
  jitter: 0.2,
  failuresBeforeAlternate: 2,
  stableMs: 30000,
  showSpinnerAfterMs: 1000,
  giveUpRetryEveryMs: 15000,
  giveUpRetryForMs: 300000,
};

/** What the supervisor remembers between ticks of one playing attempt. */
export interface WatchState {
  /** Position the next progress is measured from. */
  anchorMs: number;
  lastPosMs: number;
  /** Clock ms of the last real forward progress (≥ minProgressS past the anchor). */
  lastProgressAt: number;
  lastFrames: number | undefined;
  /** Set while frames stay flat although the position moves (audio plays, video frozen). */
  framesStuckSince: number | undefined;
  gapJumpsAt: number[];
  lastGapJumpAt: number;
  lastSeekAt: number;
  discontinuities: number;
}

export function newWatch(positionMs: number, now: number): WatchState {
  return {
    anchorMs: positionMs, lastPosMs: positionMs, lastProgressAt: now, lastFrames: undefined, framesStuckSince: undefined,
    gapJumpsAt: [], lastGapJumpAt: Number.NEGATIVE_INFINITY, lastSeekAt: Number.NEGATIVE_INFINITY, discontinuities: 0,
  };
}

/** Folds one health sample into `w`. Tiny nudges are not progress; a backward jump > 1 s is a discontinuity. */
export function observe(w: WatchState, h: PlaybackHealth, p: RecoveryPolicy, now: number): void {
  const pos = h.positionMs;
  if (pos < w.anchorMs - 1000) {
    w.anchorMs = pos;
    w.discontinuities++;
  } else if (pos - w.anchorMs >= p.minProgressS * 1000) {
    w.anchorMs = pos;
    w.lastProgressAt = now;
  }
  if (h.framesPresented === undefined) {
    w.lastFrames = undefined;
    w.framesStuckSince = undefined;
  } else {
    const moving = pos > w.lastPosMs;
    if (w.lastFrames === undefined || h.framesPresented !== w.lastFrames || !moving) w.framesStuckSince = undefined;
    else w.framesStuckSince ??= now;
    w.lastFrames = h.framesPresented;
  }
  w.lastPosMs = pos;
  w.gapJumpsAt = w.gapJumpsAt.filter((t) => now - t < 30_000);
}

export type Decision =
  | { do: 'none' }
  | { do: 'gapJump' }
  | { do: 'seekLive' }
  | { do: 'reconnect'; reason: 'noBytes' | 'emptyBuffer' | 'frozenVideo' | 'backstop' };

const NONE: Decision = { do: 'none' };

/** The stall ladder (spec §3): one action for this tick, from the gentlest that fits. Pure. */
export function decide(h: PlaybackHealth, w: WatchState, p: RecoveryPolicy, now: number): Decision {
  if (w.framesStuckSince !== undefined && now - w.framesStuckSince >= p.frozenVideoMs) {
    return { do: 'reconnect', reason: 'frozenVideo' };
  }
  const stalledFor = now - w.lastProgressAt;
  if (stalledFor < p.gapJumpAfterMs) return NONE;
  if (h.tracksBytes && h.lastByteAt !== undefined && now - h.lastByteAt >= p.noBytesReconnectMs) {
    return { do: 'reconnect', reason: 'noBytes' };
  }
  const ahead = h.bufferAheadS;
  if ((ahead !== undefined && ahead >= 0.5) || (h.rangeCount ?? 0) > 1) {
    if (w.gapJumpsAt.length < p.maxGapJumpsPer30s && now - w.lastGapJumpAt >= p.gapJumpAfterMs) return { do: 'gapJump' };
    // A non-live stream has no live edge: seeking "to live" would jump to the end of the file.
    if (h.isLive !== false && stalledFor >= p.edgeSeekAfterMs && now - w.lastSeekAt >= p.edgeSeekAfterMs) {
      return { do: 'seekLive' };
    }
  }
  if (ahead !== undefined && ahead < 0.1 && stalledFor >= p.emptyBufferReconnectMs) {
    return { do: 'reconnect', reason: 'emptyBuffer' };
  }
  if (stalledFor >= p.backstopStallMs) return { do: 'reconnect', reason: 'backstop' };
  return NONE;
}
