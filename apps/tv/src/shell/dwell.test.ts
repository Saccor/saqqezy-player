import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createDweller } from './dwell.ts';

describe('createDweller', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  test('the first value is immediate, later ones wait until focus rests', () => {
    const seen: string[] = [];
    const d = createDweller<string>(250, (v) => seen.push(v));
    d.push('a');
    expect(seen).toEqual(['a']);
    d.push('b');
    vi.advanceTimersByTime(200);
    d.push('c');
    vi.advanceTimersByTime(200);
    expect(seen).toEqual(['a']);
    vi.advanceTimersByTime(50);
    expect(seen).toEqual(['a', 'c']);
  });
  test('undefined does not use up the immediate first value', () => {
    const seen: (string | undefined)[] = [];
    const d = createDweller<string | undefined>(250, (v) => seen.push(v));
    d.push(undefined);
    d.push('a');
    expect(seen).toEqual([undefined, 'a']);
    d.push('b');
    expect(seen).toEqual([undefined, 'a']);
    vi.advanceTimersByTime(250);
    expect(seen).toEqual([undefined, 'a', 'b']);
  });
  test('cancel drops a pending value', () => {
    const seen: number[] = [];
    const d = createDweller<number>(250, (v) => seen.push(v));
    d.push(1);
    d.push(2);
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(seen).toEqual([1]);
  });
});
