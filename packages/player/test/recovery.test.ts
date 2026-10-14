import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, decide, newWatch, observe, type WatchState } from '../src/recovery.ts';
import type { PlaybackHealth } from '../src/types.ts';

const P = DEFAULT_POLICY;

/** Watch that started at t=0 with position 0, then saw `h` at `now` (no progress unless h moved). */
function watched(h: PlaybackHealth, now: number, setup?: (w: WatchState) => void): WatchState {
  const w = newWatch(0, 0);
  setup?.(w);
  observe(w, h, P, now);
  return w;
}

describe('observe', () => {
  it('counts progress only after minProgressS of forward movement', () => {
    const w = newWatch(0, 0);
    observe(w, { positionMs: 400 }, P, 1000);
    expect(w.lastProgressAt).toBe(0); // 0.4 s is not enough
    observe(w, { positionMs: 600 }, P, 1250);
    expect(w.lastProgressAt).toBe(1250);
  });

  it('a backward jump over 1 s is a discontinuity, not progress', () => {
    const w = newWatch(10_000, 0);
    observe(w, { positionMs: 2_000 }, P, 500);
    expect(w.discontinuities).toBe(1);
    expect(w.lastProgressAt).toBe(0);
    expect(w.anchorMs).toBe(2_000);
  });

  it('frames flat while the position moves marks frozen video; frames moving clears it', () => {
    const w = newWatch(0, 0);
    observe(w, { positionMs: 250, framesPresented: 10 }, P, 250);
    observe(w, { positionMs: 500, framesPresented: 10 }, P, 500);
    expect(w.framesStuckSince).toBe(500);
    observe(w, { positionMs: 750, framesPresented: 10 }, P, 750);
    expect(w.framesStuckSince).toBe(500);
    observe(w, { positionMs: 1000, framesPresented: 22 }, P, 1000);
    expect(w.framesStuckSince).toBeUndefined();
  });

  it('forgets gap jumps older than 30 s', () => {
    const w = newWatch(0, 0);
    w.gapJumpsAt.push(0, 20_000);
    observe(w, { positionMs: 0 }, P, 30_000);
    expect(w.gapJumpsAt).toEqual([20_000]);
  });
});

describe('decide', () => {
  const rows: [string, PlaybackHealth, number, ((w: WatchState) => void) | undefined, ReturnType<typeof decide>][] = [
    ['under 1 s without progress: nothing', { positionMs: 0, bufferAheadS: 3 }, 750, undefined, { do: 'none' }],
    ['1 s without progress with buffer: gap jump', { positionMs: 0, bufferAheadS: 3 }, 1000, undefined, { do: 'gapJump' }],
    ['several ranges count as buffer', { positionMs: 0, bufferAheadS: 0, rangeCount: 2 }, 1000, undefined, { do: 'gapJump' }],
    ['gap jump limit reached, under 2 s: nothing', { positionMs: 0, bufferAheadS: 3 }, 1500,
      (w) => { w.gapJumpsAt.push(0, 100, 200); w.lastGapJumpAt = 200; }, { do: 'none' }],
    ['gap jumps spent, 2 s: seek to live', { positionMs: 0, bufferAheadS: 3 }, 2000,
      (w) => { w.gapJumpsAt.push(0, 100, 200); w.lastGapJumpAt = 200; }, { do: 'seekLive' }],
    ['one gap jump per second at most', { positionMs: 0, bufferAheadS: 3 }, 1200,
      (w) => { w.gapJumpsAt.push(1000); w.lastGapJumpAt = 1000; }, { do: 'none' }],
    ['no bytes for 2.5 s: reconnect', { positionMs: 0, bufferAheadS: 0.2, tracksBytes: true, lastByteAt: 0 }, 2500, undefined,
      { do: 'reconnect', reason: 'noBytes' }],
    ['bytes are flowing: no noBytes reconnect', { positionMs: 0, bufferAheadS: 0.2, tracksBytes: true, lastByteAt: 2400 }, 2500, undefined,
      { do: 'none' }],
    ['empty buffer for 4 s: reconnect', { positionMs: 0, bufferAheadS: 0 }, 4000, undefined, { do: 'reconnect', reason: 'emptyBuffer' }],
    ['unknown buffer: only the 8 s backstop', { positionMs: 0 }, 7999, undefined, { do: 'none' }],
    ['unknown buffer at 8 s: backstop', { positionMs: 0 }, 8000, undefined, { do: 'reconnect', reason: 'backstop' }],
  ];
  for (const [name, h, now, setup, expected] of rows) {
    it(name, () => {
      const w = watched(h, now, setup);
      expect(decide(h, w, P, now)).toEqual(expected);
    });
  }

  it('frozen video for 3 s: reconnect even while the position moves', () => {
    const w = newWatch(0, 0);
    w.lastFrames = 10;
    w.framesStuckSince = 1000;
    w.lastProgressAt = 3900;
    expect(decide({ positionMs: 4000, framesPresented: 10 }, w, P, 4000)).toEqual({ do: 'reconnect', reason: 'frozenVideo' });
  });
});
