import { describe, expect, it } from 'vitest';
import { HOLD_GAP_MS, commitDelayMs, dragScrub, holdPress, jumpLabel, pressScrub, seekStep } from './seekLogic.ts';

describe('seekStep', () => {
  it('accelerates with the hold time', () => {
    expect(seekStep(0)).toBe(10_000);
    expect(seekStep(999)).toBe(10_000);
    expect(seekStep(1000)).toBe(30_000);
    expect(seekStep(2999)).toBe(30_000);
    expect(seekStep(3000)).toBe(60_000);
    expect(seekStep(5999)).toBe(60_000);
    expect(seekStep(6000)).toBe(120_000);
  });
});

describe('pressScrub', () => {
  it('starts from the position', () => {
    expect(pressScrub(undefined, 100_000, 600_000, 1, 10_000, 'keys')).toEqual({ targetMs: 110_000, fromMs: 100_000, source: 'keys' });
  });
  it('accumulates from the target and keeps where it started', () => {
    const a = pressScrub(undefined, 100_000, 600_000, 1, 10_000, 'keys');
    expect(pressScrub(a, 105_000, 600_000, 1, 30_000, 'keys')).toEqual({ targetMs: 140_000, fromMs: 100_000, source: 'keys' });
  });
  it('clamps at both ends', () => {
    expect(pressScrub(undefined, 595_000, 600_000, 1, 60_000, 'keys').targetMs).toBe(599_000);
    expect(pressScrub(undefined, 5_000, 600_000, -1, 60_000, 'keys').targetMs).toBe(0);
    expect(pressScrub(undefined, 0, 500, 1, 10_000, 'keys').targetMs).toBe(0);
  });
  it('takes the latest source', () => {
    const a = pressScrub(undefined, 100_000, 600_000, 1, 10_000, 'keys');
    expect(pressScrub(a, 100_000, 600_000, -1, 10_000, 'skip')).toEqual({ targetMs: 100_000, fromMs: 100_000, source: 'skip' });
  });
});

describe('dragScrub', () => {
  it('places the target at the fraction and clamps it', () => {
    expect(dragScrub(undefined, 50_000, 600_000, 0.5)).toEqual({ targetMs: 300_000, fromMs: 50_000, source: 'drag' });
    expect(dragScrub(undefined, 50_000, 600_000, -0.2).targetMs).toBe(0);
    expect(dragScrub(undefined, 50_000, 600_000, 1.4).targetMs).toBe(599_000);
  });
  it('keeps where a running scrub started', () => {
    const a = pressScrub(undefined, 100_000, 600_000, 1, 10_000, 'keys');
    expect(dragScrub(a, 120_000, 600_000, 0.25).fromMs).toBe(100_000);
  });
});

describe('commitDelayMs', () => {
  it('waits longer for key scrubs than for skips; a drag commits on release', () => {
    expect(commitDelayMs('keys')).toBe(2000);
    expect(commitDelayMs('skip')).toBe(700);
    expect(commitDelayMs('drag')).toBeUndefined();
  });
});

describe('jumpLabel', () => {
  it('signs the jump', () => {
    expect(jumpLabel(150_000)).toBe('+2:30');
    expect(jumpLabel(-10_000)).toBe('−0:10');
    expect(jumpLabel(0)).toBe('+0:00');
    expect(jumpLabel(3_725_000)).toBe('+1:02:05');
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
