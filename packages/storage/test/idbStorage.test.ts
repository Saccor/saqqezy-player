import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
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

  test('reopening an existing database keeps its data (no store re-creation)', async () => {
    const factory = new IDBFactory();
    const a = new IdbStorage(factory, 'reopen-db');
    await a.setMeta('k', 1);
    const b = new IdbStorage(factory, 'reopen-db');
    expect(await b.getMeta('k')).toBe(1);
  });
});
