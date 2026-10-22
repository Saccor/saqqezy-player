/**
 * Small copies of the source's images (posters, logos, backdrops), kept on the device so a later visit, or the next
 * launch, skips the network and the full-size decode. Its own IndexedDB database (never the worker's `iptv` one, so it
 * cannot hold up a guide import), capped in bytes: past the cap the least recently used copies go. Best effort: any
 * storage error reads as a miss and a write that fails is dropped.
 */
export interface ThumbRecord { type: string; bytes: ArrayBuffer }

interface Row { key: string; type: string; bytes: ArrayBuffer; size: number; at: number }

const STORE = 'thumbs';
const META = 'meta';
const TOTAL = 'total';
/** A hit refreshes its use time at most this often (a write per hit would cost more than it is worth). */
const TOUCH_MS = 60 * 60 * 1000;

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

export class ThumbStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly factory: IDBFactory | undefined = globalThis.indexedDB,
    private readonly maxBytes = 40e6,
    private readonly now: () => number = Date.now,
    private readonly dbName = 'iptv-thumbs',
  ) {}

  private db(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new Error('No IndexedDB'));
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const open = this.factory!.open(this.dbName, 1);
        open.onupgradeneeded = () => {
          const db = open.result;
          db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('byAt', 'at');
          db.createObjectStore(META);
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => { this.dbPromise = null; reject(open.error); };
        open.onblocked = () => { this.dbPromise = null; reject(new Error('IndexedDB open blocked')); };
      });
    }
    return this.dbPromise;
  }

  async get(key: string): Promise<ThumbRecord | undefined> {
    try {
      const db = await this.db();
      const row = await req<Row | undefined>(db.transaction(STORE, 'readonly').objectStore(STORE).get(key));
      if (!row) return undefined;
      if (this.now() - row.at > TOUCH_MS) void this.touch(db, row).catch(() => undefined);
      return { type: row.type, bytes: row.bytes };
    } catch {
      return undefined;
    }
  }

  private async touch(db: IDBDatabase, row: Row): Promise<void> {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ ...row, at: this.now() });
    await done(tx);
  }

  /** Stores a copy; past the cap the least recently used ones go, down to 80 % of it. */
  async put(key: string, type: string, bytes: ArrayBuffer): Promise<void> {
    const size = bytes.byteLength;
    if (size === 0 || size > this.maxBytes / 4) return;
    try {
      const db = await this.db();
      const tx = db.transaction([STORE, META], 'readwrite');
      const store = tx.objectStore(STORE);
      const meta = tx.objectStore(META);
      const [old, total0] = await Promise.all([
        req<Row | undefined>(store.get(key)),
        req<number | undefined>(meta.get(TOTAL)),
      ]);
      let total = (total0 ?? 0) - (old?.size ?? 0) + size;
      store.put({ key, type, bytes, size, at: this.now() } satisfies Row);
      if (total > this.maxBytes) total = await this.evict(store, total, this.maxBytes * 0.8, key);
      meta.put(total, TOTAL);
      await done(tx);
    } catch {
      // Quota or a closed database: the copy is simply not kept.
    }
  }

  /** Deletes the oldest copies (never `keep`) until `total` is at most `target`; returns the new total. */
  private evict(store: IDBObjectStore, total: number, target: number, keep: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const cursorReq = store.index('byAt').openCursor();
      cursorReq.onerror = () => reject(cursorReq.error);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || total <= target) { resolve(total); return; }
        const row = cursor.value as Row;
        if (row.key !== keep) {
          cursor.delete();
          total -= row.size;
        }
        cursor.continue();
      };
    });
  }

  /** Removes every copy (Settings › reset, or a test). */
  async clear(): Promise<void> {
    try {
      const db = await this.db();
      const tx = db.transaction([STORE, META], 'readwrite');
      tx.objectStore(STORE).clear();
      tx.objectStore(META).clear();
      await done(tx);
    } catch {
      // Nothing to clear.
    }
  }
}
