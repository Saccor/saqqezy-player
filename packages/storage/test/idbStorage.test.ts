import 'fake-indexeddb/auto';
import { describe, expect, test, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
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

  test('upgrades a version-2 database to version 4 (syncMeta, catalogs, chunks) and keeps every hot structure as it was', async () => {
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
    expect(db.version).toBe(4);
    expect([...db.objectStoreNames].sort()).toEqual(['catalogs', 'channels', 'chunks', 'meta', 'programmes', 'sources', 'syncMeta', 'vod', 'vodUser']);
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

/** Creates a version-3 database with legacy catalogue records and a storage-failure backoff record. */
async function makeV3(factory: IDBFactory): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const open = factory.open('iptv', 3);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore('sources', { keyPath: 'id' });
      db.createObjectStore('channels', { keyPath: 'sourceId' });
      db.createObjectStore('meta');
      db.createObjectStore('programmes', { autoIncrement: true }).createIndex('byChannel', ['sourceId', 'epgId', 'start']);
      db.createObjectStore('vod', { keyPath: ['sourceId', 'kind'] });
      db.createObjectStore('vodUser', { keyPath: ['sourceId', 'itemId'] });
      db.createObjectStore('syncMeta', { keyPath: ['scope', 'key'] });
      const tx = open.transaction!;
      tx.objectStore('channels').put({ sourceId: 's1', channels: [{ id: 's1:1', sourceId: 's1', name: 'Channel 1', url: 'http://example.test/1.ts', group: 'G', number: 1 }] });
      tx.objectStore('vod').put({ sourceId: 's1', kind: 'movie', list: { items: [{ id: 's1:m1', kind: 'movie', title: 'Synthetic Film', categoryId: '1' }], categories: [] } });
      tx.objectStore('meta').put({ count: 2, at: 1, storage: true }, 'refreshFail:s1:vod:series');
      tx.objectStore('meta').put({ count: 1, at: 1 }, 'refreshFail:s1:epg');
      tx.objectStore('meta').put({ storage: true, note: 'keep' }, 'other:s1');
    };
    open.onsuccess = () => { open.result.close(); resolve(); };
    open.onerror = () => reject(open.error);
  });
}

describe('IdbStorage v4 migration', () => {
  test('upgrade keeps legacy catalogues readable and clears storage-failure backoff only', async () => {
    const factory = new IDBFactory();
    await makeV3(factory);
    const s = new IdbStorage(factory);
    expect((await s.getChannels('s1')).map((c) => c.name)).toEqual(['Channel 1']);
    expect((await s.getVod('s1', 'movie'))!.items[0]!.title).toBe('Synthetic Film');
    expect(await s.getMeta('refreshFail:s1:vod:series')).toBeUndefined();
    expect(await s.getMeta('refreshFail:s1:epg')).toEqual({ count: 1, at: 1 });
    expect(await s.getMeta('other:s1')).toEqual({ storage: true, note: 'keep' });
    await s.settled();
  });

  test('a legacy record is rewritten in the background and its legacy copy deleted', async () => {
    const factory = new IDBFactory();
    await makeV3(factory);
    const s = new IdbStorage(factory);
    await s.getVod('s1', 'movie');
    await s.settled();
    const raw = await new Promise<number>((resolve) => {
      const open = factory.open('iptv');
      open.onsuccess = () => { const r = open.result.transaction('vod').objectStore('vod').count(); r.onsuccess = () => { open.result.close(); resolve(r.result); }; };
    });
    expect(raw).toBe(0);
    expect((await s.getVod('s1', 'movie'))!.items[0]!.title).toBe('Synthetic Film');
  });

  test('a quota failure with a legacy record of the same key deletes the legacy record and retries once', async () => {
    const factory = new IDBFactory();
    await makeV3(factory);
    const s = new IdbStorage(factory);
    const put = IDBObjectStore.prototype.put;
    let failed = false;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === 'chunks' && !failed) { failed = true; throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); }
      return put.call(this, value, key);
    });
    await s.replaceVod('s1', 'movie', { items: [{ id: 's1:m2', kind: 'movie', title: 'Newer Film', categoryId: '1' }], categories: [] });
    vi.restoreAllMocks();
    expect(failed).toBe(true);
    expect((await s.getVod('s1', 'movie'))!.items[0]!.title).toBe('Newer Film');
    expect(await rawAll(factory, 'vod')).toHaveLength(0);
  });

  test('a quota failure with no legacy record is rethrown and not retried', async () => {
    const factory = new IDBFactory();
    const s = new IdbStorage(factory);
    const put = IDBObjectStore.prototype.put;
    let attempts = 0;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === 'chunks') { attempts++; throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); }
      return put.call(this, value, key);
    });
    try {
      await expect(s.replaceVod('s1', 'movie', { items: [{ id: 's1:m2', kind: 'movie', title: 'Film', categoryId: '1' }], categories: [] })).rejects.toThrow();
    } finally {
      vi.restoreAllMocks();
    }
    expect(attempts).toBe(1);
  });

  test('two reads before the first migration commits produce one migration (generation 1, one set of chunks)', async () => {
    const factory = new IDBFactory();
    await makeV3(factory);
    const s = new IdbStorage(factory);
    await Promise.all([s.getVod('s1', 'movie'), s.getVod('s1', 'movie')]);
    await s.settled();
    const heads = await rawAll(factory, 'catalogs');
    const head = heads.find((h: any) => h.kind === 'movie') as any;
    expect(head.gen).toBe(1);
    const chunks = (await rawAll(factory, 'chunks')).filter((c: any) => c.kind === 'movie');
    expect(chunks).toHaveLength(head.chunks);
    expect(new Set(chunks.map((c: any) => c.gen))).toEqual(new Set([1]));
  });

  test('a migration queued behind a refresh never overwrites the newer list', async () => {
    const factory = new IDBFactory();
    await makeV3(factory);
    const s = new IdbStorage(factory);
    const replacing = s.replaceVod('s1', 'movie', { items: [{ id: 's1:m2', kind: 'movie', title: 'Newer Film', categoryId: '1' }], categories: [] });
    await s.getVod('s1', 'movie');
    await replacing;
    await s.settled();
    expect((await s.getVod('s1', 'movie'))!.items[0]!.title).toBe('Newer Film');
    await s.settled();
  });

  test('a failed migration is logged once with the kind and error name only', async () => {
    const factory = new IDBFactory();
    await makeV3(factory);
    const s = new IdbStorage(factory);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === 'chunks') throw new DOMException('x', 'DataError');
      return put.call(this, value, key);
    });
    try {
      await s.getVod('s1', 'movie');
      await s.settled();
    } finally {
      vi.restoreAllMocks();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Catalogue migration failed', 'movie', 'DataError');
  });
});

function rawAll(factory: IDBFactory, store: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const open = factory.open('iptv');
    open.onsuccess = () => {
      const r = open.result.transaction(store).objectStore(store).getAll();
      r.onsuccess = () => { open.result.close(); resolve(r.result); };
      r.onerror = () => reject(r.error);
    };
    open.onerror = () => reject(open.error);
  });
}

describe('IdbStorage quota hook', () => {
  const chans = Array.from({ length: 50 }, (_, i) => ({ id: `s1:${i}`, sourceId: 's1', name: `Channel ${i}`, url: `http://example.test/${i}.ts`, group: 'G', number: i }));

  test('called with the encoded size when free space is short', async () => {
    const hook = vi.fn(async () => {});
    const s = new IdbStorage(new IDBFactory(), 'iptv', 2000, { estimate: async () => ({ usage: 82e6, quota: 83.9e6 }), beforeLargeWrite: hook });
    await s.replaceChannels('s1', chans);
    expect(hook).toHaveBeenCalledOnce();
    expect((hook.mock.calls[0] as unknown as [number])[0]).toBeGreaterThan(0);
  });

  test('not called when there is room, and a failing hook never fails the write', async () => {
    const roomy = vi.fn(async () => {});
    const s1 = new IdbStorage(new IDBFactory(), 'iptv', 2000, { estimate: async () => ({ usage: 10e6, quota: 83.9e6 }), beforeLargeWrite: roomy });
    await s1.replaceChannels('s1', chans);
    expect(roomy).not.toHaveBeenCalled();
    const s2 = new IdbStorage(new IDBFactory(), 'iptv', 2000, { estimate: async () => ({ usage: 83e6, quota: 83.9e6 }), beforeLargeWrite: async () => { throw new Error('busy'); } });
    await s2.replaceChannels('s1', chans);
    expect(await s2.getChannels('s1')).toHaveLength(50);
  });
});

function rawPut(factory: IDBFactory, store: string, fn: (s: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = factory.open('iptv');
    open.onsuccess = () => {
      const tx = open.result.transaction(store, 'readwrite');
      fn(tx.objectStore(store));
      tx.oncomplete = () => { open.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
}

describe('IdbStorage resilience', () => {
  const film = { items: [{ id: 's1:m2', kind: 'movie' as const, title: 'Film', categoryId: '1' }], categories: [] };

  test('a migration in flight never resurrects a source deleted meanwhile', async () => {
    const factory = new IDBFactory();
    await makeV3(factory);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const codec = {
      async encode(text: string) { await gate; return { enc: 'none' as const, bytes: new TextEncoder().encode(text).buffer as ArrayBuffer }; },
      async decode(c: { bytes: ArrayBuffer }) { return new TextDecoder().decode(c.bytes); },
    };
    const s = new IdbStorage(factory, 'iptv', 2000, { codec });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await s.getVod('s1', 'movie');
      await s.deleteSource('s1');
      release();
      await s.settled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(await rawAll(factory, 'catalogs')).toHaveLength(0);
    expect(await rawAll(factory, 'chunks')).toHaveLength(0);
    expect(await s.getVod('s1', 'movie')).toBeUndefined();
  });

  test('an undecodable chunk reads as missing, the head is dropped, and nothing rejects', async () => {
    const factory = new IDBFactory();
    const s = new IdbStorage(factory);
    await s.replaceVod('s1', 'movie', film);
    await rawPut(factory, 'chunks', (st) => {
      const c = st.openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur) cur.update({ ...cur.value, bytes: new Uint8Array([1, 2, 3, 4]).buffer }); };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await s.getVod('s1', 'movie')).toBeUndefined();
      expect(warn).toHaveBeenCalledWith('Catalogue chunk unreadable', 'movie');
    } finally {
      warn.mockRestore();
    }
    expect(await rawAll(factory, 'catalogs')).toHaveLength(0);
    await s.replaceVod('s1', 'movie', film);
    expect((await s.getVod('s1', 'movie'))!.items[0]!.title).toBe('Film');
  });

  test('a head whose chunks are not all stored reads as missing', async () => {
    const factory = new IDBFactory();
    const s = new IdbStorage(factory, 'iptv', 2000, { chunkRows: 2 });
    const chans = Array.from({ length: 6 }, (_, i) => ({ id: `s1:${i}`, sourceId: 's1', name: `Channel ${i}`, url: `http://example.test/${i}.ts`, group: 'G', number: i }));
    await s.replaceChannels('s1', chans);
    expect(await rawAll(factory, 'chunks')).toHaveLength(3);
    await rawPut(factory, 'chunks', (st) => { st.delete(['s1', 'channels', 1, 1]); });
    expect(await s.getChannels('s1')).toEqual([]);
  });

  test('a quota hook that never resolves cannot hold the write', async () => {
    const s = new IdbStorage(new IDBFactory(), 'iptv', 2000, {
      estimate: async () => ({ usage: 83e6, quota: 83.9e6 }),
      beforeLargeWrite: () => new Promise<void>(() => undefined),
      hookTimeoutMs: 20,
    });
    await s.replaceChannels('s1', [{ id: 's1:1', sourceId: 's1', name: 'C', url: 'http://example.test/1.ts', group: 'G', number: 1 }]);
    expect(await s.getChannels('s1')).toHaveLength(1);
  });
});
