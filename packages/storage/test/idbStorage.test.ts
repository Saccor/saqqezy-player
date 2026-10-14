import 'fake-indexeddb/auto';
import { describe, expect, test, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { IdbStorage } from '../src/idbStorage.ts';
import { storageContract } from './storageContract.ts';

storageContract('indexeddb', () => new IdbStorage(new IDBFactory()));

describe('IdbStorage open', () => {
  test('a blocked open rejects with a clear error and the next call opens again', async () => {
    let opens = 0;
    const blocked = {
      open: () => {
        opens++;
        const r: { onblocked?: () => void } = {};
        queueMicrotask(() => r.onblocked?.());
        return r;
      },
    } as unknown as IDBFactory;
    const s = new IdbStorage(blocked, 'blocked-db');
    await expect(s.listSources()).rejects.toThrow('Close the app in other tabs');
    await expect(s.listSources()).rejects.toThrow('Close the app in other tabs');
    expect(opens).toBe(2);
  });

  test('deleteSource walks meta keys without reading values (large title index records)', async () => {
    const s = new IdbStorage(new IDBFactory(), 'delete-keys-db');
    await s.putSource({ id: 's1', kind: 'm3u', name: 'A', playlistUrl: 'http://example.test/a.m3u' });
    await s.setMeta('titleIndex:s1', { gen: 1, data: { haystack: 'x'.repeat(1000) } });
    await s.setMeta('epgGen:s1', 1);
    await s.setMeta('epgGen:s2', 2);
    const valueCursor = vi.spyOn(IDBObjectStore.prototype, 'openCursor');
    try {
      await s.deleteSource('s1');
      const metaValueCursors = valueCursor.mock.contexts.filter((c) => (c as IDBObjectStore).name === 'meta');
      expect(metaValueCursors).toHaveLength(0);
    } finally {
      valueCursor.mockRestore();
    }
    expect(await s.getMeta('titleIndex:s1')).toBeUndefined();
    expect(await s.getMeta('epgGen:s1')).toBeUndefined();
    expect(await s.getMeta('epgGen:s2')).toBe(2);
  });

  test('reopening an existing database keeps its data (no store re-creation)', async () => {
    const factory = new IDBFactory();
    const a = new IdbStorage(factory, 'reopen-db');
    await a.setMeta('k', 1);
    const b = new IdbStorage(factory, 'reopen-db');
    expect(await b.getMeta('k')).toBe(1);
  });
});
