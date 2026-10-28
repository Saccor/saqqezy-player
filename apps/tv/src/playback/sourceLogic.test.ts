import { describe, expect, it } from 'vitest';
import type { LiveSourceView } from '@iptv/app-api';
import { cellBadge, rowIdOf, sourceLabel, sourceOptions, sourcesLine } from './sourceLogic.ts';

const v = (id: string, label: string, extra: Partial<LiveSourceView> = {}): LiveSourceView =>
  ({ id, label, bad: false, blocked: false, ...extra });

describe('Choose source', () => {
  it('labels: name, quality when the name lacks it, then Auto / Playing / Didn’t play', () => {
    expect(sourceLabel(v('a', 'Channel One 4K', { quality: '4K' }), 0, 'a')).toBe('Channel One 4K · Auto · Playing');
    expect(sourceLabel(v('b', 'Channel One', { quality: 'HD' }), 1, 'a')).toBe('Channel One · HD');
    expect(sourceLabel(v('c', 'Channel One (backup)', { bad: true }), 2, 'a')).toBe("Channel One (backup) · Didn't play");
    expect(sourceLabel(v('d', 'Channel One HD', { quality: 'HD' }), 3, undefined)).toBe('Channel One HD');
  });
  it('options: one per stream, best first, ids are the stream ids', () => {
    expect(sourceOptions([v('a', 'One'), v('b', 'Two')], 'b')).toEqual([
      { id: 'a', label: 'One · Auto' },
      { id: 'b', label: 'Two · Playing' },
    ]);
  });
});

describe('row badge and info line', () => {
  it('the cell badge: the best quality, else the stream count; nothing for a single stream', () => {
    expect(cellBadge('4K', 3)).toBe('4K');
    expect(cellBadge(undefined, 2)).toBe('×2');
    expect(cellBadge(undefined, undefined)).toBe('');
    expect(cellBadge(undefined, 1)).toBe('');
  });
  it('the info line: quality and count', () => {
    expect(sourcesLine('4K', 3)).toBe('4K · 3 sources');
    expect(sourcesLine(undefined, 2)).toBe('2 sources');
    expect(sourcesLine('HD', undefined)).toBe('');
    expect(sourcesLine(undefined, 1)).toBe('');
  });
  it('the row a playable belongs to', () => {
    expect(rowIdOf({ id: 's:5', rowId: 's:1' })).toBe('s:1');
    expect(rowIdOf({ id: 's:2' })).toBe('s:2');
    expect(rowIdOf(undefined)).toBeUndefined();
  });
});
