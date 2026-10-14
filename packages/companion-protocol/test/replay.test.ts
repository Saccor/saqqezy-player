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

  test('evicts the oldest entries beyond size', () => {
    const w = new ReplayWindow(3);
    expect(w.accept(10)).toBe(true);
    expect(w.accept(11)).toBe(true);
    expect(w.accept(12)).toBe(true);
    expect(w.accept(13)).toBe(true); // evicts 10
    expect(w.accept(11)).toBe(false);
    expect(w.accept(12)).toBe(false);
    expect(w.accept(13)).toBe(false);
    expect(w.accept(10)).toBe(true); // 10 was forgotten; evicts 11
    expect(w.accept(11)).toBe(true);
  });

  test('a rejected duplicate does not refresh its position', () => {
    const w = new ReplayWindow(2);
    w.accept(1);
    w.accept(2);
    expect(w.accept(1)).toBe(false);
    w.accept(3); // evicts 1, the oldest accepted
    expect(w.accept(2)).toBe(false);
    expect(w.accept(1)).toBe(true);
  });

  test('defaults to 1024 entries', () => {
    const w = new ReplayWindow();
    for (let i = 0; i < 1024; i++) expect(w.accept(i)).toBe(true);
    expect(w.accept(0)).toBe(false);
    expect(w.accept(1024)).toBe(true); // evicts 0
    expect(w.accept(0)).toBe(true);
  });

  test('rejects invalid sizes', () => {
    expect(() => new ReplayWindow(0)).toThrow();
    expect(() => new ReplayWindow(1.5)).toThrow();
  });
});
