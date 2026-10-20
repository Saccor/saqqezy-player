import { describe, expect, test } from 'vitest';
import {
  BACKUP_ENVELOPE_MAX_CHARS, BACKUP_SCHEMA, BackupError, isBackupEnvelope, openBackup, sealBackup, type BackupEnvelope,
} from '../../src/sync/backupCrypto.ts';
import { encodeRecoveryCode, newRecoveryCode } from '../../src/sync/recovery.ts';
import { sourceFingerprint } from '../../src/sync/ref.ts';

const T = Date.UTC(2026, 9, 20, 12);
const ITER = 1000; // fast in tests; real backups use BACKUP_PBKDF2_ITERATIONS
const text = (s: string) => new TextEncoder().encode(s);

describe('backup envelope', () => {
  test('seals and opens with the recovery code; the fingerprint key matches on both sides', async () => {
    const code = newRecoveryCode();
    const sealed = await sealBackup(text('{"hello":1}'), code, { now: T, iterations: ITER });
    expect(isBackupEnvelope(sealed.envelope)).toBe(true);
    expect(sealed.envelope).toMatchObject({ f: 'iptv-backup', v: BACKUP_SCHEMA, i: ITER, at: T });
    expect(JSON.stringify(sealed.envelope)).not.toContain('hello');
    const opened = await openBackup(sealed.envelope, code.toLowerCase());
    expect(new TextDecoder().decode(opened.plaintext)).toBe('{"hello":1}');
    const src = { id: 's1', kind: 'm3u' as const, name: 'Mine', playlistUrl: 'https://example.test/a.m3u' };
    expect(await sourceFingerprint(opened.fpKey, src)).toBe(await sourceFingerprint(sealed.fpKey, src));
  });

  test('a fresh salt and IV every time', async () => {
    const code = newRecoveryCode();
    const a = await sealBackup(text('x'), code, { now: T, iterations: ITER });
    const b = await sealBackup(text('x'), code, { now: T, iterations: ITER });
    expect(a.envelope.s).not.toBe(b.envelope.s);
    expect(a.envelope.iv).not.toBe(b.envelope.iv);
  });

  test('a wrong code, a changed header or ciphertext all fail as wrongCode; a malformed code as badCode', async () => {
    const code = encodeRecoveryCode(new Uint8Array(16).fill(7));
    const { envelope } = await sealBackup(text('secret'), code, { now: T, iterations: ITER });
    const fail = async (env: BackupEnvelope, c = code) => {
      const err = await openBackup(env, c).then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(BackupError);
      return (err as BackupError).reason;
    };
    expect(await fail(envelope, encodeRecoveryCode(new Uint8Array(16).fill(8)))).toBe('wrongCode');
    expect(await fail({ ...envelope, at: T + 1 })).toBe('wrongCode');
    const ct = envelope.ct;
    const flipped = (ct[5] === 'A' ? 'B' : 'A');
    expect(await fail({ ...envelope, ct: ct.slice(0, 5) + flipped + ct.slice(6) })).toBe('wrongCode');
    expect(await fail(envelope, 'not a code')).toBe('badCode');
  });

  test('a newer schema is tooNew; anything else that is not an envelope is invalid', async () => {
    const { envelope } = await sealBackup(text('x'), newRecoveryCode(), { now: T, iterations: ITER });
    expect(isBackupEnvelope({ ...envelope, v: BACKUP_SCHEMA + 1 })).toBe(true);
    await expect(openBackup({ ...envelope, v: BACKUP_SCHEMA + 1 }, newRecoveryCode())).rejects.toMatchObject({ reason: 'tooNew' });
    for (const bad of [null, {}, { ...envelope, f: 'other' }, { ...envelope, extra: 1 }, { ...envelope, iv: 'x' }, { ...envelope, i: 0 },
      { ...envelope, ct: 'a'.repeat(BACKUP_ENVELOPE_MAX_CHARS + 1) }]) {
      expect(isBackupEnvelope(bad)).toBe(false);
      await expect(openBackup(bad as BackupEnvelope, newRecoveryCode())).rejects.toMatchObject({ reason: 'invalid' });
    }
  });
});
