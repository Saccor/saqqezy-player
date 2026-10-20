import { describe, expect, test } from 'vitest';
import { encodeHlc, hlcWall } from '../../src/sync/hlc.ts';
import {
  TOMBSTONE_TTL_MS, clampStamp, isTombstone, lwwRegister, members, mergeElementSet, mergeLwwMap, mergeOrder, mergeRecords, pruneTombstones,
  type Stamped,
} from '../../src/sync/merge.ts';
import { registerKey, type SyncRecord } from '../../src/sync/types.ts';

const T = Date.UTC(2026, 9, 20, 12);
const DAY = 24 * 3600_000;
const t = (wall: number, node = 'nodeaa', counter = 0) => encodeHlc({ wall, counter, node });
const s = <V>(wall: number, v: V, node = 'nodeaa'): Stamped<V> => ({ t: t(wall, node), v });

describe('LWW register', () => {
  test('the later stamp wins; a missing side loses', () => {
    expect(lwwRegister(s(T, 'a'), s(T + 1, 'b'))).toEqual(s(T + 1, 'b'));
    expect(lwwRegister(s(T + 1, 'a'), s(T, 'b'))).toEqual(s(T + 1, 'a'));
    expect(lwwRegister(undefined, s(T, 'b'))).toEqual(s(T, 'b'));
    expect(lwwRegister(s(T, 'a'), undefined)).toEqual(s(T, 'a'));
  });

  test('same wall time: the node id decides, the same on every device', () => {
    const a = s(T, 'a', 'nodeaa');
    const b = s(T, 'b', 'nodebb');
    expect(lwwRegister(a, b)).toEqual(b);
    expect(lwwRegister(b, a)).toEqual(b);
  });

  test('an identical stamp keeps the local value', () => {
    expect(lwwRegister(s(T, 'local'), s(T, 'remote'))).toEqual(s(T, 'local'));
  });
});

describe('LWW element set', () => {
  test('add, remove and re-add resolve per element by stamp', () => {
    const local = new Map([['x1', s(T, true)], ['x2', s(T, true)], ['x3', s(T + 5, false)]]);
    const remote = new Map([['x1', s(T + 1, false)], ['x2', s(T - 1, false)], ['x3', s(T + 6, true)], ['x4', s(T, true)]]);
    const merged = mergeElementSet(local, remote);
    expect(members(merged).sort()).toEqual(['x2', 'x3', 'x4']);
    expect(merged.get('x1')).toEqual(s(T + 1, false));
    // Inputs are not changed.
    expect(local.get('x1')).toEqual(s(T, true));
  });

  test('merging is commutative and idempotent', () => {
    const a = new Map([['x1', s(T, true)], ['x2', s(T + 2, false, 'nodeaa')]]);
    const b = new Map([['x1', s(T + 1, false)], ['x2', s(T + 2, true, 'nodebb')]]);
    expect(members(mergeElementSet(a, b)).sort()).toEqual(members(mergeElementSet(b, a)).sort());
    const ab = mergeElementSet(a, b);
    expect(mergeElementSet(ab, b)).toEqual(ab);
  });
});

describe('LWW map (renames)', () => {
  test('per key; null removes a rename and wins when newer', () => {
    const local = new Map([['s:a', s<string | null>(T, 'Morning desk')], ['s:b', s<string | null>(T, 'Evening desk')]]);
    const remote = new Map([['s:a', s<string | null>(T + 1, null)], ['s:b', s<string | null>(T - 1, 'Old')], ['s:c', s<string | null>(T, 'New')]]);
    const m = mergeLwwMap(local, remote);
    expect(m.get('s:a')!.v).toBeNull();
    expect(m.get('s:b')!.v).toBe('Evening desk');
    expect(m.get('s:c')!.v).toBe('New');
  });
});

describe('whole-array LWW (orders)', () => {
  test('the newer array replaces the other, never interleaved', () => {
    expect(mergeOrder(s(T, ['g:A', 'g:B']), s(T + 1, ['g:C']))).toEqual(s(T + 1, ['g:C']));
    expect(mergeOrder(s(T + 1, ['g:A', 'g:B']), s(T, ['g:C']))).toEqual(s(T + 1, ['g:A', 'g:B']));
  });
});

describe('tombstones', () => {
  test('element removals and map clears are tombstones; a false setting or hideNoEpg is a value', () => {
    expect(isTombstone({ k: 'hc', v: false })).toBe(true);
    expect(isTombstone({ k: 'lm', v: false })).toBe(true);
    expect(isTombstone({ k: 'cn', v: null })).toBe(true);
    expect(isTombstone({ k: 'ln', v: null })).toBe(true);
    expect(isTombstone({ k: 'hc', v: true })).toBe(false);
    expect(isTombstone({ k: 'ne', v: false })).toBe(false);
    expect(isTombstone({ k: 'st', v: false })).toBe(false);
  });

  test('pruned after 90 days; newer tombstones and live values stay', () => {
    const set = new Map([
      ['old-off', s(T - TOMBSTONE_TTL_MS - 1, false)],
      ['old-on', s(T - 200 * DAY, true)],
      ['new-off', s(T - 89 * DAY, false)],
    ]);
    expect([...pruneTombstones(set, T, (v) => v === false).keys()].sort()).toEqual(['new-off', 'old-on']);
  });
});

describe('remote clock clamp', () => {
  test('a stamp more than 24 h ahead is capped at local + 24 h; malformed stamps are dropped', () => {
    const far = t(T + 400 * DAY, 'remote');
    expect(hlcWall(clampStamp(far, T)!)).toBe(T + DAY);
    expect(clampStamp(t(T + 3600_000), T)).toBe(t(T + 3600_000));
    expect(clampStamp('nonsense', T)).toBeUndefined();
  });
});

describe('mergeRecords', () => {
  const progress = (wall: number, p: number, sid = 'm1', node = 'nodeaa'): SyncRecord =>
    ({ k: 'vp', ref: { sfp: 'FP', sid, pk: 't:42' }, t: t(wall, node), v: { p, d: 7200_000, w: false } });
  const local = (...rs: SyncRecord[]) => new Map(rs.map((r) => [registerKey(r), r]));

  test('progress is last writer wins, not furthest: a later rewatch at 2 min beats an older 90 min', () => {
    const l = local(progress(T, 90 * 60_000));
    const r = mergeRecords(l, [progress(T + 1000, 2 * 60_000, 'm1', 'nodebb')], T);
    expect(r.apply).toEqual([progress(T + 1000, 2 * 60_000, 'm1', 'nodebb')]);
    const older = mergeRecords(l, [progress(T - 1000, 100 * 60_000)], T);
    expect(older.apply).toEqual([]);
  });

  test('progress on another version of the same title is the same register (group key)', () => {
    const l = local(progress(T, 30 * 60_000, 'm1'));
    const r = mergeRecords(l, [progress(T + 1, 40 * 60_000, 'm2', 'nodebb')], T);
    expect(r.apply).toHaveLength(1);
    expect(r.state.size).toBe(1);
    expect([...r.state.values()][0]!.ref.sid).toBe('m2');
  });

  test('a far-future remote write is clamped, so a later local write beats it again', () => {
    const remote = progress(T + 365 * DAY, 10 * 60_000, 'm1', 'nodebb');
    const r = mergeRecords(new Map(), [remote], T);
    expect(hlcWall(r.apply[0]!.t)).toBe(T + DAY);
    const later = mergeRecords(r.state, [progress(T + DAY + 1, 20 * 60_000)], T + DAY);
    expect(later.apply).toHaveLength(1);
  });

  test('several remote writes to one register: only the newest is applied', () => {
    const r = mergeRecords(new Map(), [progress(T + 2, 3), progress(T + 5, 5), progress(T + 1, 9)], T);
    expect(r.apply).toEqual([progress(T + 5, 5)]);
  });

  test('records of different kinds or sources never collide', () => {
    const fav: SyncRecord = { k: 'vf', ref: { sfp: 'FP', sid: 'm1', pk: 't:42' }, t: t(T), v: true };
    const other: SyncRecord = { ...fav, ref: { ...fav.ref, sfp: 'FP2' } };
    const r = mergeRecords(local(progress(T, 1)), [fav, other], T);
    expect(r.apply).toHaveLength(2);
    expect(r.state.size).toBe(3);
  });
});
