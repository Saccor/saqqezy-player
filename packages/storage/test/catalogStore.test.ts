import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import type { Channel, VodList } from '@iptv/core';
import { IdbStorage } from '../src/idbStorage.ts';

const chan = (n: number): Channel => ({
  id: `s1:${n}`, sourceId: 's1', name: `Channel ${n}`, url: `http://example.test/live/u/p/${n}.ts`, group: `G${n % 7}`, number: n,
  ...(n % 3 === 0 ? { logo: `http://img.example.test/logos/${n}.png` } : {}),
});
const movies = (n: number): VodList => ({
  items: Array.from({ length: n }, (_, i) => ({ id: `s1:m${i}`, kind: 'movie' as const, title: `Synthetic Film ${i}`, categoryId: String(i % 5), xid: i, poster: `https://img.example.test/p/${i}.jpg` })),
  categories: Array.from({ length: 5 }, (_, i) => ({ id: String(i), kind: 'movie' as const, name: `Cat ${i}`, count: Math.ceil(n / 5) })),
  truncated: true,
});

async function rawCount(factory: IDBFactory, store: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const open = factory.open('iptv');
    open.onsuccess = () => {
      const r = open.result.transaction(store).objectStore(store).count();
      r.onsuccess = () => { open.result.close(); resolve(r.result); };
      r.onerror = () => reject(r.error);
    };
    open.onerror = () => reject(open.error);
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('chunked catalogues', () => {
  test('channels above one chunk round-trip and are split into chunks', async () => {
    const factory = new IDBFactory();
    const s = new IdbStorage(factory, 'iptv', 2000, { chunkRows: 100 });
    const list = Array.from({ length: 250 }, (_, i) => chan(i + 1));
    await s.replaceChannels('s1', list);
    expect(await s.getChannels('s1')).toEqual(list);
    expect(await rawCount(factory, 'chunks')).toBe(3);
    expect(await rawCount(factory, 'channels')).toBe(0);
  });

  test('VOD lists keep categories and flags; movies and series are separate', async () => {
    const s = new IdbStorage(new IDBFactory(), 'iptv', 2000, { chunkRows: 100 });
    const list = movies(230);
    const series: VodList = { items: [{ id: 's1:s1', kind: 'series', title: 'Synthetic Show', categoryId: '9' }], categories: [{ id: '9', kind: 'series', name: 'Drama', count: 1 }] };
    await s.replaceVod('s1', 'movie', list);
    await s.replaceVod('s1', 'series', series);
    expect(await s.getVod('s1', 'movie')).toEqual(list);
    expect(await s.getVod('s1', 'series')).toEqual(series);
    expect(await s.getVod('s2', 'movie')).toBeUndefined();
  });

  test('a new generation replaces the old one and its chunks are deleted', async () => {
    const factory = new IDBFactory();
    const s = new IdbStorage(factory, 'iptv', 2000, { chunkRows: 100 });
    await s.replaceVod('s1', 'movie', movies(250));
    await s.replaceVod('s1', 'movie', movies(120));
    expect((await s.getVod('s1', 'movie'))!.items).toHaveLength(120);
    expect(await rawCount(factory, 'chunks')).toBe(2);
  });

  test('a write that fails midway leaves the old catalogue readable and no new chunks behind', async () => {
    const factory = new IDBFactory();
    const s = new IdbStorage(factory, 'iptv', 2000, { chunkRows: 100 });
    await s.replaceVod('s1', 'movie', movies(150));
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === 'chunks' && (value as { gen?: number; n?: number }).gen === 2 && (value as { n?: number }).n === 1) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      return put.call(this, value, key);
    });
    await expect(s.replaceVod('s1', 'movie', movies(300))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    vi.restoreAllMocks();
    expect((await s.getVod('s1', 'movie'))!.items).toHaveLength(150);
    expect(await rawCount(factory, 'chunks')).toBe(2);
  });

  test('an empty catalogue is stored and read back', async () => {
    const s = new IdbStorage(new IDBFactory());
    await s.replaceChannels('s1', []);
    expect(await s.getChannels('s1')).toEqual([]);
  });

  test('deleteSource and clearAll remove catalogues and chunks', async () => {
    const factory = new IDBFactory();
    const s = new IdbStorage(factory, 'iptv', 2000, { chunkRows: 100 });
    await s.replaceChannels('s1', [chan(1)]);
    await s.replaceChannels('s2', [{ ...chan(1), id: 's2:1', sourceId: 's2' }]);
    await s.deleteSource('s1');
    expect(await s.getChannels('s1')).toEqual([]);
    expect(await s.getChannels('s2')).toHaveLength(1);
    await s.clearAll();
    expect(await s.getChannels('s2')).toEqual([]);
    expect(await rawCount(factory, 'chunks')).toBe(0);
    expect(await rawCount(factory, 'catalogs')).toBe(0);
  });
});
