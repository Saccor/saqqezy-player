import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACK_ONLINE_SETTLE_MS, onBackOnline } from './backOnline.ts';

describe('onBackOnline', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("calls back once the network has stayed up for 2 s after an 'online' event, until unsubscribed", () => {
    expect(BACK_ONLINE_SETTLE_MS).toBe(2000);
    const target = new EventTarget();
    const fn = vi.fn();
    const off = onBackOnline(target, fn);
    target.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(1999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    target.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("repeated 'online' events collapse into one call; an 'offline' meanwhile cancels it", () => {
    const target = new EventTarget();
    const fn = vi.fn();
    const off = onBackOnline(target, fn);
    for (let i = 0; i < 5; i++) {
      target.dispatchEvent(new Event('online'));
      vi.advanceTimersByTime(500);
    }
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(1);
    target.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(1000);
    target.dispatchEvent(new Event('offline')); // flapping: not back yet
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
    target.dispatchEvent(new Event('online'));
    off(); // unsubscribing also drops a pending call
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throwing callback never breaks the listener', () => {
    const target = new EventTarget();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    onBackOnline(target, () => { n++; throw new Error('boom'); });
    target.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(2000);
    target.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(2000);
    expect(n).toBe(2);
    warn.mockRestore();
  });

  it('does nothing without a target (no window: tests, workers without the event)', () => {
    expect(() => onBackOnline(undefined, () => undefined)()).not.toThrow();
  });
});
