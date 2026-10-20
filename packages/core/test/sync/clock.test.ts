import { describe, expect, test } from 'vitest';
import { MemoryStorage } from '../../../storage/src/memoryStorage.ts';
import { CLOCK_SCOPE, SyncClock, newNodeId } from '../../src/sync/clock.ts';
import { compareHlc, decodeHlc, encodeHlc, hlcWall, isNodeId } from '../../src/sync/hlc.ts';

const T = Date.UTC(2026, 9, 20, 12);

describe('SyncClock', () => {
  test('a node id is 6 characters [0-9a-z]', () => {
    for (let i = 0; i < 50; i++) expect(isNodeId(newNodeId())).toBe(true);
  });

  test('stamp writes one stamp for all keys of a write, plus the clock state', async () => {
    const storage = new MemoryStorage();
    const clock = new SyncClock({ storage, now: () => T, nodeId: () => 'node01' });
    const t = await clock.stamp('s1', ['hc:s1:x1', 'hc:s1:x2', 'hc:s1:x1']);
    expect(decodeHlc(t!)).toEqual({ wall: T, counter: 0, node: 'node01' });
    const entries = await storage.listSyncMeta('s1');
    expect(entries.map((e) => [e.key, e.value]).sort()).toEqual([['hc:s1:x1', t], ['hc:s1:x2', t]]);
    expect(await storage.getSyncMeta(CLOCK_SCOPE, 'node')).toBe('node01');
    expect(await storage.getSyncMeta(CLOCK_SCOPE, 'last')).toBe(t);
  });

  test('no keys: no tick and no write', async () => {
    const storage = new MemoryStorage();
    const clock = new SyncClock({ storage, now: () => T, nodeId: () => 'node01' });
    expect(await clock.stamp('s1', [])).toBeUndefined();
    expect(await storage.listSyncMeta(CLOCK_SCOPE)).toEqual([]);
  });

  test('stamps grow even within one millisecond and across a restart with the clock set back', async () => {
    const storage = new MemoryStorage();
    let now = T;
    const a = new SyncClock({ storage, now: () => now, nodeId: () => 'node01' });
    const s1 = await a.stamp('s1', ['vf:s1:m1']);
    const s2 = await a.stamp('s1', ['vf:s1:m1']);
    expect(compareHlc(s2, s1)).toBeGreaterThan(0);
    now = T - 3600_000;
    // A new clock on the same storage (app restart) keeps the node id and stays ahead of the last stamp.
    const b = new SyncClock({ storage, now: () => now, nodeId: () => 'other1' });
    const s3 = await b.stamp('s1', ['vf:s1:m1']);
    expect(compareHlc(s3, s2)).toBeGreaterThan(0);
    expect(decodeHlc(s3!)!.node).toBe('node01');
  });

  test('concurrent stamps never share a stamp', async () => {
    const storage = new MemoryStorage();
    const clock = new SyncClock({ storage, now: () => T, nodeId: () => 'node01' });
    const stamps = await Promise.all([1, 2, 3, 4].map((i) => clock.stamp('s1', [`vf:s1:m${i}`])));
    expect(new Set(stamps).size).toBe(4);
    expect(await storage.getSyncMeta(CLOCK_SCOPE, 'last')).toBe([...stamps].sort()[3]);
  });

  test('receive moves the clock past a remote stamp, clamped to local + 24 h', async () => {
    const storage = new MemoryStorage();
    const clock = new SyncClock({ storage, now: () => T, nodeId: () => 'node01' });
    await clock.receive(encodeHlc({ wall: T + 365 * 24 * 3600_000, counter: 0, node: 'remote' }));
    const t = await clock.stamp('s1', ['vf:s1:m1']);
    expect(hlcWall(t!)).toBe(T + 24 * 3600_000);
  });

  test('clocks(sourceId) reads the stamps of one source', async () => {
    const storage = new MemoryStorage();
    const clock = new SyncClock({ storage, now: () => T, nodeId: () => 'node01' });
    const t = await clock.stamp('s1', ['vp:s1:m1']);
    await clock.stamp('s2', ['vp:s2:m1']);
    expect([...(await clock.clocks('s1'))]).toEqual([['vp:s1:m1', t]]);
  });

  test('a storage failure rejects the stamp but the next one works', async () => {
    const storage = new MemoryStorage();
    let fail = true;
    const put = storage.putSyncMeta.bind(storage);
    storage.putSyncMeta = async (e) => {
      if (fail) throw new Error('disk full');
      return put(e);
    };
    const clock = new SyncClock({ storage, now: () => T, nodeId: () => 'node01' });
    await expect(clock.stamp('s1', ['vf:s1:m1'])).rejects.toThrow('disk full');
    fail = false;
    expect(await clock.stamp('s1', ['vf:s1:m1'])).toBeDefined();
  });
});
