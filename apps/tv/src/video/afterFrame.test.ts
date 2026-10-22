import { describe, expect, test } from 'vitest';
import { createAfterFrame } from './afterFrame.ts';

function fakes(hidden: boolean) {
  const rafs: Array<() => void> = [];
  const timers: Array<{ cb: () => void; ms: number }> = [];
  const env = {
    hidden: () => hidden,
    raf: (cb: () => void) => { rafs.push(cb); },
    setTimer: (cb: () => void, ms: number) => { timers.push({ cb, ms }); },
  };
  return { env, rafs, timers };
}

describe('createAfterFrame', () => {
  test('a hidden page runs fn synchronously', () => {
    const { env, rafs, timers } = fakes(true);
    let n = 0;
    createAfterFrame(env)(() => { n++; });
    expect(n).toBe(1);
    expect(rafs).toHaveLength(0);
    expect(timers).toHaveLength(0);
  });

  test('a visible page waits for raf then the 0 ms timer, and runs once even if the fallback fires too', () => {
    const { env, rafs, timers } = fakes(false);
    let n = 0;
    createAfterFrame(env)(() => { n++; });
    expect(n).toBe(0);
    const fallback = timers.find((t) => t.ms === 250)!;
    rafs[0]!();
    expect(n).toBe(0);
    const zero = timers.find((t) => t.ms === 0)!;
    zero.cb();
    expect(n).toBe(1);
    fallback.cb();
    expect(n).toBe(1);
  });

  test('a raf that never fires runs on the fallback timer', () => {
    const { env, timers } = fakes(false);
    let n = 0;
    createAfterFrame(env, 100)(() => { n++; });
    expect(n).toBe(0);
    timers.find((t) => t.ms === 100)!.cb();
    expect(n).toBe(1);
  });

  test('never runs twice', () => {
    const { env, rafs, timers } = fakes(false);
    let n = 0;
    createAfterFrame(env)(() => { n++; });
    rafs[0]!();
    for (const t of [...timers]) t.cb();
    for (const t of [...timers]) t.cb();
    rafs[0]!();
    expect(n).toBe(1);
  });
});
