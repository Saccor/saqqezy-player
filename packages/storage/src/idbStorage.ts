import {
  MAX_PROGRAMME_MS,
  type Channel, type Programme, type SourceConfig, type Storage, type VodKind, type VodList, type VodUserRecord, type VodUserState,
} from '@iptv/core';

const DB_VERSION = 2;
const ALL_STORES = ['sources', 'channels', 'meta', 'programmes', 'vod', 'vodUser'];
type ProgRecord = Programme & { sourceId: string };

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export class IdbStorage implements Storage {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory = indexedDB, private readonly dbName = 'iptv') {}

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        let settled = false;
        const fail = (err: unknown) => {
          if (settled) return;
          settled = true;
          this.dbPromise = null;
          reject(err);
        };
        const open = this.factory.open(this.dbName, DB_VERSION);
        open.onupgradeneeded = (e: IDBVersionChangeEvent) => {
          const db = open.result;
          // One step per schema version, so a later upgrade never re-creates existing stores.
          if (e.oldVersion < 1) {
            db.createObjectStore('sources', { keyPath: 'id' });
            db.createObjectStore('channels', { keyPath: 'sourceId' });
            db.createObjectStore('meta');
            const progs = db.createObjectStore('programmes', { autoIncrement: true });
            progs.createIndex('byChannel', ['sourceId', 'epgId', 'start']);
          }
          if (e.oldVersion < 2) {
            db.createObjectStore('vod', { keyPath: ['sourceId', 'kind'] });
            db.createObjectStore('vodUser', { keyPath: ['sourceId', 'itemId'] });
          }
        };
        // Another tab holds an older version open and does not let go: fail now instead of waiting forever.
        open.onblocked = () => {
          fail(new Error('The app is open in another tab. Close the app in other tabs and try again.'));
        };
        open.onsuccess = () => {
          const db = open.result;
          // Opened after all, but the caller already got the "blocked" error: let the connection go.
          if (settled) {
            db.close();
            return;
          }
          settled = true;
          db.onversionchange = () => {
            db.close();
            this.dbPromise = null;
          };
          resolve(db);
        };
        open.onerror = () => fail(open.error);
      });
    }
    return this.dbPromise;
  }

  async listSources(): Promise<SourceConfig[]> {
    const db = await this.db();
    return req(db.transaction('sources').objectStore('sources').getAll());
  }

  async putSource(source: SourceConfig): Promise<void> {
    const tx = (await this.db()).transaction('sources', 'readwrite');
    tx.objectStore('sources').put(source);
    await done(tx);
  }

  async deleteSource(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(ALL_STORES, 'readwrite');
    tx.objectStore('sources').delete(id);
    tx.objectStore('channels').delete(id);
    // Cursor (not await) so the transaction never goes inactive on older TV engines. A key cursor: the values
    // (a title index record is several MB) are never read.
    const meta = tx.objectStore('meta');
    const cursorReq = meta.openKeyCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      if (String(cursor.key).endsWith(`:${id}`)) meta.delete(cursor.primaryKey);
      cursor.continue();
    };
    const sourceRange = IDBKeyRange.bound([id], [id, []]);
    tx.objectStore('vod').delete(sourceRange);
    tx.objectStore('vodUser').delete(sourceRange);
    this.deleteProgrammesIn(tx, id);
    await done(tx);
  }

  async getChannels(sourceId: string): Promise<Channel[]> {
    const db = await this.db();
    const rec = await req(db.transaction('channels').objectStore('channels').get(sourceId));
    return (rec as { channels: Channel[] } | undefined)?.channels ?? [];
  }

  async replaceChannels(sourceId: string, channels: Channel[]): Promise<void> {
    const tx = (await this.db()).transaction('channels', 'readwrite');
    tx.objectStore('channels').put({ sourceId, channels });
    await done(tx);
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    const db = await this.db();
    return (await req(db.transaction('meta').objectStore('meta').get(key))) as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const tx = (await this.db()).transaction('meta', 'readwrite');
    tx.objectStore('meta').put(value, key);
    await done(tx);
  }

  // Synchronous (callback-driven) cursor delete; safe to call inside a larger transaction.
  private deleteProgrammesIn(tx: IDBTransaction, sourceId: string): void {
    const range = IDBKeyRange.bound([sourceId], [sourceId, []]);
    const cursorReq = tx.objectStore('programmes').index('byChannel').openCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  }

  async clearProgrammes(sourceId: string): Promise<void> {
    const tx = (await this.db()).transaction('programmes', 'readwrite');
    this.deleteProgrammesIn(tx, sourceId);
    await done(tx);
  }

  async addProgrammes(sourceId: string, batch: Programme[]): Promise<void> {
    const tx = (await this.db()).transaction('programmes', 'readwrite');
    const store = tx.objectStore('programmes');
    for (const p of batch) store.add({ ...p, sourceId } satisfies ProgRecord);
    await done(tx);
  }

  async getProgrammes(sourceId: string, epgIds: string[], from: number, to: number): Promise<Programme[]> {
    const db = await this.db();
    const index = db.transaction('programmes').objectStore('programmes').index('byChannel');
    // Issue all requests synchronously so the transaction never goes inactive between awaits.
    const pending: Promise<ProgRecord[]>[] = [];
    for (const epgId of new Set(epgIds)) {
      const range = IDBKeyRange.bound([sourceId, epgId, from - MAX_PROGRAMME_MS], [sourceId, epgId, to], false, true);
      pending.push(req(index.getAll(range)) as Promise<ProgRecord[]>);
    }
    const out: Programme[] = [];
    for (const recs of await Promise.all(pending)) {
      for (const { sourceId: _s, ...p } of recs) if (p.stop > from) out.push(p);
    }
    return out.sort((a, b) => (a.epgId < b.epgId ? -1 : a.epgId > b.epgId ? 1 : a.start - b.start));
  }

  async forEachProgramme(sourceId: string, fn: (p: Programme) => void): Promise<void> {
    const tx = (await this.db()).transaction('programmes');
    const range = IDBKeyRange.bound([sourceId], [sourceId, []]);
    // Callback cursor (no await inside), so the transaction stays active on older TV engines.
    const cursorReq = tx.objectStore('programmes').index('byChannel').openCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      const { sourceId: _s, ...p } = cursor.value as ProgRecord;
      fn(p);
      cursor.continue();
    };
    await done(tx);
  }

  async getVod(sourceId: string, kind: VodKind): Promise<VodList | undefined> {
    const db = await this.db();
    const rec = await req(db.transaction('vod').objectStore('vod').get([sourceId, kind]));
    return (rec as { list: VodList } | undefined)?.list;
  }

  async replaceVod(sourceId: string, kind: VodKind, list: VodList): Promise<void> {
    const tx = (await this.db()).transaction('vod', 'readwrite');
    tx.objectStore('vod').put({ sourceId, kind, list });
    await done(tx);
  }

  async getVodUser(sourceId: string, itemId: string): Promise<VodUserState | undefined> {
    const db = await this.db();
    const rec = await req(db.transaction('vodUser').objectStore('vodUser').get([sourceId, itemId]));
    return (rec as { state: VodUserState } | undefined)?.state;
  }

  async putVodUser(sourceId: string, itemId: string, state: VodUserState): Promise<void> {
    const tx = (await this.db()).transaction('vodUser', 'readwrite');
    tx.objectStore('vodUser').put({ sourceId, itemId, state });
    await done(tx);
  }

  async listVodUser(sourceId: string): Promise<VodUserRecord[]> {
    const db = await this.db();
    const recs = await req(db.transaction('vodUser').objectStore('vodUser').getAll(IDBKeyRange.bound([sourceId], [sourceId, []])));
    return (recs as { itemId: string; state: VodUserState }[]).map(({ itemId, state }) => ({ itemId, state }));
  }

  async clearAll(): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(ALL_STORES, 'readwrite');
    for (const name of ALL_STORES) tx.objectStore(name).clear();
    await done(tx);
  }
}
