import { describe, expect, it } from 'vitest';
import { clock, minutesLeft, overlayVisible, remaining, resumeLabel } from './vodPlayerLogic.ts';

describe('clock', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(59_000)).toBe('0:59');
    expect(clock(61_000)).toBe('1:01');
    expect(clock(3_600_000)).toBe('1:00:00');
    expect(clock(3_730_000)).toBe('1:02:10');
    expect(clock(-5)).toBe('0:00');
  });
});

describe('remaining', () => {
  it('prefixes a minus', () => {
    expect(remaining(100_000, 3_730_000)).toBe('-1:00:30');
    expect(remaining(10, 5)).toBe('-0:00');
  });
});

describe('overlayVisible', () => {
  const base = { paused: false, seeking: false, problem: false, lastKeyAt: 0, now: 5000 };
  it('hides after 4 s idle', () => {
    expect(overlayVisible(base)).toBe(false);
    expect(overlayVisible({ ...base, now: 3999 })).toBe(true);
    expect(overlayVisible({ ...base, now: 4000 })).toBe(false);
  });
  it('stays for paused, seeking, problem', () => {
    expect(overlayVisible({ ...base, paused: true })).toBe(true);
    expect(overlayVisible({ ...base, seeking: true })).toBe(true);
    expect(overlayVisible({ ...base, problem: true })).toBe(true);
  });
});

describe('resumeLabel', () => {
  it('labels', () => {
    expect(resumeLabel(0)).toBe('Play');
    expect(resumeLabel(3_730_000)).toBe('Resume from 1:02:10');
  });
});

describe('minutesLeft', () => {
  it('rounds with minimum 1', () => {
    expect(minutesLeft(0, 3_120_000)).toBe('52 min left');
    expect(minutesLeft(0, 89_000)).toBe('1 min left');
    expect(minutesLeft(100, 100)).toBe('1 min left');
  });
});
