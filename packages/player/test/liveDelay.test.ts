import { describe, expect, it } from 'vitest';
import { LiveDelayController, type DelaySample } from '../src/liveDelay.ts';

const edge = (behindLiveS: number, extra: Partial<DelaySample> = {}): DelaySample =>
  ({ behindLiveS, source: 'edge', bufferAheadS: 3, targetDurationS: 2, paused: false, ...extra });
const ts = (bufferAheadS: number): DelaySample => ({ source: 'buffer', bufferAheadS, paused: false });

describe('LiveDelayController', () => {
  it('targets the preset value; TS uses the buffer target, HLS without a known segment assumes 6 s', () => {
    const c = new LiveDelayController('balanced', false, 0, 0);
    expect(c.targetS()).toBe(3); // nothing seen yet: buffer target
    c.tick(edge(6, { targetDurationS: undefined }), 0);
    expect(c.targetS()).toBe(12); // edge without td: assume 6 s segments
    c.tick(edge(6), 2000);
    expect(c.targetS()).toBe(6); // td 2 → max(4, 6)
  });

  it('each stall raises the target by the preset increment, capped at one segment', () => {
    const c = new LiveDelayController('balanced', false, 0, 0);
    c.tick(edge(6), 0);
    c.stallEnded(1000);
    expect(c.targetS()).toBe(6.75);
    for (let i = 0; i < 5; i++) c.stallEnded(2000);
    expect(c.targetS()).toBe(8); // 6 + cap of td (2)
    expect(c.learnedRaiseS()).toBe(2);
  });

  it('eases back 0.5 s per 60 s without a stall, never below the preset target', () => {
    const c = new LiveDelayController('balanced', false, 1, 0);
    c.tick(edge(6), 0);
    expect(c.targetS()).toBe(7);
    c.tick(edge(6), 59_999);
    expect(c.targetS()).toBe(7);
    c.tick(edge(6), 60_000);
    expect(c.targetS()).toBe(6.5);
    c.tick(edge(6), 120_000);
    c.tick(edge(6), 180_000);
    expect(c.targetS()).toBe(6);
  });

  it('seeks only after two samples beyond the threshold, then not again for 20 s', () => {
    const c = new LiveDelayController('balanced', false, 0, 0);
    // target 6, seek threshold max(4, 6) = 6 → seek when behind > 12 s (and ≤ 26 s, the reopen line)
    expect(c.tick(edge(15), 0)).toEqual({ do: 'none' });
    expect(c.tick(edge(15), 2000)).toEqual({ do: 'seek' });
    expect(c.tick(edge(15), 4000)).toEqual({ do: 'none' });
    expect(c.tick(edge(15), 6000)).toEqual({ do: 'none' }); // second sample, but within 20 s of the last seek
    expect(c.tick(edge(15), 22_000)).toEqual({ do: 'seek' });
  });

  it('a user action blocks seeks for 5 s; paused never acts', () => {
    const c = new LiveDelayController('balanced', false, 0, 0);
    c.userAction(0);
    c.tick(edge(15), 0);
    expect(c.tick(edge(15), 2000)).toEqual({ do: 'none' });
    expect(c.tick(edge(15), 6000)).toEqual({ do: 'seek' });
    expect(c.tick(edge(40, { paused: true }), 30_000)).toEqual({ do: 'none' });
  });

  it('reopens when far beyond the target for two samples in a row', () => {
    const c = new LiveDelayController('balanced', false, 0, 0);
    expect(c.tick(edge(27), 0)).toEqual({ do: 'none' }); // 21 s over target 6 > 20: first sample
    expect(c.tick(edge(27), 2000)).toEqual({ do: 'reopen' });
  });

  it('rate catch-up only when allowed, 1.05 when over target by > 1 s with > 2 s buffered, else 1', () => {
    const tv = new LiveDelayController('balanced', false, 0, 0);
    expect(tv.tick(edge(9), 0)).toEqual({ do: 'none' });
    const desk = new LiveDelayController('balanced', true, 0, 0);
    expect(desk.tick(edge(9), 0)).toEqual({ do: 'rate', rate: 1.05 });
    expect(desk.tick(edge(6.5), 2000)).toEqual({ do: 'rate', rate: 1 });
    expect(desk.tick(edge(9, { bufferAheadS: 1 }), 4000)).toEqual({ do: 'rate', rate: 1 });
  });

  it('raw TS measures the buffer; a negative wall-clock value counts as 0', () => {
    const c = new LiveDelayController('balanced', false, 0, 0);
    expect(c.tick(ts(8), 0)).toEqual({ do: 'none' }); // 5 over target 3, threshold 4 → first sample
    expect(c.tick(ts(8), 2000)).toEqual({ do: 'seek' });
    const d = new LiveDelayController('balanced', true, 0, 0);
    expect(d.tick({ behindLiveS: -3, source: 'pdt', bufferAheadS: 3, targetDurationS: 2, paused: false }, 0))
      .toEqual({ do: 'rate', rate: 1 });
  });

  it('clamps a bad initial raise', () => {
    expect(new LiveDelayController('balanced', false, Number.NaN, 0).learnedRaiseS()).toBe(0);
    expect(new LiveDelayController('balanced', false, -4, 0).learnedRaiseS()).toBe(0);
    expect(new LiveDelayController('balanced', false, 99, 0).learnedRaiseS()).toBe(3); // TS cap for balanced
  });
});

describe('LiveDelayController: drift reopen (final fixes)', () => {
  it('needs two consecutive samples above the reopen line', () => {
    const c = new LiveDelayController('balanced', false, 0, 0);
    expect(c.tick(edge(27), 0)).not.toEqual({ do: 'reopen' });
    expect(c.tick(edge(10), 2000)).not.toEqual({ do: 'reopen' }); // the run is broken
    expect(c.tick(edge(27), 4000)).not.toEqual({ do: 'reopen' });
    expect(c.tick(edge(27), 6000)).toEqual({ do: 'reopen' });
  });

  it('stops drift reopens when the sample after a reopen is not at least 25 % lower', () => {
    const c = new LiveDelayController('balanced', false, 0, 0);
    c.tick(edge(40), 0);
    expect(c.tick(edge(40), 2000)).toEqual({ do: 'reopen' });
    expect(c.reopensStopped()).toBe(false);
    c.tick(edge(31), 4000); // 40 × 0.75 = 30: not lower enough
    expect(c.reopensStopped()).toBe(true);
    const later = [6000, 8000, 10_000, 12_000].map((t) => c.tick(edge(40), t));
    expect(later).not.toContainEqual({ do: 'reopen' });
    expect(later).toContainEqual({ do: 'seek' }); // still steered by seeking
  });

  it('keeps drift reopens when the reopen helped', () => {
    const c = new LiveDelayController('balanced', false, 0, 0);
    c.tick(edge(40), 0);
    c.tick(edge(40), 2000);
    c.tick(edge(20), 4000); // 40 → 20: the reopen helped
    expect(c.reopensStopped()).toBe(false);
    c.tick(edge(40), 6000);
    expect(c.tick(edge(40), 8000)).toEqual({ do: 'reopen' });
  });

  it('the over-threshold rate needs more than 2 s buffered too', () => {
    const thin = new LiveDelayController('balanced', true, 0, 0);
    expect(thin.tick(edge(15, { bufferAheadS: 1 }), 0)).toEqual({ do: 'rate', rate: 1 });
    const deep = new LiveDelayController('balanced', true, 0, 0);
    expect(deep.tick(edge(15, { bufferAheadS: 3 }), 0)).toEqual({ do: 'rate', rate: 1.05 });
  });
});
