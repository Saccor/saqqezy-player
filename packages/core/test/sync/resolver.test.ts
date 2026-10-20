import { describe, expect, test } from 'vitest';
import { MemoryStorage } from '../../../storage/src/memoryStorage.ts';
import type { SourceConfig } from '../../src/types.ts';
import { encodeHlc } from '../../src/sync/hlc.ts';
import { PENDING_SCOPE, PendingStore } from '../../src/sync/pending.ts';
import { deriveFingerprintKey, sourceFingerprint } from '../../src/sync/ref.ts';
import { RefResolver, buildResolver, resolveVodTarget } from '../../src/sync/resolver.ts';
import type { SyncRecord } from '../../src/sync/types.ts';

const T = Date.UTC(2026, 9, 20, 12);
const DAY = 24 * 3600_000;
const t = (wall: number, node = 'node01') => encodeHlc({ wall, counter: 0, node });
const xt = (id: string, username: string): SourceConfig =>
  ({ kind: 'xtream', id, name: 'Mine', server: 'panel.example.test', username, password: 'pw' });

describe('RefResolver', () => {
  test('maps refs to local ids for a known fingerprint, and local ids to refs', () => {
    const r = new RefResolver([{ sourceId: 'a1', sfp: 'FP_A' }]);
    expect(r.ref('a1', 'a1:x101')).toEqual({ sfp: 'FP_A', sid: 'x101' });
    expect(r.ref('a1', 'a1:m5', 't:42')).toEqual({ sfp: 'FP_A', sid: 'm5', pk: 't:42' });
    expect(r.ref('zz', 'zz:x1')).toBeUndefined();
    expect(r.sourcesOf('FP_A')).toEqual(['a1']);
    expect(r.sourcesOf('FP_B')).toEqual([]);
    expect(r.localId('a1', { sfp: 'FP_A', sid: 'x101' })).toBe('a1:x101');
  });

  test('buildResolver fingerprints the sources on device; the same account on two devices gives the same ref', async () => {
    const k = await deriveFingerprintKey(new Uint8Array(32).fill(7));
    const tv1 = await buildResolver(k, [xt('rnd111', 'viewer01')]);
    const tv2 = await buildResolver(k, [xt('rnd999', 'viewer01'), xt('rnd222', 'viewer02')]);
    const ref = tv1.ref('rnd111', 'rnd111:x5')!;
    expect(ref.sfp).toBe(await sourceFingerprint(k, xt('any', 'viewer01')));
    expect(tv2.sourcesOf(ref.sfp)).toEqual(['rnd999']);
    expect(tv2.localId('rnd999', ref)).toBe('rnd999:x5');
  });
});

describe('resolveVodTarget (group-level resume, version secondary)', () => {
  const view = {
    has: (id: string) => ['a1:m1', 'a1:m2', 'a1:m3'].includes(id),
    members: (pk: string) => (pk === 't:42' ? ['a1:m2', 'a1:m3'] : undefined),
    pick: (pk: string) => (pk === 't:42' ? 'a1:m3' : undefined),
  };
  test('the exact version when it exists here', () => {
    expect(resolveVodTarget('a1', { sfp: 'F', sid: 'm2', pk: 't:42' }, view)).toBe('a1:m2');
  });
  test("else the user's version pick of the title, else its first version", () => {
    expect(resolveVodTarget('a1', { sfp: 'F', sid: 'm9', pk: 't:42' }, view)).toBe('a1:m3');
    expect(resolveVodTarget('a1', { sfp: 'F', sid: 'm9', pk: 't:42' }, { ...view, pick: () => undefined })).toBe('a1:m2');
  });
  test('else nothing: the record stays pending', () => {
    expect(resolveVodTarget('a1', { sfp: 'F', sid: 'm9', pk: 't:77' }, view)).toBeUndefined();
    expect(resolveVodTarget('a1', { sfp: 'F', sid: 'm9' }, view)).toBeUndefined();
  });
});

describe('PendingStore', () => {
  const rec = (sfp: string, sid: string, wall: number, v: SyncRecord['v'] = true, k: SyncRecord['k'] = 'hc'): SyncRecord =>
    ({ k, ref: { sfp, sid }, t: t(wall), v });

  test('keeps unmatched records until a source with that fingerprint takes them', async () => {
    const storage = new MemoryStorage();
    const p = new PendingStore(storage);
    await p.add([rec('FP_A', 'x1', T), rec('FP_B', 'x2', T)]);
    expect((await storage.listSyncMeta(PENDING_SCOPE)).length).toBe(2);
    expect(await p.take('FP_C')).toEqual([]);
    expect(await p.take('FP_A')).toEqual([rec('FP_A', 'x1', T)]);
    expect(await p.take('FP_A')).toEqual([]);
    expect(await p.count()).toBe(1);
  });

  test('one record per register, the newest stamp wins', async () => {
    const p = new PendingStore(new MemoryStorage());
    await p.add([rec('FP_A', 'x1', T + 10, true)]);
    await p.add([rec('FP_A', 'x1', T, false), rec('FP_A', 'x1', T + 20, false)]);
    expect(await p.take('FP_A')).toEqual([rec('FP_A', 'x1', T + 20, false)]);
  });

  test('tombstones older than 90 days are pruned; live values stay', async () => {
    const p = new PendingStore(new MemoryStorage());
    await p.add([rec('FP_A', 'x1', T - 91 * DAY, false), rec('FP_A', 'x2', T - 91 * DAY, true), rec('FP_A', 'x3', T - 10 * DAY, false)]);
    expect(await p.prune(T)).toBe(1);
    expect((await p.take('FP_A')).map((r) => r.ref.sid).sort()).toEqual(['x2', 'x3']);
  });

  test('past the cap, the oldest records go', async () => {
    const p = new PendingStore(new MemoryStorage(), { max: 3 });
    await p.add([1, 2, 3, 4, 5].map((i) => rec('FP_A', `x${i}`, T + i)));
    expect((await p.take('FP_A')).map((r) => r.ref.sid).sort()).toEqual(['x3', 'x4', 'x5']);
  });
});
