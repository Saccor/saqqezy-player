import { describe, expect, test } from 'vitest';
import { createYield, TIMER_YIELD_EVERY, type YieldDeps } from '../src/service/yieldNow.ts';

/** A message channel whose messages arrive as microtasks: it never lets a timer run by itself. */
const microtaskChannel = (posts: { n: number }): NonNullable<YieldDeps['MessageChannel']> => class {
  port1 = { onmessage: null as ((ev: unknown) => void) | null, postMessage() {} };
  port2 = { onmessage: null, postMessage: () => { posts.n++; queueMicrotask(() => this.port1.onmessage?.(null)); } };
};

describe('createYield', () => {
  test('pauses through the message channel, and through a timer every 8th pause', async () => {
    const posts = { n: 0 };
    let timers = 0;
    const pause = createYield({
      setImmediate: undefined,
      MessageChannel: microtaskChannel(posts),
      setTimeout: (fn) => { timers++; queueMicrotask(fn); },
    });
    for (let i = 1; i <= 2 * TIMER_YIELD_EVERY; i++) await pause();
    expect(TIMER_YIELD_EVERY).toBe(8);
    expect(timers).toBe(2);
    expect(posts.n).toBe(2 * TIMER_YIELD_EVERY - 2);
  });

  test('without a MessageChannel every pause is a timer', async () => {
    let timers = 0;
    const pause = createYield({ setImmediate: undefined, MessageChannel: undefined, setTimeout: (fn) => { timers++; queueMicrotask(fn); } });
    for (let i = 0; i < 3; i++) await pause();
    expect(timers).toBe(3);
  });

  test('a pending setTimeout fires during a long run of message pauses', async () => {
    // The channel starves timers on purpose (microtasks only): only the timer pauses let the pending timer run.
    const pause = createYield({ setImmediate: undefined, MessageChannel: microtaskChannel({ n: 0 }) });
    let fired = false;
    setTimeout(() => { fired = true; }, 0);
    let firedAt = -1;
    for (let i = 1; i <= 4 * TIMER_YIELD_EVERY && firedAt < 0; i++) {
      await pause();
      if (fired) firedAt = i;
    }
    expect(firedAt).toBe(TIMER_YIELD_EVERY);
  });

  test('with the real MessageChannel, a pending setTimeout fires within 8 pauses', async () => {
    const pause = createYield({ setImmediate: undefined });
    let fired = false;
    setTimeout(() => { fired = true; }, 0);
    for (let i = 0; i < TIMER_YIELD_EVERY; i++) await pause();
    expect(fired).toBe(true);
  });

  test('setImmediate comes first where it exists (Node)', async () => {
    let immediates = 0;
    const posts = { n: 0 };
    const pause = createYield({ setImmediate: (fn) => { immediates++; queueMicrotask(fn); }, MessageChannel: microtaskChannel(posts) });
    for (let i = 0; i < TIMER_YIELD_EVERY; i++) await pause();
    expect(immediates).toBe(TIMER_YIELD_EVERY);
    expect(posts.n).toBe(0);
  });
});
