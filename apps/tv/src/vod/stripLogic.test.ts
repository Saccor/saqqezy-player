import { describe, expect, test } from 'vitest';
import { joinMeta, tileStatus } from './stripLogic.ts';

describe('stripLogic', () => {
  test('status: episode badge, progress, watched, versions', () => {
    expect(tileStatus({ watched: false })).toBe('');
    expect(tileStatus({ watched: true })).toBe('Watched');
    expect(tileStatus({ watched: false, progress: 0.384 })).toBe('38% watched');
    expect(tileStatus({ watched: false, badge: 'S2 · E4', progress: 0.5 })).toBe('S2 · E4 · 50% watched');
    expect(tileStatus({ watched: false, versions: 3 })).toBe('3 versions');
    expect(tileStatus({ watched: true, versions: 1 })).toBe('Watched');
  });
  test('joinMeta skips empty parts', () => {
    expect(joinMeta('2024', '', undefined, 'Drama')).toBe('2024 · Drama');
    expect(joinMeta()).toBe('');
  });
});
