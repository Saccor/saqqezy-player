import { describe, expect, it, vi } from 'vitest';
import { createPlaybackPool, type PoolSlot } from './pool.ts';

function slot(name: string, log: string[]): PoolSlot & { name: string } {
  return { name, stop: () => { log.push(`stop:${name}`); }, dispose: () => { log.push(`dispose:${name}`); } };
}

describe('createPlaybackPool', () => {
  it('slot 0 is the given stack; extra slots are made on first use and kept', () => {
    const log: string[] = [];
    const s0 = slot('0', log);
    const make = vi.fn((n: number) => slot(String(n), log));
    const pool = createPlaybackPool(s0, make);
    expect(make).not.toHaveBeenCalled();
    expect(pool.slot(0)).toBe(s0);
    expect(pool.slots()).toEqual([s0]);
    const s1 = pool.slot(1);
    expect(pool.slot(1)).toBe(s1);
    expect(make).toHaveBeenCalledTimes(1);
    expect(make).toHaveBeenCalledWith(1);
    expect(pool.slots()).toEqual([s0, s1]);
  });

  it('slots outside 0..max-1 throw', () => {
    const pool = createPlaybackPool(slot('0', []), (n) => slot(String(n), []));
    expect(pool.max).toBe(4);
    expect(() => pool.slot(4)).toThrow(RangeError);
    expect(() => pool.slot(-1)).toThrow(RangeError);
    expect(() => createPlaybackPool(slot('0', []), (n) => slot(String(n), []), 1).slot(1)).toThrow(RangeError);
  });

  it('stopAll stops the primary first, then every other slot, and keeps them', () => {
    const log: string[] = [];
    const pool = createPlaybackPool(slot('0', log), (n) => slot(String(n), log));
    pool.slot(2);
    pool.slot(1);
    pool.stopAll();
    expect(log).toEqual(['stop:0', 'stop:1', 'stop:2']);
    expect(pool.slots()).toHaveLength(3);
  });

  it('release stops and disposes the other slots and forgets them; the primary keeps playing', () => {
    const log: string[] = [];
    const make = vi.fn((n: number) => slot(String(n), log));
    const pool = createPlaybackPool(slot('0', log), make);
    pool.slot(1);
    pool.release();
    expect(log).toEqual(['stop:1', 'dispose:1']);
    expect(pool.slots()).toHaveLength(1);
    pool.slot(1);
    expect(make).toHaveBeenCalledTimes(2);
  });
});

describe('createPlaybackPool: the primary slot (the one with sound)', () => {
  it('is slot 0 until moved to an existing slot; listeners hear the move', () => {
    const pool = createPlaybackPool(slot('0', []), (n) => slot(String(n), []));
    const moves: Array<[number, number]> = [];
    pool.onPrimary((n, prev) => { moves.push([n, prev]); });
    expect(pool.primary()).toBe(0);
    pool.slot(1);
    pool.setPrimary(1);
    expect(pool.primary()).toBe(1);
    pool.setPrimary(1); // no change, no call
    expect(moves).toEqual([[1, 0]]);
    expect(() => pool.setPrimary(2)).toThrow(RangeError);
    expect(pool.slots().map((s) => (s as { name: string }).name)).toEqual(['1', '0']); // primary first
  });

  it('release keeps the primary, also when it is not slot 0; slot 0 is made again when asked for', () => {
    const log: string[] = [];
    const s0 = slot('0', log);
    const make = vi.fn((n: number) => slot(`${n}b`, log));
    const pool = createPlaybackPool(s0, make);
    const s1 = pool.slot(1);
    pool.setPrimary(1);
    pool.release();
    expect(log).toEqual(['stop:0', 'dispose:0']);
    expect(pool.slots()).toEqual([s1]);
    expect(pool.primary()).toBe(1);
    const again = pool.slot(0);
    expect(again).not.toBe(s0);
    expect(make).toHaveBeenLastCalledWith(0);
  });
});
