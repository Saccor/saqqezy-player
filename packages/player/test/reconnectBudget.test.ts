import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET, ReconnectBudget } from '../src/reconnectBudget.ts';

describe('ReconnectBudget', () => {
  it('allows max takes within the window, refuses the next, and frees slots as the window passes', () => {
    let t = 0;
    const b = new ReconnectBudget([{ max: 3, windowMs: 1000 }], () => t);
    expect([b.tryTake(), b.tryTake(), b.tryTake()]).toEqual([true, true, true]);
    expect(b.tryTake()).toBe(false);
    t = 999;
    expect(b.tryTake()).toBe(false);
    t = 1000;
    expect(b.tryTake()).toBe(true);
  });

  it('a refusal records nothing', () => {
    let t = 0;
    const b = new ReconnectBudget([{ max: 1, windowMs: 1000 }], () => t);
    expect(b.tryTake()).toBe(true);
    t = 500;
    expect(b.tryTake()).toBe(false); // must not extend the window
    t = 1000;
    expect(b.tryTake()).toBe(true);
  });

  it('every rule must have room', () => {
    let t = 0;
    const b = new ReconnectBudget([{ max: 2, windowMs: 100 }, { max: 3, windowMs: 1000 }], () => t);
    expect(b.tryTake()).toBe(true);
    t = 10;
    expect(b.tryTake()).toBe(true);
    t = 20;
    expect(b.tryTake()).toBe(false); // short window full
    t = 150;
    expect(b.tryTake()).toBe(true); // short window free again; long window now holds 0, 10, 150
    t = 300;
    expect(b.tryTake()).toBe(false); // long window full
    t = 1000;
    expect(b.tryTake()).toBe(true); // the take at 0 has left the long window
  });

  it('reset clears all takes', () => {
    const b = new ReconnectBudget([{ max: 1, windowMs: 1000 }], () => 0);
    expect(b.tryTake()).toBe(true);
    b.reset();
    expect(b.tryTake()).toBe(true);
  });

  it('defaults to 6 per minute and 20 per ten minutes', () => {
    expect(DEFAULT_BUDGET).toEqual([{ max: 6, windowMs: 60_000 }, { max: 20, windowMs: 600_000 }]);
  });
});
