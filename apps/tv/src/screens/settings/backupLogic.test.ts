import { describe, expect, test } from 'vitest';
import { toastFor } from '../../state/events.ts';
import { backupDoneMessage, backupErrorCopy, codeEntryProblem, formatCode, restoredCopy, storageItems } from './backupLogic.ts';

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
    expect(items[1]!.help).toMatch(/Manage on phone/);
  });

  test('while waiting for the phone, the restore row says so and OK stops waiting', () => {
    const items = storageItems({ connected: true, waiting: true, files: false });
    expect(items[2]!.help).toMatch(/Waiting for your phone/);
    expect(items[2]!.help).toMatch(/OK to stop/);
  });

  test('off TVs: a backup file can be saved and restored', () => {
    const items = storageItems({ connected: false, waiting: false, files: true });
    expect(items.map((i) => i.id)).toEqual(['clear', 'backupPhone', 'restorePhone', 'backupFile', 'restoreFile']);
  });

  test('copy never names a provider or content, and says sources stay on the device', () => {
    const all = storageItems({ connected: true, waiting: false, files: true }).map((i) => `${i.label} ${i.help ?? ''}`).join(' ');
    expect(all).not.toMatch(/free|channels? package|subscription/i);
    expect(backupDoneMessage('phone')).toMatch(/recovery code/i);
    expect(backupDoneMessage('file')).toMatch(/shown only once/i);
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
    expect(restoredCopy({ applied: 1, pending: 3 })).toMatch(/^Restored 1 change from your backup\. Some of it is for a source/);
    expect(restoredCopy({ applied: 0, pending: 3 })).toMatch(/when you add/);
  });

  test('a backupRestored event gets its toast', () => {
    expect(toastFor({ type: 'backupRestored', origin: 'remote', applied: 2, pending: 0, sources: 1, at: 0 })).toBe('Restored 2 changes from your backup.');
  });

  test('errors become short copy', () => {
    expect(backupErrorCopy({ name: 'NoCompanion', message: 'x' })).toMatch(/Manage on phone/);
    expect(backupErrorCopy({ name: 'OldCompanion', message: 'Reload the page on your phone, then try again.' })).toMatch(/Reload/);
    expect(backupErrorCopy({ name: 'Timeout', message: 'x' })).toMatch(/didn't answer/);
    expect(backupErrorCopy({ name: 'BackupError', message: 'The recovery code does not open this backup.' })).toMatch(/recovery code/);
    expect(backupErrorCopy(new Error('boom'))).toBe("Couldn't make the backup.");
  });
});
