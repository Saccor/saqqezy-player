import type { ChunkCodec, EncodedChunk } from './compress.ts';
import { done, req } from './idbStorage.ts';
import { packRows, unpackRows, type PackedRows } from './packedRows.ts';

/**
 * Catalogues (channels, movies, series) as packed, compressed chunks. A write puts the chunks of a new generation in
 * short transactions, then swaps the head record (and deletes the legacy single record) in one transaction, then
 * deletes the old generation. A failed write deletes what it wrote, so the stored catalogue stays as it was.
 */
export type CatalogKind = 'channels' | 'movie' | 'series';
export const CHUNK_ROWS = 20_000;
export interface EncodedCatalog { chunks: EncodedChunk[]; extra?: EncodedChunk; count: number; bytes: number }
export interface LegacyRef { store: 'channels' | 'vod'; key: IDBValidKey }
interface Head { sourceId: string; kind: CatalogKind; gen: number; chunks: number; count: number; extra?: EncodedChunk }
interface ChunkRecord extends EncodedChunk { sourceId: string; kind: CatalogKind; gen: number; n: number }

export async function encodeCatalog(rows: readonly object[], extra: unknown, codec: ChunkCodec, chunkRows = CHUNK_ROWS): Promise<EncodedCatalog> {
  const chunks: EncodedChunk[] = [];
  let bytes = 0;
  for (let at = 0; at < rows.length; at += chunkRows) {
    const chunk = await codec.encode(JSON.stringify(packRows(rows.slice(at, at + chunkRows))));
    chunks.push(chunk);
    bytes += chunk.bytes.byteLength;
  }
  const out: EncodedCatalog = { chunks, count: rows.length, bytes };
  if (extra !== undefined) {
    out.extra = await codec.encode(JSON.stringify(extra));
    out.bytes += out.extra.bytes.byteLength;
  }
  return out;
}

const genRange = (sourceId: string, kind: CatalogKind, gen: number) => IDBKeyRange.bound([sourceId, kind, gen], [sourceId, kind, gen, []]);
const belowGen = (sourceId: string, kind: CatalogKind, gen: number) => IDBKeyRange.bound([sourceId, kind], [sourceId, kind, gen], false, true);

async function deleteRange(db: IDBDatabase, range: IDBKeyRange): Promise<void> {
  const tx = db.transaction('chunks', 'readwrite');
  tx.objectStore('chunks').delete(range);
  await done(tx);
}

/** A migration found its legacy record gone (the source was deleted, or a refresh replaced it): nothing was written. */
export const MIGRATION_SUPERSEDED = 'MigrationSuperseded';

export async function writeCatalog(db: IDBDatabase, sourceId: string, kind: CatalogKind, enc: EncodedCatalog, legacy: LegacyRef, opts: { requireLegacy?: boolean } = {}): Promise<void> {
  const prev = (await req(db.transaction('catalogs').objectStore('catalogs').get([sourceId, kind]))) as Head | undefined;
  const gen = (prev?.gen ?? 0) + 1;
  // A crashed earlier attempt may have left chunks at this generation.
  await deleteRange(db, genRange(sourceId, kind, gen));
  let superseded = false;
  try {
    for (let n = 0; n < enc.chunks.length; n++) {
      const tx = db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').put({ sourceId, kind, gen, n, ...enc.chunks[n]! } satisfies ChunkRecord);
      await done(tx);
    }
    const head: Head = { sourceId, kind, gen, chunks: enc.chunks.length, count: enc.count, ...(enc.extra ? { extra: enc.extra } : {}) };
    const tx = db.transaction(['catalogs', legacy.store], 'readwrite');
    const commit = () => {
      tx.objectStore('catalogs').put(head);
      tx.objectStore(legacy.store).delete(legacy.key);
    };
    if (opts.requireLegacy) {
      // A migration encodes for seconds: the source may have been deleted meanwhile. Only commit while the legacy record is there.
      const check = tx.objectStore(legacy.store).count(legacy.key);
      check.onsuccess = () => {
        if (check.result > 0) commit();
        else { superseded = true; tx.abort(); }
      };
    } else {
      commit();
    }
    await done(tx).catch((err: unknown) => { if (!superseded) throw err; });
    if (superseded) throw Object.assign(new Error('Catalogue migration superseded'), { name: MIGRATION_SUPERSEDED });
  } catch (err) {
    await deleteRange(db, genRange(sourceId, kind, gen)).catch(() => undefined);
    throw err;
  }
  await deleteRange(db, belowGen(sourceId, kind, gen)).catch(() => undefined);
}

export async function readCatalog(db: IDBDatabase, sourceId: string, kind: CatalogKind, codec: ChunkCodec): Promise<{ rows: Record<string, unknown>[]; extra: unknown } | undefined> {
  // The head and its chunks come from ONE transaction, so a concurrent write cannot swap generations in between. The
  // chunk read is issued from the head request's callback, with no await in between, so the transaction stays active.
  const { head, recs } = await new Promise<{ head: Head | undefined; recs: ChunkRecord[] }>((resolve, reject) => {
    const tx = db.transaction(['catalogs', 'chunks'], 'readonly');
    const headReq = tx.objectStore('catalogs').get([sourceId, kind]);
    headReq.onsuccess = () => {
      const h = headReq.result as Head | undefined;
      if (!h || h.chunks === 0) { resolve({ head: h, recs: [] }); return; }
      const chunkReq = tx.objectStore('chunks').getAll(IDBKeyRange.bound([sourceId, kind, h.gen, 0], [sourceId, kind, h.gen, h.chunks - 1]));
      chunkReq.onsuccess = () => resolve({ head: h, recs: chunkReq.result as ChunkRecord[] });
    };
    tx.onerror = () => reject(tx.error ?? new DOMException('Catalogue read failed.', 'UnknownError'));
    tx.onabort = () => reject(tx.error ?? new DOMException('Catalogue read aborted.', 'AbortError'));
  });
  if (!head) return undefined;
  // Only a truly incomplete store (chunks missing from disk) reads as missing: the caller fetches again.
  if (recs.length !== head.chunks) return undefined;
  try {
    const rows: Record<string, unknown>[] = [];
    for (const rec of recs) {
      for (const row of unpackRows(JSON.parse(await codec.decode(rec)) as PackedRows)) rows.push(row);
    }
    const extra = head.extra ? (JSON.parse(await codec.decode(head.extra)) as unknown) : undefined;
    return { rows, extra };
  } catch {
    // A chunk that cannot be decoded would fail every read for good: drop the head so the caller falls back or refetches.
    console.warn('Catalogue chunk unreadable', kind);
    await dropHead(db, sourceId, kind, head.gen).catch(() => undefined);
    return undefined;
  }
}

/** Deletes the head of one generation (not a newer one a refresh committed meanwhile). */
async function dropHead(db: IDBDatabase, sourceId: string, kind: CatalogKind, gen: number): Promise<void> {
  const tx = db.transaction('catalogs', 'readwrite');
  const store = tx.objectStore('catalogs');
  const cur = store.get([sourceId, kind]);
  cur.onsuccess = () => { if ((cur.result as Head | undefined)?.gen === gen) store.delete([sourceId, kind]); };
  await done(tx);
}

export function deleteCatalogs(tx: IDBTransaction, sourceId: string): void {
  tx.objectStore('catalogs').delete(IDBKeyRange.bound([sourceId], [sourceId, []]));
  tx.objectStore('chunks').delete(IDBKeyRange.bound([sourceId], [sourceId, []]));
}
