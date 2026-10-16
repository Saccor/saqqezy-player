import { describe, expect, it, vi } from 'vitest';
import { onBackOnline } from './backOnline.ts';

describe('onBackOnline', () => {
  it("calls back on each 'online' event (never on 'offline'), until unsubscribed", () => {
    const target = new EventTarget();
    const fn = vi.fn();
    const off = onBackOnline(target, fn);
    target.dispatchEvent(new Event('offline'));
    expect(fn).not.toHaveBeenCalled();
    target.dispatchEvent(new Event('online'));
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    target.dispatchEvent(new Event('online'));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throwing callback never breaks the listener', () => {
    const target = new EventTarget();
    let n = 0;
    onBackOnline(target, () => { n++; throw new Error('boom'); });
    target.dispatchEvent(new Event('online'));
    target.dispatchEvent(new Event('online'));
    expect(n).toBe(2);
  });

  it('does nothing without a target (no window: tests, workers without the event)', () => {
    expect(() => onBackOnline(undefined, () => undefined)()).not.toThrow();
  });
});
