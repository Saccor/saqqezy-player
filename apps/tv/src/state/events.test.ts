import { describe, expect, it } from 'vitest';
import type { InitState } from '@iptv/app-api';
import { DEFAULT_SETTINGS } from '@iptv/core';
import { initialRoute, offlineAfter, sourcesReaction, toastFor, toastPriority } from './events.ts';

const base: InitState = { sources: [], groups: [], settings: DEFAULT_SETTINGS };

describe('initialRoute', () => {
  it('opens addSource as the root when there are no sources', () => {
    expect(initialRoute(base)).toEqual({ screen: 'addSource', params: {} });
  });

  it('opens home with the last group and channel otherwise', () => {
    const s: InitState = {
      ...base,
      sources: [{ id: 's1', name: 'Mine', kind: 'xtream', active: true }],
      activeSourceId: 's1',
      lastGroupId: 'g2',
      lastChannelId: 'c9',
    };
    expect(initialRoute(s)).toEqual({ screen: 'home', params: { lastGroupId: 'g2', lastChannelId: 'c9' } });
  });

  it('omits missing last ids', () => {
    const s: InitState = { ...base, sources: [{ id: 's1', name: 'Mine', kind: 'm3u', active: true }] };
    expect(initialRoute(s)).toEqual({ screen: 'home', params: {} });
  });
});

describe('toastFor', () => {
  const err = { name: 'SourceNetworkError', message: 'x' };
  it('maps refreshFailed events to neutral copy', () => {
    expect(toastFor({ type: 'refreshFailed', what: 'playlist', sourceId: 's', error: err }))
      .toBe("Couldn't refresh channels. Showing saved list.");
    expect(toastFor({ type: 'refreshFailed', what: 'epg', sourceId: 's', error: err }))
      .toBe("Couldn't refresh the TV guide.");
  });

  it('a remote layout change says it came from the phone; a local one shows nothing', () => {
    expect(toastFor({ type: 'layoutChanged', version: 3, origin: 'remote' })).toBe('Updated from your phone');
    expect(toastFor({ type: 'layoutChanged', version: 3, origin: 'local' })).toBeUndefined();
  });

  it('a remote source change says it came from the phone; a local one shows nothing', () => {
    expect(toastFor({ type: 'sourcesChanged', activeSourceId: 's1', origin: 'remote' })).toBe('Updated from your phone');
    expect(toastFor({ type: 'sourcesChanged', activeSourceId: 's1', origin: 'local' })).toBeUndefined();
  });

  it('ignores other events', () => {
    expect(toastFor({ type: 'refreshed', what: 'playlist', sourceId: 's' })).toBeUndefined();
    expect(toastFor({ type: 'offline', value: true })).toBeUndefined();
  });
});

describe('toastPriority', () => {
  const err = { name: 'SourceNetworkError', message: 'x' };
  it('gives playlist failures precedence over guide failures', () => {
    expect(toastPriority({ type: 'refreshFailed', what: 'playlist', sourceId: 's', error: err }))
      .toBeGreaterThan(toastPriority({ type: 'refreshFailed', what: 'epg', sourceId: 's', error: err }));
  });
});

describe('offlineAfter', () => {
  it('follows offline events', () => {
    expect(offlineAfter(false, { type: 'offline', value: true })).toBe(true);
    expect(offlineAfter(true, { type: 'offline', value: false })).toBe(false);
  });

  it('a network failure without HTTP status sets offline; a successful refresh clears it', () => {
    const net = { name: 'SourceNetworkError', message: 'x' };
    expect(offlineAfter(false, { type: 'refreshFailed', what: 'playlist', sourceId: 's', error: net })).toBe(true);
    expect(offlineAfter(true, { type: 'refreshed', what: 'playlist', sourceId: 's' })).toBe(false);
  });

  it('HTTP and auth failures leave the state alone', () => {
    const http = { name: 'SourceNetworkError', message: 'x', status: 500 };
    const auth = { name: 'SourceAuthError', message: 'x' };
    expect(offlineAfter(false, { type: 'refreshFailed', what: 'epg', sourceId: 's', error: http })).toBe(false);
    expect(offlineAfter(true, { type: 'refreshFailed', what: 'epg', sourceId: 's', error: auth })).toBe(true);
    expect(offlineAfter(true, { type: 'progress', phase: 'epg', count: 1 })).toBe(true);
  });
});

describe('sourcesReaction', () => {
  const one = { activeSourceId: 's1', sources: [{ id: 's1', name: 'A', kind: 'm3u' as const, active: true }] };
  const none = { sources: [] };
  const remote = (activeSourceId?: string) => ({ type: 'sourcesChanged' as const, origin: 'remote' as const, ...(activeSourceId ? { activeSourceId } : {}) });
  const off = { applyState: false, resetToAddSource: false, stopPlayback: false, leavePlayer: false, openHome: false };

  it('ignores changes made on this device: the screen that made them already applied them', () => {
    expect(sourcesReaction({ type: 'sourcesChanged', origin: 'local', activeSourceId: 's2' }, one, 'settings', true)).toEqual(off);
  });

  it('a phone switching the active source re-reads the state and stops the old stream', () => {
    expect(sourcesReaction(remote('s2'), one, 'home', true)).toEqual({ ...off, applyState: true, stopPlayback: true });
  });

  it('keeps playing when the active source did not change (a source added or renamed) or nothing plays', () => {
    expect(sourcesReaction(remote('s1'), one, 'home', true)).toEqual({ ...off, applyState: true });
    expect(sourcesReaction(remote('s2'), one, 'guide', false)).toEqual({ ...off, applyState: true });
  });

  it('the Player leaves for Home when its stream is stopped', () => {
    expect(sourcesReaction(remote('s2'), one, 'player', true)).toEqual({ ...off, applyState: true, stopPlayback: true, leavePlayer: true });
  });

  it('no source left: back to Add source and the stream stops (unless Add source is already open)', () => {
    expect(sourcesReaction(remote(), one, 'home', true)).toEqual({ ...off, applyState: true, resetToAddSource: true, stopPlayback: true });
    expect(sourcesReaction(remote(), one, 'addSource', false)).toEqual({ ...off, applyState: true });
    expect(sourcesReaction(remote(), one, 'player', true).leavePlayer).toBe(false);
  });

  it('the first source arriving while Add source is the empty root opens Home', () => {
    expect(sourcesReaction(remote('s1'), none, 'addSource', false)).toEqual({ ...off, applyState: true, openHome: true });
    expect(sourcesReaction(remote('s2'), one, 'addSource', false)).toEqual({ ...off, applyState: true });
  });
});
