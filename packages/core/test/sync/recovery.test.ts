import { describe, expect, test } from 'vitest';
import {
  RECOVERY_CODE_LENGTH, encodeRecoveryCode, formatRecoveryCode, newRecoveryCode, parseRecoveryCode,
} from '../../src/sync/recovery.ts';

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]+$/;

describe('recovery code', () => {
  test('a new code is 26 Crockford base32 symbols carrying 128 random bits', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const code = newRecoveryCode();
      expect(code).toHaveLength(RECOVERY_CODE_LENGTH);
      expect(code).toMatch(CROCKFORD);
      expect(parseRecoveryCode(code)).toHaveLength(16);
      seen.add(code);
    }
    expect(seen.size).toBe(50);
  });

  test('bytes round-trip through the code', () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff);
    const code = encodeRecoveryCode(bytes);
    expect(parseRecoveryCode(code)).toEqual(bytes);
    expect(encodeRecoveryCode(new Uint8Array(16))).toBe('0'.repeat(26));
    expect(encodeRecoveryCode(new Uint8Array(16).fill(0xff))).toBe(`7${'Z'.repeat(25)}`);
  });

  test('is shown in groups of five, the last group six', () => {
    expect(formatRecoveryCode('0123456789ABCDEFGHJKMNPQRS')).toBe('01234-56789-ABCDE-FGHJK-MNPQRS');
  });

  test('parsing forgives case, spaces, dashes and look-alike letters', () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => 200 - i * 9);
    const code = encodeRecoveryCode(bytes);
    const typed = formatRecoveryCode(code).toLowerCase().replace(/-/g, ' - ');
    expect(parseRecoveryCode(typed)).toEqual(bytes);
    expect(parseRecoveryCode('O'.repeat(26))).toEqual(new Uint8Array(16));
    expect(parseRecoveryCode(`0${'I'.repeat(24)}L`)).toEqual(parseRecoveryCode(`0${'1'.repeat(25)}`));
  });

  test('rejects wrong lengths, unknown symbols and values over 128 bits', () => {
    expect(parseRecoveryCode('')).toBeUndefined();
    expect(parseRecoveryCode('0'.repeat(25))).toBeUndefined();
    expect(parseRecoveryCode('0'.repeat(27))).toBeUndefined();
    expect(parseRecoveryCode(`U${'0'.repeat(25)}`)).toBeUndefined();
    expect(parseRecoveryCode(`8${'0'.repeat(25)}`)).toBeUndefined();
    expect(parseRecoveryCode(`0${'0'.repeat(24)}*`)).toBeUndefined();
  });
});
