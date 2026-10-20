import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLEEP_OPTIONS, createSharedSleepTimer, createSleepTimer, nextSleepOption, type SleepState } from './sleepTimer.ts';

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

describe('createSharedSleepTimer (one timer across Player visits)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const player = () => {
    const states: SleepState[] = [];
    const onExpire = vi.fn();
    return { l: { onChange: (s: SleepState) => states.push(s), onExpire }, states, onExpire };
  };

  it('an armed timer survives a detach (Guide, Home) and shows its state to the next Player at once', () => {
    const shared = createSharedSleepTimer({ askSeconds: 60 });
    const first = player();
    const detach = shared.attach(first.l);
    shared.set(30);
    expect(first.states).toMatchObject([{ kind: 'armed', minutes: 30 }]);
    detach();
    vi.advanceTimersByTime(10 * MIN);
    const second = player();
    shared.attach(second.l);
    expect(second.states).toMatchObject([{ kind: 'armed', minutes: 30 }]);
    expect(shared.minutesLeft()).toBe(20);
  });

  it('an off timer tells a new Player nothing', () => {
    const shared = createSharedSleepTimer();
    const p = player();
    shared.attach(p.l);
    expect(p.states).toEqual([]);
  });

  it('the question reaches the attached Player and its expiry too; a detached one no longer hears anything', () => {
    const shared = createSharedSleepTimer({ askSeconds: 60 });
    const first = player();
    const detach = shared.attach(first.l);
    shared.set(15);
    detach();
    const second = player();
    shared.attach(second.l);
    vi.advanceTimersByTime(15 * MIN);
    expect(second.states.at(-1)).toEqual({ kind: 'asking', secondsLeft: 60 });
    expect(first.states).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(second.onExpire).toHaveBeenCalledTimes(1);
    expect(first.onExpire).not.toHaveBeenCalled();
    expect(shared.state()).toEqual({ kind: 'off' });
  });

  it('a Player attached during the question reopens it with the seconds left', () => {
    const shared = createSharedSleepTimer({ askSeconds: 60 });
    shared.set(15);
    vi.advanceTimersByTime(15 * MIN + 20_000);
    const p = player();
    shared.attach(p.l);
    expect(p.states).toEqual([{ kind: 'asking', secondsLeft: 40 }]);
  });

  it('with no Player attached the expiry runs the unattended fallback (the app stops playback)', () => {
    const unattended = vi.fn();
    const shared = createSharedSleepTimer({ askSeconds: 60, onExpireUnattended: unattended });
    const p = player();
    const detach = shared.attach(p.l);
    shared.set(15);
    detach();
    vi.advanceTimersByTime(15 * MIN + 60_000);
    expect(unattended).toHaveBeenCalledTimes(1);
    expect(p.onExpire).not.toHaveBeenCalled();
    expect(shared.state()).toEqual({ kind: 'off' });
  });

  it('a stale detach from an earlier Player does not detach the current one', () => {
    const shared = createSharedSleepTimer();
    const first = player();
    const detachFirst = shared.attach(first.l);
    const second = player();
    shared.attach(second.l);
    detachFirst();
    shared.set(15);
    expect(second.states).toHaveLength(1);
    expect(first.states).toHaveLength(0);
  });
});
