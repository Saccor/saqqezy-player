import { describe, expect, it, vi } from 'vitest';
import { createPlaybackPool, type PoolSlot } from './pool.ts';

function slot(name: string, log: string[]): PoolSlot {
  return { stop: () => { log.push(`stop:${name}`); }, dispose: () => { log.push(`dispose:${name}`); } };
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

  it('stopAll stops slot 0 first, then every extra slot, and keeps them', () => {
    const log: string[] = [];
    const pool = createPlaybackPool(slot('0', log), (n) => slot(String(n), log));
    pool.slot(2);
    pool.slot(1);
    pool.stopAll();
    expect(log).toEqual(['stop:0', 'stop:1', 'stop:2']);
    expect(pool.slots()).toHaveLength(3);
  });

  it('release stops and disposes the extra slots and forgets them; slot 0 keeps playing', () => {
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
