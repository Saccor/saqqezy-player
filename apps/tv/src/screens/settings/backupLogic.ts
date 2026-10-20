import type { SettingItem } from '../../components/SettingsList.tsx';

/**
 * Settings › Storage backup rows (sync phase S1): pure copy and row logic. The recovery code is formatted here
 * rather than with @iptv/core, which stays out of the main-thread bundle; the worker checks it for real.
 */

export interface StorageRowsState {
  /** A phone is connected (Manage on phone). */
  connected: boolean;
  /** The TV waits for the phone to send a backup ("Restore from your phone" was chosen). */
  waiting: boolean;
  /** Off TVs (desktop, browser): backup files can be saved and opened. */
  files: boolean;
}

export function storageItems(s: StorageRowsState): SettingItem[] {
  const items: SettingItem[] = [
    { id: 'clear', label: 'Clear cached channels, guide, movies and series', help: 'Your sources, favourites and watch progress are kept' },
    s.connected
      ? { id: 'backupPhone', label: 'Back up to your phone', help: 'Lists, hidden channels, renames, watch progress and preferences, encrypted' }
      : { id: 'backupPhone', label: 'Back up to your phone', help: 'Connect your phone first: Settings › Manage on phone', disabled: true },
    {
      id: 'restorePhone', label: 'Restore from your phone',
      help: s.waiting ? 'Waiting for your phone… On the phone, open Backup › Restore to this TV. OK to stop' : 'Merges a backup into this TV. Your sources stay as they are',
    },
  ];
  if (s.files) {
    items.push(
      { id: 'backupFile', label: 'Save a backup file', help: 'The same backup as a file on this computer, encrypted' },
      { id: 'restoreFile', label: 'Restore from a file', help: 'Open a backup file and type its recovery code' },
    );
  }
  return items;
}

/** The dialog that shows the recovery code, once. */
export function backupDoneMessage(where: 'phone' | 'file'): string {
  return where === 'phone'
    ? 'Backup saved on your phone. Write down this recovery code: it is shown only once, and the backup cannot be opened without it.'
    : 'Backup file saved. Write down this recovery code: it is shown only once, and the file cannot be opened without it.';
}

export const RESTORE_CONFIRM =
  'Restore from your phone? Lists, hidden channels, renames, progress and preferences from the backup are merged into this TV. Your sources stay as they are.';

/** `XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX`. */
export function formatCode(code: string): string {
  const c = code.replace(/[\s-]/g, '').toUpperCase();
  return [c.slice(0, 5), c.slice(5, 10), c.slice(10, 15), c.slice(15, 20), c.slice(20)].filter(Boolean).join('-');
}

/** A quick check before the worker sees a typed code (copy), or undefined. */
export function codeEntryProblem(input: string): string | undefined {
  const bare = input.replace(/[\s-]/g, '');
  if (!bare) return 'Type the recovery code of this backup.';
  if (bare.length !== 26) return `A recovery code has 26 letters and digits (${bare.length} typed).`;
  return undefined;
}

export function restoredCopy(r: { applied: number; pending: number }): string {
  const later = 'Some of it is for a source this TV does not have yet: it is applied when you add that source.';
  if (r.applied === 0) return r.pending ? `Nothing to change yet. ${later.replace('Some of it', 'The backup')}` : 'Nothing to restore: this TV already has everything in the backup.';
  const head = `Restored ${r.applied} ${r.applied === 1 ? 'change' : 'changes'} from your backup.`;
  return r.pending ? `${head} ${later}` : head;
}

/** Copy for a failed backup or restore (worker errors cross as name + message). */
export function backupErrorCopy(err: unknown, fallback = "Couldn't make the backup."): string {
  const name = err && typeof err === 'object' && typeof (err as { name?: unknown }).name === 'string' ? (err as { name: string }).name : '';
  const message = err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message : '';
  switch (name) {
    case 'NoCompanion': return 'Connect your phone first: Settings › Manage on phone.';
    case 'OldCompanion':
    case 'BackupError':
      return message || fallback;
    case 'Timeout': return "The phone didn't answer. Keep Manage on phone open on it and try again.";
    case 'Busy': return 'The phone is busy. Try again.';
    default: return fallback;
  }
}
