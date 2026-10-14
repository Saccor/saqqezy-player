import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebounce } from './debounce.ts';

describe('createDebounce', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires once with the last value after the focus rests for the delay', () => {
    const fn = vi.fn();
    const d = createDebounce(700, fn);
    d.schedule('a');
    vi.advanceTimersByTime(500);
    d.schedule('b');
    vi.advanceTimersByTime(699);
    expect(fn).not.toHaveBeenCalled();
    expect(d.pending()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('b');
    expect(d.pending()).toBe(false);
  });

  it('cancel drops the pending call', () => {
    const fn = vi.fn();
    const d = createDebounce(700, fn);
    d.schedule('a');
    d.cancel();
    vi.advanceTimersByTime(2000);
    expect(fn).not.toHaveBeenCalled();
    expect(d.pending()).toBe(false);
  });
});
