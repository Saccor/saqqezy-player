import { BACKUP_PROTOCOL } from '@iptv/companion-protocol';
import { isBackupEnvelope, parseRecoveryCode, RECOVERY_CODE_LENGTH, type BackupEnvelope } from '@iptv/core';

/** Backups kept on this phone, newest first; older ones go. */
export const BACKUPS_KEPT = 5;

/**
 * A backup the TV sent, as kept on the phone: the sealed envelope (ciphertext only; this page never holds the key or
 * the recovery code beyond the restore form) and the TV's label to tell backups apart.
 */
export interface StoredBackup {
  /** `<at>|<tv>`: the same backup arriving twice is kept once. */
  id: string;
  tv: string;
  at: number;
  backup: BackupEnvelope;
}

export function storedBackup(backup: BackupEnvelope, tv: string): StoredBackup {
  const label = tv.trim() || 'TV';
  return { id: `${backup.at}|${label}`, tv: label, at: backup.at, backup };
}

export function isStoredBackup(x: unknown): x is StoredBackup {
  if (typeof x !== 'object' || x === null) return false;
  const b = x as Record<string, unknown>;
  return typeof b['id'] === 'string' && typeof b['tv'] === 'string' && typeof b['at'] === 'number' && isBackupEnvelope(b['backup']);
}

/** Adds a backup (replacing the same one), newest first, keeping BACKUPS_KEPT. */
export function addBackup(list: readonly StoredBackup[], b: StoredBackup, max = BACKUPS_KEPT): StoredBackup[] {
  return [b, ...list.filter((x) => x.id !== b.id)].sort((x, y) => y.at - x.at).slice(0, max);
}

/** Rough size, for the list. */
export function backupSize(b: StoredBackup): string {
  return `${Math.max(1, Math.round(b.backup.ct.length / 1024))} KB`;
}

export function backupDate(b: StoredBackup): string {
  return new Date(b.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Restoring needs a TV that speaks protocol 3. */
export const canRestore = (tvProtocol: number | undefined): boolean => (tvProtocol ?? 0) >= BACKUP_PROTOCOL;

/** What is wrong with a typed recovery code (copy), or undefined when it can be sent. */
export function restoreCodeProblem(input: string): string | undefined {
  const bare = input.replace(/[\s-]/g, '');
  if (!bare) return 'Type the recovery code the TV showed when it made this backup.';
  if (bare.length !== RECOVERY_CODE_LENGTH) return `A recovery code has ${RECOVERY_CODE_LENGTH} letters and digits (you typed ${bare.length}).`;
  if (!parseRecoveryCode(bare)) return 'That code has letters a recovery code never uses. Check it against what you wrote down.';
  return undefined;
}
