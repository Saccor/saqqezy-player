import { describe, expect, test } from 'vitest';
import { compareAirings, isBackupName, qualityRank } from '../src/sports/quality.ts';

describe('quality', () => {
  test('qualityRank from channel name tags', () => {
    expect(qualityRank('Channel 001 4K')).toBe(0);
    expect(qualityRank('Channel 001 UHD')).toBe(0);
    expect(qualityRank('Channel 001 FHD')).toBe(1);
    expect(qualityRank('Channel 001 1080p')).toBe(1);
    expect(qualityRank('Channel 001 HD')).toBe(2);
    expect(qualityRank('Channel 001 SD')).toBe(3);
    expect(qualityRank('Channel 001')).toBe(4);
  });
  test('backup, alt and timeshift names', () => {
    for (const n of ['Channel 002 backup', 'Channel 002 ALT', 'Channel 002 +1', 'Channel 002 (Backup)']) expect(isBackupName(n)).toBe(true);
    for (const n of ['Channel 002', 'Channel 002 HD', 'Alto Channel']) expect(isBackupName(n)).toBe(false);
  });
  test('order: favourite, airing now, not backup, quality, number', () => {
    const k = (name: string, number: number, favourite = false, airingNow = true) => ({ name, number, favourite, airingNow });
    const list = [
      k('Channel 005 SD', 5), k('Channel 004 +1', 4), k('Channel 003 FHD', 3), k('Channel 006 HD', 6, false, false),
      k('Channel 009', 9, true), k('Channel 002 4K', 2),
    ];
    expect([...list].sort(compareAirings).map((x) => x.number)).toEqual([9, 2, 3, 5, 4, 6]);
  });
});
