import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { ThumbStore } from './thumbStore.ts';

const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill).buffer;

describe('ThumbStore', () => {
  it('reads back what it stored, and misses an unknown key', async () => {
    const s = new ThumbStore(new IDBFactory(), 1000);
    await s.put('a', 'image/webp', bytes(10, 7));
    const r = await s.get('a');
    expect(r?.type).toBe('image/webp');
    expect(new Uint8Array(r!.bytes)[0]).toBe(7);
    expect(await s.get('b')).toBeUndefined();
  });

  it('past the cap drops the least recently used copies down to 80 %', async () => {
    let t = 0;
    const s = new ThumbStore(new IDBFactory(), 1000, () => t);
    for (const k of ['a', 'b', 'c', 'd']) { t += 1; await s.put(k, 'image/webp', bytes(240)); }
    // 960 bytes; one more makes 1200 > 1000: the oldest go until at most 800 remain.
    t += 1;
    await s.put('e', 'image/webp', bytes(240));
    expect(await s.get('a')).toBeUndefined();
    expect(await s.get('b')).toBeUndefined();
    expect(await s.get('c')).toBeDefined();
    expect(await s.get('e')).toBeDefined();
  });

  it('a hit an hour old counts as recent use, so it outlives newer copies', async () => {
    let t = 0;
    const s = new ThumbStore(new IDBFactory(), 1000, () => t);
    await s.put('old', 'image/webp', bytes(250));
    t = 10; await s.put('mid', 'image/webp', bytes(250));
    t = 2 * 60 * 60 * 1000;
    await s.get('old');
    await new Promise((r) => setTimeout(r, 10));
    t += 1; await s.put('new', 'image/webp', bytes(250));
    t += 1; await s.put('newer', 'image/webp', bytes(250));
    // 1001 bytes: dropping the least recently used one (mid, not the touched old one) is enough.
    t += 1; await s.put('tiny', 'image/webp', bytes(1));
    expect(await s.get('mid')).toBeUndefined();
    expect(await s.get('old')).toBeDefined();
  });

  it('replacing a key does not count its old size twice', async () => {
    const s = new ThumbStore(new IDBFactory(), 1000);
    for (let i = 0; i < 10; i += 1) await s.put('a', 'image/webp', bytes(240));
    await s.put('b', 'image/webp', bytes(240));
    expect(await s.get('a')).toBeDefined();
    expect(await s.get('b')).toBeDefined();
  });

  it('skips empty and oversized copies, and works as a miss without IndexedDB', async () => {
    const s = new ThumbStore(new IDBFactory(), 1000);
    await s.put('big', 'image/webp', bytes(400));
    await s.put('empty', 'image/webp', bytes(0));
    expect(await s.get('big')).toBeUndefined();
    expect(await s.get('empty')).toBeUndefined();
    const none = new ThumbStore(undefined);
    await none.put('a', 'image/webp', bytes(1));
    expect(await none.get('a')).toBeUndefined();
  });

  it('clear removes everything', async () => {
    const s = new ThumbStore(new IDBFactory(), 1000);
    await s.put('a', 'image/webp', bytes(10));
    await s.clear();
    expect(await s.get('a')).toBeUndefined();
  });
});
