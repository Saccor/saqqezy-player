import 'fake-indexeddb/auto';
import { describe, expect, test, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { IdbStorage, done, req } from '../src/idbStorage.ts';
import { storageContract } from './storageContract.ts';

storageContract('indexeddb', () => new IdbStorage(new IDBFactory()));

describe('IdbStorage clearProgrammes', () => {
  test('deletes in short transactions, so a guide read started meanwhile does not wait for the whole clear', async () => {
    const s = new IdbStorage(new IDBFactory(), 'iptv', 3);
    const progs = (n: number) => Array.from({ length: n }, (_, i) => ({ epgId: 'a', start: i * 60_000, stop: (i + 1) * 60_000, title: `p${i}` }));
    await s.addProgrammes('old', progs(30));
    await s.addProgrammes('live', progs(2));
    const order: string[] = [];
    const clearing = s.clearProgrammes('old').then(() => order.push('clear'));
    await Promise.resolve();
    const reading = s.getProgrammes('live', ['a'], 0, 10 * 60_000).then((got) => { order.push('read'); return got; });
    expect(await reading).toHaveLength(2);
    await clearing;
    expect(order).toEqual(['read', 'clear']);
    expect(await s.getProgrammes('old', ['a'], 0, 60 * 60_000)).toEqual([]);
    expect(await s.getProgrammes('live', ['a'], 0, 10 * 60_000)).toHaveLength(2);
  });
});

describe('IdbStorage open', () => {
  test('upgrades a version-1 database to version 2 and keeps its data', async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const open = factory.open('upgrade-db', 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        db.createObjectStore('sources', { keyPath: 'id' });
        db.createObjectStore('channels', { keyPath: 'sourceId' });
        db.createObjectStore('meta');
        db.createObjectStore('programmes', { autoIncrement: true }).createIndex('byChannel', ['sourceId', 'epgId', 'start']);
        open.transaction!.objectStore('sources').put({ id: 's1', kind: 'm3u', name: 'Old', playlistUrl: 'http://example.test/a.m3u' });
      };
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
      open.onerror = () => reject(open.error);
    });
    const s = new IdbStorage(factory, 'upgrade-db');
    expect((await s.listSources()).map((x) => x.name)).toEqual(['Old']);
    await s.replaceVod('s1', 'movie', { items: [], categories: [] });
    expect(await s.getVod('s1', 'movie')).toEqual({ items: [], categories: [] });
  });

  test('upgrades a version-2 database to version 3 (syncMeta) and keeps every hot structure as it was', async () => {
    const factory = new IDBFactory();
    const layout = { version: 4, lists: [], hiddenChannels: ['s1:x1'], hiddenGroups: [], groupOrder: [], channelOrder: {}, channelNames: {}, groupNames: {}, sort: {}, hideNoEpg: false, recent: [] };
    const state = { position: 120_000, duration: 3600_000, watched: false, favourite: true, updatedAt: 5 };
    await new Promise<void>((resolve, reject) => {
      const open = factory.open('upgrade-v2-db', 2);
      open.onupgradeneeded = () => {
        const db = open.result;
        db.createObjectStore('sources', { keyPath: 'id' });
        db.createObjectStore('channels', { keyPath: 'sourceId' });
        db.createObjectStore('meta');
        db.createObjectStore('programmes', { autoIncrement: true }).createIndex('byChannel', ['sourceId', 'epgId', 'start']);
        db.createObjectStore('vod', { keyPath: ['sourceId', 'kind'] });
        db.createObjectStore('vodUser', { keyPath: ['sourceId', 'itemId'] });
        const tx = open.transaction!;
        tx.objectStore('sources').put({ id: 's1', kind: 'm3u', name: 'Old', playlistUrl: 'http://example.test/a.m3u' });
        tx.objectStore('meta').put(layout, 'layout:s1');
        tx.objectStore('vodUser').put({ sourceId: 's1', itemId: 's1:m1', state });
      };
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
      open.onerror = () => reject(open.error);
    });
    const s = new IdbStorage(factory, 'upgrade-v2-db');
    expect((await s.listSources()).map((x) => x.name)).toEqual(['Old']);
    expect(await s.getMeta('layout:s1')).toEqual(layout);
    expect(await s.getVodUser('s1', 's1:m1')).toEqual(state);
    expect(await s.listSyncMeta('s1')).toEqual([]);
    await s.putSyncMeta([{ scope: 's1', key: 'vf:s1:m1', value: 'x' }]);
    expect(await s.getSyncMeta('s1', 'vf:s1:m1')).toBe('x');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open('upgrade-v2-db');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    expect(db.version).toBe(3);
    expect([...db.objectStoreNames].sort()).toEqual(['channels', 'meta', 'programmes', 'sources', 'syncMeta', 'vod', 'vodUser']);
    db.close();
  });

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

describe('IdbStorage error names', () => {
  const fakeTx = (error: unknown) => {
    const tx: Record<string, any> = { error };
    return tx as unknown as IDBTransaction & { onabort: () => void };
  };

  test('an aborted transaction with an empty-message error keeps its name and is never blank', async () => {
    const tx = fakeTx(new DOMException('', 'QuotaExceededError'));
    const p = done(tx);
    tx.onabort!();
    const err = await p.catch((e: unknown) => e) as Error;
    expect(err.name).toBe('QuotaExceededError');
    expect(err.message).toBe('IndexedDB QuotaExceededError');
  });

  test('a message that is present is kept as is', async () => {
    const tx = fakeTx(new DOMException('disk is full', 'QuotaExceededError'));
    const p = done(tx);
    tx.onabort!();
    const err = await p.catch((e: unknown) => e) as Error;
    expect(err.name).toBe('QuotaExceededError');
    expect(err.message).toBe('disk is full');
  });

  test('an abort without any error is named AbortError', async () => {
    const tx = fakeTx(null);
    const p = done(tx);
    tx.onabort!();
    const err = await p.catch((e: unknown) => e) as Error;
    expect(err.name).toBe('AbortError');
    expect(err.message).toBe('IndexedDB AbortError');
  });

  test('a failed request with an empty message is named too', async () => {
    const r: Record<string, any> = { error: new DOMException('', 'ConstraintError') };
    const p = req(r as unknown as IDBRequest);
    r.onerror();
    const err = await p.catch((e: unknown) => e) as Error;
    expect(err.name).toBe('ConstraintError');
    expect(err.message).toBe('IndexedDB ConstraintError');
  });
});
