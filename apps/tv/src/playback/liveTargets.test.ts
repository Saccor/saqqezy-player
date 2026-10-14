import { describe, expect, it } from 'vitest';
import { LIVE_TARGETS_KEY, createLiveTargetStore, type StorageLike } from './liveTargets.ts';

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

const DAY = 86_400_000;

describe('liveTargets', () => {
  it('stores and reads the learned raise per source', () => {
    const m = memory();
    const store = createLiveTargetStore(() => m, () => 1000);
    expect(store.get('s1')).toBeUndefined();
    store.set('s1', 1.234);
    expect(store.get('s1')).toBe(1.23);
    expect(JSON.parse(m.data.get(LIVE_TARGETS_KEY)!)).toEqual({ s1: { r: 1.23, at: 1000 } });
  });

  it('keeps at most 32 sources, dropping the oldest', () => {
    const m = memory();
    let t = 0;
    const store = createLiveTargetStore(() => m, () => t);
    for (let i = 0; i < 33; i++) { t = i; store.set(`s${i}`, 1); }
    expect(store.get('s0')).toBeUndefined();
    expect(store.get('s1')).toBe(1);
    expect(store.get('s32')).toBe(1);
  });

  it('ignores entries older than 30 days', () => {
    const m = memory();
    let t = 0;
    const store = createLiveTargetStore(() => m, () => t);
    store.set('s1', 2);
    t = 30 * DAY;
    expect(store.get('s1')).toBeUndefined();
  });

  it('never throws: missing, broken or throwing storage behaves as empty', () => {
    const broken: StorageLike = { getItem: () => '{not json', setItem: () => { throw new Error('quota'); } };
    const throwing: StorageLike = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    for (const s of [() => undefined, () => broken, () => throwing]) {
      const store = createLiveTargetStore(s);
      expect(() => store.set('s1', 1)).not.toThrow();
      expect(store.get('s1')).toBeUndefined();
    }
  });
});
