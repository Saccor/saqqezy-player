import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { visibleInterval } from './visibleInterval.ts';

function fakeDoc(hidden: boolean) {
  const listeners = new Set<() => void>();
  return {
    hidden,
    addEventListener: (_t: string, l: () => void) => { listeners.add(l); },
    removeEventListener: (_t: string, l: () => void) => { listeners.delete(l); },
    fire: () => { for (const l of listeners) l(); },
    listeners,
  };
}

describe('visibleInterval', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test('ticks while visible, not while hidden, and once on return', () => {
    const doc = fakeDoc(false);
    const fn = vi.fn();
    const stop = visibleInterval(fn, 1000, doc);
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(2);
    doc.hidden = true;
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(2);
    doc.hidden = false;
    doc.fire();
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(doc.listeners.size).toBe(0);
  });

  test('a visibilitychange to hidden does not run the callback', () => {
    const doc = fakeDoc(false);
    const fn = vi.fn();
    const stop = visibleInterval(fn, 1000, doc);
    doc.hidden = true;
    doc.fire();
    expect(fn).not.toHaveBeenCalled();
    stop();
  });
});
