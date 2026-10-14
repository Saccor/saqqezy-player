import { describe, expect, test } from 'vitest';
import { ReplayWindow } from '../src/index.ts';

describe('ReplayWindow', () => {
  test('rejects duplicates', () => {
    const w = new ReplayWindow();
    expect(w.accept(1)).toBe(true);
    expect(w.accept(2)).toBe(true);
    expect(w.accept(1)).toBe(false);
    expect(w.accept(2)).toBe(false);
    expect(w.accept(3)).toBe(true);
  });

  test('evicts the oldest entries beyond size, and an evicted id stays rejected (low-water mark)', () => {
    const w = new ReplayWindow(3);
    expect(w.accept(10)).toBe(true);
    expect(w.accept(11)).toBe(true);
    expect(w.accept(12)).toBe(true);
    expect(w.accept(13)).toBe(true); // evicts 10
    expect(w.accept(11)).toBe(false);
    expect(w.accept(12)).toBe(false);
    expect(w.accept(13)).toBe(false);
    expect(w.accept(10)).toBe(false); // evicted, but at or below the low-water mark
    expect(w.accept(14)).toBe(true); // evicts 11
    expect(w.accept(11)).toBe(false);
  });

  test('low-water mark: after an eviction, anything <= the largest evicted id is rejected, even if never seen', () => {
    const w = new ReplayWindow(2);
    expect(w.accept(5)).toBe(true);
    expect(w.accept(20)).toBe(true);
    expect(w.accept(30)).toBe(true); // evicts 5
    expect(w.accept(4)).toBe(false); // never seen, but <= 5
    expect(w.accept(5)).toBe(false);
    expect(w.accept(6)).toBe(true); // above the mark and not in the window: accepted (evicts 20)
    expect(w.accept(19)).toBe(false); // <= 20 now
    expect(w.accept(21)).toBe(true);
  });

  test('before any eviction, out-of-order ids are accepted once', () => {
    const w = new ReplayWindow(4);
    expect(w.accept(9)).toBe(true);
    expect(w.accept(3)).toBe(true);
    expect(w.accept(3)).toBe(false);
  });

  test('a rejected duplicate does not refresh its position', () => {
    const w = new ReplayWindow(2);
    w.accept(1);
    w.accept(2);
    expect(w.accept(1)).toBe(false);
    w.accept(3); // evicts 1, the oldest accepted
    expect(w.accept(2)).toBe(false);
    expect(w.accept(1)).toBe(false);
    expect(w.accept(4)).toBe(true); // evicts 2
    expect(w.accept(3)).toBe(false);
  });

  test('defaults to 1024 entries', () => {
    const w = new ReplayWindow();
    for (let i = 0; i < 1024; i++) expect(w.accept(i)).toBe(true);
    expect(w.accept(0)).toBe(false);
    expect(w.accept(1024)).toBe(true); // evicts 0
    expect(w.accept(0)).toBe(false);
    expect(w.accept(1)).toBe(false); // still in the window
    expect(w.accept(1025)).toBe(true);
  });

  test('works with u32 ids near the top of the range', () => {
    const w = new ReplayWindow(1);
    expect(w.accept(0xfffffffe)).toBe(true);
    expect(w.accept(0xffffffff)).toBe(true);
    expect(w.accept(0xfffffffe)).toBe(false);
    expect(w.accept(0)).toBe(false);
  });

  test('rejects invalid sizes', () => {
    expect(() => new ReplayWindow(0)).toThrow();
    expect(() => new ReplayWindow(1.5)).toThrow();
  });
});
