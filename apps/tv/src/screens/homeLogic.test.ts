import { describe, expect, it } from 'vitest';
import {
  formatRange, panelChannel, pickGroup, playingInfoStale, previewMessage, progressOf, resolveFocus, restoreIndex,
  resumeTarget, videoClickGroup,
} from './homeLogic.ts';

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
    expect(previewMessage({ kind: 'failed', reason: 'refused' }, true)).toBe('Your source refused this stream');
    // Home's paused note replaces "Preview" while nothing plays; a channel without a status yet still says "Preview".
    expect(previewMessage(undefined, false, 'Paused after reload: press OK to play')).toBe('Paused after reload: press OK to play');
    expect(previewMessage(undefined, true, 'Paused after reload: press OK to play')).toBe('Preview');
    expect(previewMessage(undefined, false, undefined)).toBe('Preview');
  });

  it('resolves the focus from the first candidate found in the group, in order', async () => {
    const positions: Record<string, number> = { mem: 4, param: 9 };
    const indexOf = async (id: string) => positions[id] ?? -1;
    expect(await resolveFocus(['playing', 'mem', 'param'], indexOf)).toEqual({ id: 'mem', index: 4 });
    positions.playing = 2;
    expect(await resolveFocus(['playing', 'mem', 'param'], indexOf)).toEqual({ id: 'playing', index: 2 });
    expect(await resolveFocus([undefined, undefined, 'param'], indexOf)).toEqual({ id: 'param', index: 9 });
    expect(await resolveFocus([undefined, 'gone'], indexOf)).toEqual({ id: undefined, index: -1 });
    const seen: string[] = [];
    await resolveFocus(['x', 'x', 'mem'], async (id) => { seen.push(id); return indexOf(id); });
    expect(seen).toEqual(['x', 'mem']);
  });

  it('the preview panel shows the playing channel, or the focused one while a preview is starting', () => {
    const focused = { id: 'f' };
    const playing = { id: 'p' };
    expect(panelChannel(focused, playing, false)).toEqual({ channel: playing, starting: false });
    expect(panelChannel(focused, playing, true)).toEqual({ channel: focused, starting: true });
    expect(panelChannel(focused, undefined, false)).toEqual({ channel: focused, starting: false });
    expect(panelChannel(undefined, playing, true)).toEqual({ channel: playing, starting: false });
    expect(panelChannel(undefined, undefined, false)).toEqual({ channel: undefined, starting: false });
  });
});

describe('playingInfoStale', () => {
  it('is true when the playing channel got now/next and is not the focused row', () => {
    expect(playingInfoStale(['a', 'b'], 'b', 'c')).toBe(true);
    expect(playingInfoStale(['a', 'b'], 'b', undefined)).toBe(true);
  });
  it('is false when the playing row is focused (the slice cache refreshes it) or not in the update', () => {
    expect(playingInfoStale(['a', 'b'], 'b', 'b')).toBe(false);
    expect(playingInfoStale(['a'], 'b', 'c')).toBe(false);
    expect(playingInfoStale(['a'], undefined, 'c')).toBe(false);
  });
});

describe('videoClickGroup (fullscreen from a click on the small video)', () => {
  it('keeps the open group, and remembers the channel, when the video shows the focused row', () => {
    expect(videoClickGroup('ch-1', 'ch-1', 'g:News')).toEqual({ groupId: 'g:News', remember: true });
  });
  it('uses All channels and leaves the remembered channel alone when the playing channel is not the focused row', () => {
    expect(videoClickGroup('ch-1', 'ch-2', 'g:News')).toEqual({ groupId: 'all', remember: false });
    expect(videoClickGroup('ch-1', undefined, 'g:News')).toEqual({ groupId: 'all', remember: false });
    expect(videoClickGroup('ch-1', 'ch-1', undefined)).toEqual({ groupId: 'all', remember: false });
  });
});

describe('resumeTarget', () => {
  const base = { playingId: undefined, lastChannelId: undefined, found: undefined, startupDone: false, held: false };

  it('resumes nothing on a first start with no last channel', () => {
    expect(resumeTarget(base)).toBeUndefined();
  });

  it('never resumes a remembered browse row (Settings or Guide and back)', () => {
    // The row the user browsed to is what openGroup found, but it was never played.
    expect(resumeTarget({ ...base, found: 'ch-5', startupDone: true })).toBeUndefined();
    expect(resumeTarget({ ...base, found: 'ch-5', lastChannelId: 'ch-1', startupDone: true })).toBeUndefined();
  });

  it('resumes nothing on the return after a sleep-timer stop', () => {
    expect(resumeTarget({ ...base, found: 'ch-3', lastChannelId: 'ch-3', startupDone: true, held: true })).toBeUndefined();
    expect(resumeTarget({ ...base, found: 'ch-3', lastChannelId: 'ch-3', held: true })).toBeUndefined();
  });

  it('re-plays the playing channel on the return from the Player', () => {
    expect(resumeTarget({ ...base, playingId: 'ch-7', found: 'ch-7', lastChannelId: 'ch-1', startupDone: true })).toBe('ch-7');
  });

  it('resumes the last channel on the first startup only, and only when it was found', () => {
    expect(resumeTarget({ ...base, lastChannelId: 'ch-1', found: 'ch-1' })).toBe('ch-1');
    expect(resumeTarget({ ...base, lastChannelId: 'ch-1', found: 'ch-1', startupDone: true })).toBeUndefined();
    // Gone or hidden: openGroup focused another row instead.
    expect(resumeTarget({ ...base, lastChannelId: 'ch-1', found: 'ch-2' })).toBeUndefined();
  });
});
