import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLEEP_OPTIONS, createSleepTimer, nextSleepOption, type SleepState } from './sleepTimer.ts';

const MIN = 60_000;

describe('createSleepTimer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const setup = () => {
    const states: SleepState[] = [];
    const onExpire = vi.fn();
    const t = createSleepTimer({ onChange: (s) => states.push(s), onExpire, askSeconds: 60 });
    return { t, states, onExpire };
  };

  it('starts off', () => {
    const { t } = setup();
    expect(t.state()).toEqual({ kind: 'off' });
  });

  it('asks "still watching?" when the timer runs out, then counts down 60 s and expires', () => {
    const { t, onExpire } = setup();
    t.set(15);
    expect(t.state()).toMatchObject({ kind: 'armed', minutes: 15 });
    vi.advanceTimersByTime(15 * MIN - 1);
    expect(t.state().kind).toBe('armed');
    vi.advanceTimersByTime(1);
    expect(t.state()).toEqual({ kind: 'asking', secondsLeft: 60 });
    vi.advanceTimersByTime(1000);
    expect(t.state()).toEqual({ kind: 'asking', secondsLeft: 59 });
    vi.advanceTimersByTime(58_000);
    expect(t.state()).toEqual({ kind: 'asking', secondsLeft: 1 });
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(t.state()).toEqual({ kind: 'off' });
  });

  it('stillWatching() during the question turns the timer off', () => {
    const { t, onExpire } = setup();
    t.set(30);
    vi.advanceTimersByTime(30 * MIN + 10_000);
    expect(t.state().kind).toBe('asking');
    t.stillWatching();
    expect(t.state()).toEqual({ kind: 'off' });
    vi.advanceTimersByTime(10 * MIN);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('set(0) and re-setting replace the running timer', () => {
    const { t, onExpire } = setup();
    t.set(15);
    vi.advanceTimersByTime(10 * MIN);
    t.set(30);
    vi.advanceTimersByTime(20 * MIN);
    expect(t.state().kind).toBe('armed');
    t.set(0);
    expect(t.state()).toEqual({ kind: 'off' });
    vi.advanceTimersByTime(200 * MIN);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('dispose() stops everything', () => {
    const { t, onExpire, states } = setup();
    t.set(15);
    t.dispose();
    const n = states.length;
    vi.advanceTimersByTime(200 * MIN);
    expect(onExpire).not.toHaveBeenCalled();
    expect(states.length).toBe(n);
  });

  it('reports minutes left while armed', () => {
    const { t } = setup();
    t.set(60);
    vi.advanceTimersByTime(20 * MIN + 1);
    expect(t.minutesLeft()).toBe(40);
    t.set(0);
    expect(t.minutesLeft()).toBeUndefined();
  });
});

describe('nextSleepOption', () => {
  it('cycles Off, 15, 30, 60, 90, 120 and back to Off', () => {
    expect([...SLEEP_OPTIONS]).toEqual([0, 15, 30, 60, 90, 120]);
    expect(nextSleepOption(0)).toBe(15);
    expect(nextSleepOption(90)).toBe(120);
    expect(nextSleepOption(120)).toBe(0);
    expect(nextSleepOption(42)).toBe(0);
  });
});
