import type { SubtitleCue } from './parse.ts';

/**
 * Automatic subtitle sync against the stream's own subtitles: when a loaded file shows, the player records when the
 * stream's own track had a line on screen (any language: people speak at the same moments). This finds the delay (and
 * frame-rate speed) that lines the file up with that record. Speech on/off is compared at 100 ms steps, only over the
 * video the playhead actually played; both sides are ±1, and the score is their mean product (1: always agree).
 */

/** What the player recorded, in video time (ms). */
export interface SyncSample {
  /** When the stream's own track had a line on screen: [start, end]. */
  cues: readonly (readonly [number, number])[];
  /** Spans the playhead played through without a seek: [start, end]. Only these are compared. */
  played: readonly (readonly [number, number])[];
}

export interface SyncSetting { delayMs: number; speed: number }
export interface SyncResult extends SyncSetting { score: number }

/** A sample needs this many reference lines … */
export const SYNC_MIN_CUES = 20;
/** … over this much played video. */
export const SYNC_MIN_PLAYED_MS = 4 * 60_000;
/** The furthest a found delay may be. */
export const SYNC_MAX_SHIFT_MS = 60_000;
/** The speeds tried: Normal, 25 → 23.976, 23.976 → 25 (as the player's speed setting). */
export const SYNC_SPEEDS: readonly number[] = [1, 23.976 / 25, 25 / 23.976];

const BIN = 100;
const COARSE = 5;
const MAX_SHIFT = SYNC_MAX_SHIFT_MS / BIN;
/** The best must beat the current setting by this much … */
const MIN_GAIN = 0.03;
/** … and every shift more than 2 s away from it by this much (one clear peak, not a repeating pattern). */
const MIN_PEAK = 0.05;
const PEAK_AWAY = 2000 / BIN;
/** A change smaller than this is no change. */
const MIN_CHANGE_MS = 200;

const playedMs = (s: SyncSample) => s.played.reduce((n, [a, b]) => n + Math.max(0, b - a), 0);

/** Enough recorded to try: SYNC_MIN_CUES lines over SYNC_MIN_PLAYED_MS of played video. */
export function syncSampleReady(s: SyncSample): boolean {
  return s.cues.length >= SYNC_MIN_CUES && playedMs(s) >= SYNC_MIN_PLAYED_MS;
}

/** Marks [start, end] (ms) in `arr`, whose index 0 is bin `base`. */
function mark(arr: Int8Array, base: number, start: number, end: number): void {
  const a = Math.max(0, Math.round(start / BIN) - base);
  const b = Math.min(arr.length - 1, Math.round(end / BIN) - base);
  for (let i = a; i <= b; i++) arr[i] = 1;
}

/**
 * The delay and speed that line `cues` (the loaded file, in file time) up with the recorded sample, when there is a
 * clear answer that improves on `current`; otherwise undefined (keep what the user has).
 */
export function alignSubtitle(cues: readonly SubtitleCue[], sample: SyncSample, current: SyncSetting): SyncResult | undefined {
  if (!syncSampleReady(sample) || cues.length === 0) return undefined;
  // The played bins and the reference (+1 a line showed, -1 none) at each.
  const bins: number[] = [];
  for (const [a, b] of sample.played) for (let i = Math.round(a / BIN); i <= Math.round(b / BIN); i++) bins.push(i);
  bins.sort((x, y) => x - y);
  const obs = Int32Array.from(new Set(bins));
  const lo = obs[0] ?? 0;
  const hi = obs[obs.length - 1] ?? 0;
  const refOn = new Int8Array(hi - lo + 1);
  for (const [s, e] of sample.cues) mark(refOn, lo, s, e);
  const ref = new Int8Array(obs.length);
  for (let i = 0; i < obs.length; i++) ref[i] = refOn[(obs[i] ?? 0) - lo] ? 1 : -1;

  // The file at delay 0 for one speed, in video bins: a line at file time c shows at video time c / speed + delay.
  const base = lo - MAX_SHIFT - 1;
  const span = hi - lo + 2 * MAX_SHIFT + 3;
  const fileAt = (speed: number): Int8Array => {
    const on = new Int8Array(span);
    for (const c of cues) mark(on, base, c.startMs / speed, c.endMs / speed);
    return on;
  };
  // Mean agreement at a shift of k bins (the delay k * BIN).
  const scoreAt = (on: Int8Array, k: number): number => {
    let sum = 0;
    for (let i = 0; i < obs.length; i++) sum += (ref[i] ?? 0) * (on[(obs[i] ?? 0) - k - base] ? 1 : -1);
    return sum / obs.length;
  };

  let best: { speed: number; k: number; score: number; on: Int8Array } | undefined;
  let curScore = -Infinity;
  const curK = Math.round(current.delayMs / BIN);
  const coarse = new Map<number, number[]>();
  for (const speed of SYNC_SPEEDS) {
    const on = fileAt(speed);
    const scores: number[] = [];
    for (let k = -MAX_SHIFT; k <= MAX_SHIFT; k += COARSE) scores.push(scoreAt(on, k));
    coarse.set(speed, scores);
    // Refine around this speed's coarse peak.
    let peak = 0;
    for (let i = 1; i < scores.length; i++) if ((scores[i] ?? -1) > (scores[peak] ?? -1)) peak = i;
    const k0 = -MAX_SHIFT + peak * COARSE;
    for (let k = Math.max(-MAX_SHIFT, k0 - COARSE); k <= Math.min(MAX_SHIFT, k0 + COARSE); k++) {
      const s = scoreAt(on, k);
      if (!best || s > best.score) best = { speed, k, score: s, on };
    }
    if (Math.abs(speed - current.speed) / speed < 0.001) curScore = scoreAt(on, Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, curK)));
  }
  if (!best) return undefined;
  // One clear peak: every coarse shift of the best speed more than 2 s away scores clearly lower.
  const scores = coarse.get(best.speed) ?? [];
  let second = -Infinity;
  scores.forEach((s, i) => {
    if (Math.abs(-MAX_SHIFT + i * COARSE - best!.k) > PEAK_AWAY) second = Math.max(second, s);
  });
  if (best.score - second < MIN_PEAK || best.score - curScore < MIN_GAIN) return undefined;
  const delayMs = best.k * BIN;
  const speedChanged = Math.abs(best.speed - current.speed) / best.speed >= 0.001;
  if (!speedChanged && Math.abs(delayMs - current.delayMs) < MIN_CHANGE_MS) return undefined;
  return { delayMs, speed: best.speed, score: best.score };
}
