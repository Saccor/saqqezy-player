import { describe, expect, test } from 'vitest';
import { toastFor } from '../../state/events.ts';
import { BACKUP_DONE_LINE, backupDoneMessage, backupErrorCopy, codeEntryProblem, formatCode, restoredCopy, storageItems } from './backupLogic.ts';

describe('Settings › Storage backup rows', () => {
  test('TV: clear cache, back up to and restore from the phone; no file rows', () => {
    const items = storageItems({ connected: true, waiting: false, files: false });
    expect(items.map((i) => i.id)).toEqual(['clear', 'backupPhone', 'restorePhone']);
    expect(items[1]).toMatchObject({ label: 'Back up to your phone' });
    expect(items[1]!.disabled).toBeFalsy();
    expect(items[2]).toMatchObject({ label: 'Restore from your phone' });
  });

  test('without a phone the backup row says how to connect one', () => {
    const items = storageItems({ connected: false, waiting: false, files: false });
    expect(items[1]).toMatchObject({ disabled: true });
    expect(items[1]!.help).toMatch(/Phone and computer/);
  });

  test('while waiting for the phone, the restore row says so and OK stops waiting', () => {
    const items = storageItems({ connected: true, waiting: true, files: false });
    expect(items[2]!.help).toMatch(/Waiting for your phone/);
    expect(items[2]!.help).toBe('Waiting for your phone: open Backup › Restore to this TV.');
    expect(items[2]!.help!.length).toBeLessThanOrEqual(70);
  });

  test('off TVs: a backup file can be saved and restored', () => {
    const items = storageItems({ connected: false, waiting: false, files: true });
    expect(items.map((i) => i.id)).toEqual(['clear', 'backupPhone', 'restorePhone', 'backupFile', 'restoreFile']);
  });

  test('copy never names a provider or content, and says sources stay on the device', () => {
    const all = storageItems({ connected: true, waiting: false, files: true }).map((i) => `${i.label} ${i.help ?? ''}`).join(' ');
    expect(all).not.toMatch(/free|channels? package|subscription/i);
    expect(backupDoneMessage('phone')).toBe('Backup saved on your phone');
    expect(backupDoneMessage('file')).toBe('Backup file saved');
    expect(BACKUP_DONE_LINE).toMatch(/shown once/i);
  });
});

describe('recovery code on the TV', () => {
  test('is shown in groups of five, the last six', () => {
    expect(formatCode('0123456789ABCDEFGHJKMNPQRS')).toBe('01234-56789-ABCDE-FGHJK-MNPQRS');
  });

  test('a typed code is checked for its length before it goes to the worker', () => {
    expect(codeEntryProblem('')).toMatch(/recovery code/i);
    expect(codeEntryProblem('01234-56789')).toMatch(/26/);
    expect(codeEntryProblem('01234 56789 abcde fghjk mnpqrs')).toBeUndefined();
  });
});

describe('restore results', () => {
  test('summaries', () => {
    expect(restoredCopy({ applied: 0, pending: 0 })).toMatch(/already/i);
    expect(restoredCopy({ applied: 12, pending: 0 })).toBe('Restored 12 changes from your backup.');
    expect(restoredCopy({ applied: 1, pending: 3 })).toBe('Restored 1 change. Some apply when you add their source.');
    for (const n of [1, 999]) expect(restoredCopy({ applied: n, pending: 2 }).length).toBeLessThanOrEqual(70);
    expect(restoredCopy({ applied: 0, pending: 3 })).toMatch(/when you add/);
  });

  test('a backupRestored event gets its toast', () => {
    expect(toastFor({ type: 'backupRestored', origin: 'remote', applied: 2, pending: 0, sources: 1, at: 0 })).toBe('Restored 2 changes from your backup.');
  });

  test('errors become short copy', () => {
    expect(backupErrorCopy({ name: 'NoCompanion', message: 'x' })).toMatch(/Phone and computer/);
    expect(backupErrorCopy({ name: 'OldCompanion', message: 'Reload the page on your phone, then try again.' })).toMatch(/Reload/);
    expect(backupErrorCopy({ name: 'Timeout', message: 'x' })).toMatch(/didn't answer/);
    expect(backupErrorCopy({ name: 'BackupError', message: 'The recovery code does not open this backup.' })).toMatch(/recovery code/);
    expect(backupErrorCopy(new Error('boom'))).toBe("Couldn't make the backup.");
  });
});
