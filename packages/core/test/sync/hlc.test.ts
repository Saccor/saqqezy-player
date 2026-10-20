import { describe, expect, test } from 'vitest';
import {
  HLC_COUNTER_MAX, HLC_MAX_DRIFT_MS, clampRemote, compareHlc, decodeHlc, encodeHlc, hlcWall, receiveHlc, tickHlc,
} from '../../src/sync/hlc.ts';

const T = Date.UTC(2026, 9, 20, 12);
const node = 'abc123';

describe('hybrid logical clock', () => {
  test('encodes to a fixed-width string and decodes back', () => {
    const h = { wall: T, counter: 7, node };
    const s = encodeHlc(h);
    expect(s).toHaveLength(17);
    expect(decodeHlc(s)).toEqual(h);
    expect(hlcWall(s)).toBe(T);
  });

  test('rejects malformed stamps', () => {
    for (const bad of ['', 'x', 'zzzzzzzzzzzzzzzzzz', encodeHlc({ wall: T, counter: 0, node }).toUpperCase(), 42]) {
      expect(decodeHlc(bad as string)).toBeUndefined();
    }
  });

  test('string order is clock order (wall, then counter, then node)', () => {
    const a = encodeHlc({ wall: T, counter: 1, node: 'zzzzzz' });
    const b = encodeHlc({ wall: T, counter: 2, node: 'aaaaaa' });
    const c = encodeHlc({ wall: T + 1, counter: 0, node: 'aaaaaa' });
    const d = encodeHlc({ wall: T + 1, counter: 0, node: 'aaaaab' });
    expect([d, c, b, a].sort()).toEqual([a, b, c, d]);
    expect(compareHlc(a, b)).toBeLessThan(0);
    expect(compareHlc(d, c)).toBeGreaterThan(0);
    expect(compareHlc(a, a)).toBe(0);
    // A missing stamp is older than any stamp.
    expect(compareHlc(undefined, a)).toBeLessThan(0);
    expect(compareHlc(undefined, undefined)).toBe(0);
  });

  test('tick follows the wall clock and counts within one millisecond', () => {
    const a = tickHlc(undefined, T, node);
    expect(a).toEqual({ wall: T, counter: 0, node });
    const b = tickHlc(a, T, node);
    expect(b).toEqual({ wall: T, counter: 1, node });
    expect(tickHlc(b, T + 5, node)).toEqual({ wall: T + 5, counter: 0, node });
  });

  test('tick stays monotonic when the wall clock goes backwards', () => {
    const a = tickHlc(undefined, T, node);
    const b = tickHlc(a, T - 60_000, node);
    expect(compareHlc(encodeHlc(b), encodeHlc(a))).toBeGreaterThan(0);
    expect(b.wall).toBe(T);
  });

  test('a full counter moves on to the next millisecond', () => {
    const full = { wall: T, counter: HLC_COUNTER_MAX, node };
    expect(tickHlc(full, T, node)).toEqual({ wall: T + 1, counter: 0, node });
  });

  test('receive moves past a remote stamp', () => {
    const local = tickHlc(undefined, T, node);
    const remote = { wall: T + 1000, counter: 3, node: 'remote' };
    const next = receiveHlc(local, remote, T, node);
    expect(compareHlc(encodeHlc(next), encodeHlc(remote))).toBeGreaterThan(0);
    expect(next).toEqual({ wall: T + 1000, counter: 4, node });
    // An older remote stamp just ticks.
    expect(receiveHlc(next, { wall: T, counter: 0, node: 'remote' }, T, node)).toEqual({ wall: T + 1000, counter: 5, node });
  });

  test('a remote wall time more than 24 h ahead is clamped to local + 24 h', () => {
    const far = { wall: T + 30 * 24 * 3600_000, counter: 9, node: 'remote' };
    expect(clampRemote(far, T)).toEqual({ wall: T + HLC_MAX_DRIFT_MS, counter: 0, node: 'remote' });
    const near = { wall: T + 3600_000, counter: 9, node: 'remote' };
    expect(clampRemote(near, T)).toEqual(near);
    const next = receiveHlc(undefined, far, T, node);
    expect(next.wall).toBe(T + HLC_MAX_DRIFT_MS);
  });
});
