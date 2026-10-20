import { createSignal } from 'solid-js';
import { addBackup, isStoredBackup, storedBackup, type StoredBackup } from '../logic/backups.ts';
import type { BackupEnvelope } from '@iptv/core';

/**
 * Backups kept on this phone (IndexedDB, newest BACKUPS_KEPT). What is stored is the TV's sealed envelope: ciphertext
 * that only the recovery code opens. The code itself is never stored; it is typed into the restore form and sent to
 * the TV over the paired, end-to-end encrypted channel.
 */

const DB_NAME = 'iptv-companion';
const STORE = 'backups';
const KEY = 'list';

const [backups, setBackups] = createSignal<readonly StoredBackup[]>([]);
export { backups };

let loaded: Promise<void> | undefined;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
  });
}

async function read(): Promise<StoredBackup[]> {
  if (typeof indexedDB === 'undefined') return [];
  const db = await openDb();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('read failed'));
    });
    return Array.isArray(value) ? value.filter(isStoredBackup) : [];
  } finally {
    db.close();
  }
}

async function write(list: readonly StoredBackup[]): Promise<void> {
  if (typeof indexedDB === 'undefined') throw new Error('This browser cannot keep files for this page.');
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(list.slice(), KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('write failed'));
      tx.onabort = () => reject(tx.error ?? new Error('write aborted'));
    });
  } finally {
    db.close();
  }
}

/** Loads the kept backups once per page (a failure leaves the list empty). */
export function loadBackups(): Promise<void> {
  if (!loaded) loaded = read().then((list) => { setBackups(list); }, () => { setBackups([]); });
  return loaded;
}

/** Keeps a backup the TV sent. Rejects when it could not be stored (the TV is then not told it was saved). */
export async function keepBackup(backup: BackupEnvelope, tv: string): Promise<void> {
  await loadBackups();
  const next = addBackup(backups(), storedBackup(backup, tv));
  await write(next);
  setBackups(next);
}

export async function deleteBackup(id: string): Promise<void> {
  await loadBackups();
  const next = backups().filter((b) => b.id !== id);
  await write(next);
  setBackups(next);
}
