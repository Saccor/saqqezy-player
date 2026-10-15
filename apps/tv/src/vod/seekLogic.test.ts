import { describe, expect, it } from 'vitest';
import { HOLD_GAP_MS, holdPress, pressSeek, seekStep } from './seekLogic.ts';

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

describe('holdPress', () => {
  it('starts a run on the first press', () => {
    const r = holdPress(undefined, 'Right', 1000);
    expect(r.heldMs).toBe(0);
    expect(r.run).toEqual({ key: 'Right', since: 1000, lastAt: 1000 });
  });
  it('continues while the same key repeats', () => {
    let r = holdPress(undefined, 'Right', 1000);
    r = holdPress(r.run, 'Right', 1500);
    r = holdPress(r.run, 'Right', 1600);
    expect(r.heldMs).toBe(600);
    expect(r.run.since).toBe(1000);
  });
  it('restarts on another key or after a gap', () => {
    const a = holdPress(undefined, 'Right', 1000);
    expect(holdPress(a.run, 'Left', 1100).heldMs).toBe(0);
    expect(holdPress(a.run, 'Right', 1000 + HOLD_GAP_MS + 1).heldMs).toBe(0);
    expect(holdPress(a.run, 'Right', 1000 + HOLD_GAP_MS).heldMs).toBe(HOLD_GAP_MS);
  });
});
