import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createZapper } from './zapper.ts';

interface Ch { id: string }
const LIST = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];

/** Resolves like `api.neighbour` over LIST (wrapping), after `lag` ms. */
function resolver(lag = 10) {
  const calls: [string, number][] = [];
  const resolve = (anchor: string, offset: number) => {
    calls.push([anchor, offset]);
    const i = LIST.indexOf(anchor);
    const n = LIST.length;
    const id = LIST[(((i + offset) % n) + n) % n]!;
    return new Promise<Ch | undefined>((r) => setTimeout(() => r({ id }), lag));
  };
  return { resolve, calls };
}

describe('createZapper', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('previews every press immediately but commits once, 300 ms after the last press', async () => {
    const { resolve } = resolver(5);
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const z = createZapper<Ch>({ delayMs: 300, resolve, onPreview, onCommit });
    z.setCurrent('c1');
    for (let i = 0; i < 5; i++) {
      z.press(1);
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(onPreview.mock.calls.map((c) => (c[0] as Ch).id)).toEqual(['c2', 'c3', 'c4', 'c5', 'c6']);
    expect(onCommit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(249);
    expect(onCommit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ id: 'c6' });
  });

  it('accumulates the offset from the committed channel, so out-of-order answers cannot win', async () => {
    const calls: [string, number][] = [];
    const lags = [80, 5];
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const z = createZapper<Ch>({
      delayMs: 300,
      resolve: (a, o) => {
        calls.push([a, o]);
        const lag = lags.shift() ?? 5;
        return new Promise((r) => setTimeout(() => r({ id: `${a}+${o}` }), lag));
      },
      onPreview, onCommit,
    });
    z.setCurrent('c1');
    z.press(1);
    z.press(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([['c1', 1], ['c1', 2]]);
    // The slow first answer arrived last and is ignored.
    expect(onPreview.mock.calls.map((c) => (c[0] as Ch).id)).toEqual(['c1+2']);
    await vi.advanceTimersByTimeAsync(300);
    expect(onCommit).toHaveBeenCalledWith({ id: 'c1+2' });
  });

  it('commits as soon as a late answer arrives when the delay has already passed', async () => {
    const { resolve } = resolver(500);
    const onCommit = vi.fn();
    const z = createZapper<Ch>({ delayMs: 300, resolve, onPreview: () => undefined, onCommit });
    z.setCurrent('c1');
    z.press(-1);
    await vi.advanceTimersByTimeAsync(300);
    expect(onCommit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(onCommit).toHaveBeenCalledWith({ id: 'c7' });
  });

  it('starts the next burst from the newly committed channel', async () => {
    const { resolve, calls } = resolver(5);
    const z = createZapper<Ch>({ delayMs: 300, resolve, onPreview: () => undefined, onCommit: () => undefined });
    z.setCurrent('c1');
    z.press(1);
    await vi.advanceTimersByTimeAsync(400);
    z.press(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toEqual([['c1', 1], ['c2', 1]]);
  });

  it('setCurrent and cancel drop a pending burst', async () => {
    const { resolve } = resolver(5);
    const onCommit = vi.fn();
    const onPreview = vi.fn();
    const z = createZapper<Ch>({ delayMs: 300, resolve, onPreview, onCommit });
    z.setCurrent('c1');
    z.press(1);
    z.cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onPreview).not.toHaveBeenCalled();
    z.press(1);
    z.setCurrent('c5');
    await vi.advanceTimersByTimeAsync(1000);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('ignores presses before a current channel is known and reports a miss when nothing resolves', async () => {
    const onMiss = vi.fn();
    const onCommit = vi.fn();
    const z = createZapper<Ch>({ delayMs: 300, resolve: async () => undefined, onPreview: () => undefined, onCommit, onMiss });
    z.press(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onMiss).not.toHaveBeenCalled();
    z.setCurrent('c1');
    z.press(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onMiss).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('reports a rejected lookup as a miss', async () => {
    const onMiss = vi.fn();
    const z = createZapper<Ch>({
      delayMs: 300, resolve: () => Promise.reject(new Error('rpc')),
      onPreview: () => undefined, onCommit: () => undefined, onMiss,
    });
    z.setCurrent('c1');
    z.press(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onMiss).toHaveBeenCalledTimes(1);
  });
});
