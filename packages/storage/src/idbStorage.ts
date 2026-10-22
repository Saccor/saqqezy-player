import {
  MAX_PROGRAMME_MS, isQuotaError,
  type Channel, type Programme, type SourceConfig, type Storage, type SyncMetaEntry, type VodKind, type VodList, type VodUserRecord, type VodUserState,
} from '@iptv/core';
import { CHUNK_ROWS, MIGRATION_SUPERSEDED, deleteCatalogs, encodeCatalog, readCatalog, writeCatalog, type CatalogKind, type LegacyRef } from './catalogStore.ts';
import { createChunkCodec, type ChunkCodec } from './compress.ts';

const DB_VERSION = 4;
const ALL_STORES = ['sources', 'channels', 'meta', 'programmes', 'vod', 'vodUser', 'syncMeta', 'catalogs', 'chunks'];
type ProgRecord = Programme & { sourceId: string };

/** Keeps the original error's name; an empty message (a quota abort has one) becomes `IndexedDB <name>`. */
function named(err: DOMException | Error | null | undefined, fallback: string): Error {
  const name = err?.name || fallback;
  if (err && err.message) return err;
  return Object.assign(new Error(`IndexedDB ${name}`), { name });
}

export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(named(r.error, 'UnknownError'));
  });
}

export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(named(tx.error, 'AbortError'));
    tx.onabort = () => reject(named(tx.error, 'AbortError'));
  });
}

export interface IdbStorageOptions {
  codec?: ChunkCodec;
  chunkRows?: number;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
  beforeLargeWrite?: (bytes: number) => Promise<void>;
  /** Longest the `beforeLargeWrite` hook may take before the write goes ahead (default 5 s). */
  hookTimeoutMs?: number;
}

type StorageEstimate = { usage?: number; quota?: number };

/** The engine's own storage estimate, when it has one (not in every browser or worker). */
function nativeEstimate(): (() => Promise<StorageEstimate>) | undefined {
  const storage = (globalThis as { navigator?: { storage?: { estimate?: () => Promise<StorageEstimate> } } }).navigator?.storage;
  return storage?.estimate?.bind(storage);
}

export class IdbStorage implements Storage {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly codec: ChunkCodec;
  private readonly chunkRows: number;
  /** One catalogue write (or migration) per source and kind at a time. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly factory: IDBFactory = indexedDB,
    private readonly dbName = 'iptv',
    /** Programmes deleted per transaction by `clearProgrammes`. */
    private readonly clearChunk = 2000,
    private readonly opts: IdbStorageOptions = {},
  ) {
    this.codec = opts.codec ?? createChunkCodec();
    this.chunkRows = opts.chunkRows ?? CHUNK_ROWS;
  }

  private withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    this.locks.set(key, tail);
    void tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return run;
  }

  private readonly migrations = new Set<Promise<unknown>>();

  /** Resolves when every background migration started so far has finished (tests, and a clean shutdown). */
  async settled(): Promise<void> {
    while (this.migrations.size > 0) await Promise.allSettled([...this.migrations]);
  }

  private readonly pendingMigrations = new Set<string>();

  private migrateLater(sourceId: string, kind: CatalogKind, rows: readonly object[], extra: unknown, legacy: LegacyRef): void {
    const key = `${sourceId}\u0000${kind}`;
    // One migration per catalogue: later reads of the same legacy record would only queue another copy of the list.
    if (this.pendingMigrations.has(key)) return;
    this.pendingMigrations.add(key);
    const p = this.writeKey(sourceId, kind, rows, extra, legacy, { onlyIfLegacy: true }).catch((err: unknown) => {
      // The legacy record vanished while encoding (source deleted, or a refresh won): a normal skip.
      if (err instanceof Error && err.name === MIGRATION_SUPERSEDED) return;
      console.warn('Catalogue migration failed', kind, err instanceof Error ? err.name : 'Error');
    });
    this.migrations.add(p);
    void p.then(() => { this.migrations.delete(p); this.pendingMigrations.delete(key); });
  }

  private writeKey(sourceId: string, kind: CatalogKind, rows: readonly object[], extra: unknown, legacy: LegacyRef, opts: { onlyIfLegacy?: boolean } = {}): Promise<void> {
    return this.withKeyLock(`${sourceId}\u0000${kind}`, async () => {
      if (opts.onlyIfLegacy) {
        // A refresh may have committed while this migration waited: then the legacy list is older than what is stored.
        const chk = (await this.db()).transaction(['catalogs', legacy.store], 'readonly');
        const [head, old] = await Promise.all([
          req(chk.objectStore('catalogs').count([sourceId, kind])),
          req(chk.objectStore(legacy.store).count(legacy.key)),
        ]);
        if (head > 0 || old === 0) return;
      }
      const enc = await encodeCatalog(rows, extra, this.codec, this.chunkRows);
      await this.makeRoom(enc.bytes);
      const db = await this.db();
      try {
        await writeCatalog(db, sourceId, kind, enc, legacy, { requireLegacy: opts.onlyIfLegacy === true });
      } catch (err) {
        // The legacy single record of this key is what leaves no room (47 MB of movies on the G9): the list being
        // written is the same data or newer, so drop it and try once more.
        if (!isQuotaError(err) || (await req(db.transaction(legacy.store).objectStore(legacy.store).count(legacy.key))) === 0) throw err;
        const tx = db.transaction(legacy.store, 'readwrite');
        tx.objectStore(legacy.store).delete(legacy.key);
        await done(tx);
        await writeCatalog(db, sourceId, kind, enc, legacy);
      }
    });
  }

  /** Free space by the storage estimate; undefined when the engine cannot tell. */
  private async freeBytes(): Promise<number | undefined> {
    const estimate = this.opts.estimate ?? nativeEstimate();
    if (!estimate) return undefined;
    try {
      const e = await estimate();
      return typeof e.quota === 'number' && typeof e.usage === 'number' ? e.quota - e.usage : undefined;
    } catch {
      return undefined;
    }
  }

  /** Short of room for a catalogue write: let the app free caches first (best effort). */
  private async makeRoom(bytes: number): Promise<void> {
    if (!this.opts.beforeLargeWrite) return;
    const free = await this.freeBytes();
    if (free === undefined || free >= bytes * 1.2 + 2e6) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bounded: a hung hook must not hold the key lock for ever.
      await Promise.race([
        this.opts.beforeLargeWrite(bytes),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, this.opts.hookTimeoutMs ?? 5000); }),
      ]);
    } catch {
      // Best effort: a failed clean-up must not fail the write itself.
    } finally {
      clearTimeout(timer);
    }
  }

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
          if (e.oldVersion < 3) {
            // Sync sidecar (clocks, pending records): hot structures (layout, vodUser) keep their shape.
            db.createObjectStore('syncMeta', { keyPath: ['scope', 'key'] });
          }
          if (e.oldVersion < 4) {
            // Catalogues as packed, compressed chunks (spec 2026-10-22-compact-catalogs); `channels`/`vod` stay for migration.
            db.createObjectStore('catalogs', { keyPath: ['sourceId', 'kind'] });
            db.createObjectStore('chunks', { keyPath: ['sourceId', 'kind', 'gen', 'n'] });
            // A catalogue that could not be saved before this version fits now: fetch it again at once instead of after
            // the storage backoff (which holds back even a screen with nothing to show).
            if (e.oldVersion >= 1) {
              const meta = open.transaction!.objectStore('meta');
              const cur = meta.openCursor(IDBKeyRange.bound('refreshFail:', 'refreshFail:\uffff'));
              cur.onsuccess = () => {
                const c = cur.result;
                if (!c) return;
                const v = c.value as { storage?: unknown } | null;
                if (String(c.key).startsWith('refreshFail:') && v && typeof v === 'object' && v.storage === true) c.delete();
                c.continue();
              };
            }
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
    tx.objectStore('syncMeta').delete(sourceRange);
    deleteCatalogs(tx, id);
    this.deleteProgrammesIn(tx, id);
    await done(tx);
  }

  async getChannels(sourceId: string): Promise<Channel[]> {
    const db = await this.db();
    const cat = await readCatalog(db, sourceId, 'channels', this.codec);
    if (cat) return cat.rows as unknown as Channel[];
    const rec = await req(db.transaction('channels').objectStore('channels').get(sourceId));
    const legacy = (rec as { channels: Channel[] } | undefined)?.channels;
    if (!legacy) return [];
    this.migrateLater(sourceId, 'channels', legacy, undefined, { store: 'channels', key: sourceId });
    return legacy;
  }

  replaceChannels(sourceId: string, channels: Channel[]): Promise<void> {
    return this.writeKey(sourceId, 'channels', channels, undefined, { store: 'channels', key: sourceId });
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

  /**
   * A big guide holds millions of programmes, and one transaction over all of them locks the store for minutes:
   * every guide read (the channel rows' now/next) would wait. Short transactions of `clearChunk` deletes each let
   * those reads in between.
   */
  async clearProgrammes(sourceId: string): Promise<void> {
    const db = await this.db();
    const range = IDBKeyRange.bound([sourceId], [sourceId, []]);
    for (;;) {
      const tx = db.transaction('programmes', 'readwrite');
      let deleted = 0;
      const cursorReq = tx.objectStore('programmes').index('byChannel').openKeyCursor(range);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        tx.objectStore('programmes').delete(cursor.primaryKey);
        if (++deleted < this.clearChunk) cursor.continue();
      };
      await done(tx);
      if (deleted < this.clearChunk) return;
    }
  }

  async addProgrammes(sourceId: string, batch: Programme[]): Promise<void> {
    const tx = (await this.db()).transaction('programmes', 'readwrite');
    const store = tx.objectStore('programmes');
    // The batch is ours (see Storage.addProgrammes): tag each programme instead of copying it.
    for (const p of batch) {
      (p as ProgRecord).sourceId = sourceId;
      store.add(p);
    }
    await done(tx);
  }

  async getProgrammes(sourceId: string, epgIds: string[], from: number, to: number, lookBackMs = MAX_PROGRAMME_MS): Promise<Programme[]> {
    const db = await this.db();
    const index = db.transaction('programmes').objectStore('programmes').index('byChannel');
    // Issue all requests synchronously so the transaction never goes inactive between awaits.
    const pending: Promise<Programme[]>[] = [];
    for (const epgId of new Set(epgIds)) {
      const range = IDBKeyRange.bound([sourceId, epgId, from - lookBackMs], [sourceId, epgId, to], false, true);
      pending.push(req(index.getAll(range)) as Promise<Programme[]>);
    }
    const out: Programme[] = [];
    for (const recs of await Promise.all(pending)) {
      // Records as read, `sourceId` tag included: no copy of each one without it.
      for (const rec of recs) if (rec.stop > from) out.push(rec);
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
      fn(cursor.value as Programme);
      cursor.continue();
    };
    await done(tx);
  }

  async getVod(sourceId: string, kind: VodKind): Promise<VodList | undefined> {
    const db = await this.db();
    const cat = await readCatalog(db, sourceId, kind, this.codec);
    if (cat) return { items: cat.rows as unknown as VodList['items'], ...(cat.extra as Omit<VodList, 'items'>) };
    const rec = await req(db.transaction('vod').objectStore('vod').get([sourceId, kind]));
    const legacy = (rec as { list: VodList } | undefined)?.list;
    if (legacy) {
      const { items, ...extra } = legacy;
      this.migrateLater(sourceId, kind, items, extra, { store: 'vod', key: [sourceId, kind] });
    }
    return legacy;
  }

  replaceVod(sourceId: string, kind: VodKind, list: VodList): Promise<void> {
    const { items, ...extra } = list;
    return this.writeKey(sourceId, kind, items, extra, { store: 'vod', key: [sourceId, kind] });
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

  async getSyncMeta(scope: string, key: string): Promise<unknown> {
    const db = await this.db();
    const rec = await req(db.transaction('syncMeta').objectStore('syncMeta').get([scope, key]));
    return (rec as SyncMetaEntry | undefined)?.value;
  }

  async listSyncMeta(scope: string): Promise<SyncMetaEntry[]> {
    const db = await this.db();
    const recs = await req(db.transaction('syncMeta').objectStore('syncMeta').getAll(IDBKeyRange.bound([scope], [scope, []])));
    return (recs as SyncMetaEntry[]).map(({ scope: sc, key, value }) => ({ scope: sc, key, value }));
  }

  async putSyncMeta(entries: SyncMetaEntry[]): Promise<void> {
    if (!entries.length) return;
    const tx = (await this.db()).transaction('syncMeta', 'readwrite');
    const store = tx.objectStore('syncMeta');
    for (const { scope, key, value } of entries) store.put({ scope, key, value });
    await done(tx);
  }

  async deleteSyncMeta(scope: string, keys: string[]): Promise<void> {
    if (!keys.length) return;
    const tx = (await this.db()).transaction('syncMeta', 'readwrite');
    const store = tx.objectStore('syncMeta');
    for (const key of keys) store.delete([scope, key]);
    await done(tx);
  }

  async clearAll(): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(ALL_STORES, 'readwrite');
    for (const name of ALL_STORES) tx.objectStore(name).clear();
    await done(tx);
  }
}
