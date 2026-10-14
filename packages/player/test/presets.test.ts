import { describe, expect, it } from 'vitest';
import { maxRaiseS, presetTargetS, reopenThresholdS, seekThresholdS } from '../src/presets.ts';

describe('presets', () => {
  it('HLS targets are a multiple of the segment duration with a floor in seconds', () => {
    expect([1, 2, 6, 10].map((td) => presetTargetS('low', td))).toEqual([4, 4, 9, 15]);
    expect([1, 2, 6, 10].map((td) => presetTargetS('balanced', td))).toEqual([6, 6, 12, 20]);
    expect([1, 2, 6, 10].map((td) => presetTargetS('stable', td))).toEqual([10, 10, 18, 30]);
  });

  it('without a segment duration (raw TS) the target is a buffer target', () => {
    expect(presetTargetS('low')).toBe(1.5);
    expect(presetTargetS('balanced')).toBe(3);
    expect(presetTargetS('stable')).toBe(6);
    expect(presetTargetS('balanced', 0)).toBe(3);
  });

  it('the learned raise is capped at one segment, or a preset default for TS', () => {
    expect(maxRaiseS('balanced', 6)).toBe(6);
    expect([maxRaiseS('low'), maxRaiseS('balanced'), maxRaiseS('stable')]).toEqual([2, 3, 4]);
  });

  it('seek and reopen thresholds', () => {
    expect(seekThresholdS('low', 1.5)).toBe(2);
    expect(seekThresholdS('balanced', 3)).toBe(4);
    expect(seekThresholdS('balanced', 12)).toBe(12);
    expect(seekThresholdS('stable', 6)).toBe(8);
    expect([reopenThresholdS('low'), reopenThresholdS('balanced'), reopenThresholdS('stable')]).toEqual([15, 20, 30]);
  });
});
