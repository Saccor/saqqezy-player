import { describe, expect, it } from 'vitest';
import { pressSeek, seekStep } from './seekLogic.ts';

describe('seekStep', () => {
  it('uses thresholds', () => {
    expect(seekStep(0)).toBe(10_000);
    expect(seekStep(999)).toBe(10_000);
    expect(seekStep(1000)).toBe(30_000);
    expect(seekStep(2999)).toBe(30_000);
    expect(seekStep(3000)).toBe(60_000);
  });
});

describe('pressSeek', () => {
  it('starts from the position', () => {
    expect(pressSeek(undefined, 100_000, 600_000, 1, 10_000)).toEqual({ targetMs: 110_000, dir: 1 });
  });
  it('accumulates from the marker', () => {
    const a = pressSeek(undefined, 100_000, 600_000, 1, 10_000);
    expect(pressSeek(a, 100_000, 600_000, 1, 30_000).targetMs).toBe(140_000);
  });
  it('clamps at both ends', () => {
    expect(pressSeek(undefined, 595_000, 600_000, 1, 60_000).targetMs).toBe(599_000);
    expect(pressSeek(undefined, 5_000, 600_000, -1, 60_000).targetMs).toBe(0);
    expect(pressSeek(undefined, 0, 500, 1, 10_000).targetMs).toBe(0);
  });
  it('changes direction from the marker', () => {
    const a = pressSeek(undefined, 100_000, 600_000, 1, 10_000);
    expect(pressSeek(a, 100_000, 600_000, -1, 10_000)).toEqual({ targetMs: 100_000, dir: -1 });
  });
});
