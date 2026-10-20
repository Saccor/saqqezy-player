import { describe, expect, test } from 'vitest';
import { SYNC_MIN_CUES, SYNC_MIN_PLAYED_MS, alignSubtitle, syncSampleReady, type SyncSample } from '../src/subtitles/align.ts';
import type { SubtitleCue } from '../src/subtitles/parse.ts';

/** Deterministic pseudo-random numbers (synthetic timings, the same every run). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Synthetic dialogue: lines of 1–4 s with gaps of 0.3–6 s, over `minutes`. */
function dialogue(seed: number, minutes: number): SubtitleCue[] {
  const r = rng(seed);
  const out: SubtitleCue[] = [];
  let t = 2000;
  while (t < minutes * 60_000) {
    const len = 1000 + r() * 3000;
    out.push({ startMs: Math.round(t), endMs: Math.round(t + len), text: 'line' });
    t += len + 300 + r() * 5700;
  }
  return out;
}

/** How the stream's own track showed `cues` in video time: `map` from file time, some lines missing, a little jitter. */
function reference(cues: SubtitleCue[], map: (ms: number) => number, seed = 7, drop = 0.1): [number, number][] {
  const r = rng(seed);
  return cues.filter(() => r() >= drop).map((c) => {
    const j = (r() - 0.5) * 300;
    return [Math.round(map(c.startMs) + j), Math.round(map(c.endMs) + j)];
  });
}

const sample = (cues: [number, number][], played: [number, number][]): SyncSample => ({
  cues: cues.filter(([s]) => played.some(([a, b]) => s >= a && s <= b)), played,
});
const TEN_MIN: [number, number][] = [[0, 10 * 60_000]];

describe('alignSubtitle', () => {
  test('finds a constant offset: the file shows 2.3 s too early', () => {
    const file = dialogue(1, 30);
    const got = alignSubtitle(file, sample(reference(file, (ms) => ms + 2300), TEN_MIN), { delayMs: 0, speed: 1 });
    expect(got?.speed).toBe(1);
    expect(Math.abs((got?.delayMs ?? 0) - 2300)).toBeLessThanOrEqual(100);
  });

  test('finds a negative offset, within two separate played spans (a seek in between)', () => {
    const file = dialogue(2, 60);
    const played: [number, number][] = [[60_000, 4 * 60_000], [30 * 60_000, 33 * 60_000]];
    const got = alignSubtitle(file, sample(reference(file, (ms) => ms - 4100), played), { delayMs: 0, speed: 1 });
    expect(Math.abs((got?.delayMs ?? 0) + 4100)).toBeLessThanOrEqual(100);
  });

  test('finds a 25 fps file on a 23.976 fps video (speed and offset together)', () => {
    const file = dialogue(3, 60);
    const s = 23.976 / 25;
    // subtitle time = (video time - delay) * speed  ⇒  video time = file time / speed + delay
    const ref = reference(file, (ms) => ms / s + 1000);
    const got = alignSubtitle(file, sample(ref, [[20 * 60_000, 30 * 60_000]]), { delayMs: 0, speed: 1 });
    expect(got?.speed).toBeCloseTo(s, 6);
    expect(Math.abs((got?.delayMs ?? 0) - 1000)).toBeLessThanOrEqual(200);
  });

  test('nothing when the current setting is already right', () => {
    const file = dialogue(4, 20);
    const ref = reference(file, (ms) => ms + 1500);
    expect(alignSubtitle(file, sample(ref, TEN_MIN), { delayMs: 1500, speed: 1 })).toBeUndefined();
  });

  test('nothing when the speech does not line up anywhere (another film\'s track)', () => {
    const file = dialogue(5, 20);
    const other = dialogue(99, 20);
    const ref = reference(other, (ms) => ms, 11, 0);
    expect(alignSubtitle(file, sample(ref, TEN_MIN), { delayMs: 0, speed: 1 })).toBeUndefined();
  });

  test('nothing beyond ±60 s', () => {
    const file = dialogue(6, 30);
    const ref = reference(file, (ms) => ms + 90_000);
    const got = alignSubtitle(file, sample(ref, [[120_000, 12 * 60_000]]), { delayMs: 0, speed: 1 });
    expect(got === undefined || Math.abs(got.delayMs - 90_000) > 1000).toBe(true);
  });
});

describe('syncSampleReady', () => {
  test(`needs ${SYNC_MIN_CUES} reference cues over ${SYNC_MIN_PLAYED_MS / 60_000} min of played time`, () => {
    const cues = Array.from({ length: SYNC_MIN_CUES }, (_, i): [number, number] => [i * 5000, i * 5000 + 2000]);
    expect(syncSampleReady({ cues, played: [[0, SYNC_MIN_PLAYED_MS]] })).toBe(true);
    expect(syncSampleReady({ cues: cues.slice(1), played: [[0, SYNC_MIN_PLAYED_MS]] })).toBe(false);
    expect(syncSampleReady({ cues, played: [[0, SYNC_MIN_PLAYED_MS - 1000]] })).toBe(false);
  });

  test('alignSubtitle answers nothing on a sample that is not ready', () => {
    const file = dialogue(8, 10);
    const ref = reference(file, (ms) => ms + 2000);
    expect(alignSubtitle(file, sample(ref, [[0, 60_000]]), { delayMs: 0, speed: 1 })).toBeUndefined();
  });
});
