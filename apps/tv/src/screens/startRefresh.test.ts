import { describe, expect, it } from 'vitest';
import type { StartHome, StartRow, VodTile } from '@iptv/app-api';
import { sameStartRows } from './startLogic.ts';

const row = (title: string): StartRow => ({
  id: 'continue' as StartRow['id'],
  title,
  cells: [{ type: 'vod', tile: { id: 'v1', kind: 'movie', title: 'Demo Film' } as VodTile }],
});
const home = (title: string, at: number): StartHome => ({ rows: [row(title)], at });

describe('sameStartRows', () => {
  it('a 30 s re-read with the same rows (a fresh clone, a new `at`) is the same page: nothing is set', () => {
    expect(sameStartRows(home('Continue watching', 1), home('Continue watching', 2))).toBe(true);
  });

  it('a changed row, or no page yet, is a change', () => {
    expect(sameStartRows(home('Continue watching', 1), home('Recently added', 1))).toBe(false);
    expect(sameStartRows(undefined, home('Continue watching', 1))).toBe(false);
  });
});
