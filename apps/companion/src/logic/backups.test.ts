import { describe, expect, test } from 'vitest';
import type { BackupEnvelope } from '@iptv/core';
import {
  BACKUPS_KEPT, addBackup, backupSize, canRestore, isStoredBackup, restoreCodeProblem, storedBackup, type StoredBackup,
} from './backups.ts';

const env = (at: number): BackupEnvelope => ({ f: 'iptv-backup', v: 1, i: 100_000, s: 'A'.repeat(22) + '==', iv: 'B'.repeat(16), at, ct: 'C'.repeat(4000) });
const T = Date.UTC(2026, 9, 20, 18, 10);

describe('backups kept on the phone', () => {
  test('newest first, at most five, the same backup only once', () => {
    let list: StoredBackup[] = [];
    for (let i = 0; i < 7; i++) list = addBackup(list, storedBackup(env(T + i * 1000), 'Living room'));
    expect(list).toHaveLength(BACKUPS_KEPT);
    expect(list.map((b) => b.at)).toEqual([6, 5, 4, 3, 2].map((i) => T + i * 1000));
    list = addBackup(list, storedBackup(env(T + 6000), 'Living room'));
    expect(list).toHaveLength(5);
    // Another TV's backup at the same moment is another backup.
    expect(addBackup(list, storedBackup(env(T + 6000), 'Bedroom'))).toHaveLength(5);
    expect(addBackup(list, storedBackup(env(T + 6000), 'Bedroom'))[0]!.tv).toBe('Bedroom');
  });

  test('only the ciphertext envelope and its label are kept; reading back checks the shape', () => {
    const b = storedBackup(env(T), 'Living room');
    expect(Object.keys(b).sort()).toEqual(['at', 'backup', 'id', 'tv']);
    expect(isStoredBackup(JSON.parse(JSON.stringify(b)))).toBe(true);
    expect(isStoredBackup({ ...b, backup: { nope: 1 } })).toBe(false);
    expect(isStoredBackup({ ...b, tv: 5 })).toBe(false);
    expect(backupSize(b)).toMatch(/^\d+ KB$/);
  });

  test('restore needs a protocol 3 TV', () => {
    expect(canRestore(undefined)).toBe(false);
    expect(canRestore(2)).toBe(false);
    expect(canRestore(3)).toBe(true);
  });

  test('the recovery code is checked before anything is sent', () => {
    expect(restoreCodeProblem('')).toMatch(/recovery code/i);
    expect(restoreCodeProblem('ABCDE')).toMatch(/26/);
    expect(restoreCodeProblem('01234-56789-abcde-fghjk-mnpqrs')).toBeUndefined();
    expect(restoreCodeProblem('0123456789ABCDEFGHJKMNPQRU')).toMatch(/letters/i);
  });
});
