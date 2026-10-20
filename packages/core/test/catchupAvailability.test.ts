import { describe, expect, test } from 'vitest';
import { archiveState, daysLeft } from '../src/catchup/availability.ts';

const H = 3_600_000;
const D = 24 * H;
const NOW = Date.UTC(2026, 9, 20, 20, 0);
const p = (start: number, stop: number) => ({ start, stop });

describe('archiveState', () => {
  test('no catch-up on the channel', () => {
    expect(archiveState(undefined, p(NOW - 2 * H, NOW - H), NOW)).toBe('none');
    expect(archiveState(undefined, p(NOW - H, NOW + H), NOW)).toBe('none');
  });

  test('future, on air and past at their boundaries', () => {
    expect(archiveState(3, p(NOW + 1, NOW + H), NOW)).toBe('future');
    expect(archiveState(3, p(NOW, NOW + H), NOW)).toBe('onAir');
    expect(archiveState(3, p(NOW - H, NOW + 1), NOW)).toBe('onAir');
    expect(archiveState(3, p(NOW - H, NOW), NOW)).toBe('available');
    expect(archiveState(3, p(NOW - 3 * D, NOW - 3 * D + H), NOW)).toBe('available');
    expect(archiveState(3, p(NOW - 3 * D - 1, NOW - 3 * D + H), NOW)).toBe('tooOld');
  });

  test('a refined answer overrides past programmes both ways', () => {
    expect(archiveState(3, p(NOW - 4 * D, NOW - 4 * D + H), NOW, true)).toBe('available');
    expect(archiveState(3, p(NOW - H, NOW - 1), NOW, false)).toBe('none');
    // It never touches on-air or future programmes.
    expect(archiveState(3, p(NOW - H, NOW + H), NOW, false)).toBe('onAir');
    expect(archiveState(3, p(NOW + H, NOW + 2 * H), NOW, true)).toBe('future');
    // Nor a channel without catch-up.
    expect(archiveState(undefined, p(NOW - 2 * H, NOW - H), NOW, true)).toBe('none');
  });
});

test('days left: floored, "last day" below one', () => {
  expect(daysLeft(3, NOW - H, NOW)).toBe(2);
  expect(daysLeft(3, NOW - 2 * D - H, NOW)).toBe(0);
  expect(daysLeft(7, NOW - 10, NOW)).toBe(6);
});
