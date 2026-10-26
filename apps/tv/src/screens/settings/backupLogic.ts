import type { SettingItem } from '../../components/SettingsList.tsx';
import { SETTINGS_COPY } from '../../copy.ts';

const B = SETTINGS_COPY.backup;

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
    { id: 'clear', label: B.clear, help: B.clearHelp },
    s.connected
      ? { id: 'backupPhone', label: B.toPhone, help: B.toPhoneHelp }
      : { id: 'backupPhone', label: B.toPhone, help: B.toPhoneNeedsPhone, disabled: true },
    {
      id: 'restorePhone', label: B.fromPhone,
      help: s.waiting ? B.waiting : B.fromPhoneHelp,
    },
  ];
  if (s.files) {
    items.push(
      { id: 'backupFile', label: B.toFile, help: B.toFileHelp },
      { id: 'restoreFile', label: B.fromFile, help: B.fromFileHelp },
    );
  }
  return items;
}

/** The dialog that shows the recovery code, once: this is its title, `BACKUP_DONE_LINE` its line, the code its detail. */
export function backupDoneMessage(where: 'phone' | 'file'): string {
  return where === 'phone' ? B.savedPhone : B.savedFile;
}
export const BACKUP_DONE_LINE = B.codeLine;

/** The restore confirm: title and line. */
export const RESTORE_CONFIRM = B.restoreTitle;
export const RESTORE_CONFIRM_LINE = B.restoreLine;

/** `XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX`. */
export function formatCode(code: string): string {
  const c = code.replace(/[\s-]/g, '').toUpperCase();
  return [c.slice(0, 5), c.slice(5, 10), c.slice(10, 15), c.slice(15, 20), c.slice(20)].filter(Boolean).join('-');
}

/** A quick check before the worker sees a typed code (copy), or undefined. */
export function codeEntryProblem(input: string): string | undefined {
  const bare = input.replace(/[\s-]/g, '');
  if (!bare) return B.typeCode;
  if (bare.length !== 26) return B.codeLength(bare.length);
  return undefined;
}

export function restoredCopy(r: { applied: number; pending: number }): string {
  if (r.applied === 0) return r.pending ? B.nothingYet : B.nothing;
  const head = B.restored(r.applied);
  return r.pending ? B.restoredPending(r.applied) : head;
}

/** Copy for a failed backup or restore (worker errors cross as name + message). */
export function backupErrorCopy(err: unknown, fallback: string = B.makeFailed): string {
  const name = err && typeof err === 'object' && typeof (err as { name?: unknown }).name === 'string' ? (err as { name: string }).name : '';
  const message = err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message : '';
  switch (name) {
    case 'NoCompanion': return B.needsPhone;
    case 'OldCompanion':
    case 'BackupError':
      return message || fallback;
    case 'Timeout': return B.noAnswer;
    case 'Busy': return B.busy;
    default: return fallback;
  }
}
