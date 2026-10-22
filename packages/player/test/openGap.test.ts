import { describe, expect, it } from 'vitest';
import { SharedOpenGap } from '../src/index.ts';

describe('SharedOpenGap', () => {
  it('an owner never waits for its own opens', () => {
    const g = new SharedOpenGap(() => 0);
    g.mark('s', 1, 1150);
    expect(g.waitMs('s', 1)).toBe(0);
  });

  it('another owner waits until the gap after the latest open has passed', () => {
    let t = 0;
    const g = new SharedOpenGap(() => t);
    g.mark('s', 1, 1150);
    expect(g.waitMs('s', 2)).toBe(1150);
    t = 1000;
    expect(g.waitMs('s', 2)).toBe(150);
    t = 1150;
    expect(g.waitMs('s', 2)).toBe(0);
  });

  it('the longest pending gap of the other owners wins', () => {
    let t = 0;
    const g = new SharedOpenGap(() => t);
    g.mark('s', 1, 1000);
    t = 500;
    g.mark('s', 2, 1300);
    expect(g.waitMs('s', 3)).toBe(1300);
    expect(g.waitMs('s', 2)).toBe(500);
  });

  it('sources are independent', () => {
    const g = new SharedOpenGap(() => 0);
    g.mark('a', 1, 1150);
    expect(g.waitMs('b', 2)).toBe(0);
  });
});
