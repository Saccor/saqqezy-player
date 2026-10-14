import { describe, expect, it } from 'vitest';
import { formatRange, pickGroup, previewMessage, progressOf, restoreIndex } from './homeLogic.ts';

const groups = [
  { id: 'fav', name: 'Favourites', count: 0 },
  { id: 'all', name: 'All channels', count: 200 },
  { id: 'g:News', name: 'News', count: 50 },
];

describe('home logic', () => {
  it('picks the wanted group, else All channels, else the first group', () => {
    expect(pickGroup(groups, 'g:News')).toBe('g:News');
    expect(pickGroup(groups, 'g:Gone')).toBe('all');
    expect(pickGroup(groups, undefined)).toBe('all');
    expect(pickGroup([{ id: 'fav', name: 'Favourites', count: 0 }], 'x')).toBe('fav');
    expect(pickGroup([], 'x')).toBeUndefined();
  });

  it('restores focus by channel id, falling back to the remembered index, then the first row', () => {
    expect(restoreIndex(7, 3, 200)).toBe(7);
    expect(restoreIndex(-1, 3, 200)).toBe(3);
    expect(restoreIndex(-1, 250, 200)).toBe(199);
    expect(restoreIndex(-1, undefined, 200)).toBe(0);
    expect(restoreIndex(-1, 5, 0)).toBe(0);
  });

  it('formats a programme time range and its progress', () => {
    const start = new Date(2026, 9, 14, 18, 0).getTime();
    const stop = new Date(2026, 9, 14, 19, 30).getTime();
    expect(formatRange(start, stop)).toBe('18:00–19:30');
    expect(progressOf({ start, stop }, start - 1000)).toBe(0);
    expect(progressOf({ start, stop }, start + 45 * 60_000)).toBeCloseTo(0.5);
    expect(progressOf({ start, stop }, stop + 1)).toBe(1);
    expect(progressOf(undefined, start)).toBe(0);
  });

  it('maps the supervisor status to preview copy', () => {
    expect(previewMessage(undefined, false)).toBe('Preview');
    expect(previewMessage({ kind: 'playing' }, true)).toBeUndefined();
    expect(previewMessage({ kind: 'loading' }, true)).toBe('Loading…');
    expect(previewMessage({ kind: 'failed', reason: 'unavailable' }, true)).toBe("This channel isn't available right now");
    expect(previewMessage({ kind: 'failed', reason: 'unsupported' }, true)).toContain("isn't supported");
  });
});
