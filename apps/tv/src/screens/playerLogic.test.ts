import { describe, expect, it } from 'vitest';
import { POINTER_BAR_H } from '../input/pointerLogic.ts';
import {
  ASPECT_MODES, PLAYER_POINTER_LABELS, WHEEL_ZAP_MIN_MS, aspectLabel, bannerLift, bannerNowNextStale, createJumpGuard, isModalOpen, livePill,
  nextAspect, playerAutoHide, playerLeave, playerOverlayShown, playerStatusText, sleepLabel, wheelZapAllowed,
} from './playerLogic.ts';

describe('playerStatusText', () => {
  it('maps supervisor states to player copy', () => {
    expect(playerStatusText(undefined)).toBeUndefined();
    expect(playerStatusText({ kind: 'playing' })).toBeUndefined();
    expect(playerStatusText({ kind: 'loading' })).toBeUndefined();
    expect(playerStatusText({ kind: 'reconnecting', attempt: 2 })).toEqual({ kind: 'toast', text: 'Reconnecting…' });
    expect(playerStatusText({ kind: 'failed', reason: 'unavailable' }))
      .toEqual({ kind: 'centre', text: "This channel isn't available right now." });
    expect(playerStatusText({ kind: 'failed', reason: 'unsupported' }))
      .toEqual({ kind: 'centre', text: "This stream's format isn't supported on this device." });
  });
});

describe('aspect', () => {
  it('cycles Auto, 16:9, 4:3, Zoom, Stretch', () => {
    expect([...ASPECT_MODES]).toEqual(['auto', '16:9', '4:3', 'zoom', 'stretch']);
    expect(nextAspect('auto')).toBe('16:9');
    expect(nextAspect('stretch')).toBe('auto');
    expect(ASPECT_MODES.map(aspectLabel)).toEqual(['Auto', '16:9', '4:3', 'Zoom', 'Stretch']);
  });
});

describe('sleepLabel', () => {
  it('describes the sleep timer', () => {
    expect(sleepLabel(0, undefined)).toBe('Off');
    expect(sleepLabel(30, 12)).toBe('30 min (12 left)');
    expect(sleepLabel(30, undefined)).toBe('30 min');
  });
});

describe('isModalOpen', () => {
  it('is true while the sleep dialog is asking or the options menu is open', () => {
    expect(isModalOpen('off', undefined)).toBe(false);
    expect(isModalOpen('armed', undefined)).toBe(false);
    expect(isModalOpen('asking', undefined)).toBe(true);
    expect(isModalOpen('off', 'main')).toBe(true);
    expect(isModalOpen('armed', 'audio')).toBe(true);
  });
});

describe('createJumpGuard', () => {
  it('drops a late number-entry answer after a zap press', () => {
    const g = createJumpGuard();
    const jump = g.bump(); // number submitted, byNumber in flight
    g.bump(); // Up pressed
    expect(g.isCurrent(jump)).toBe(false); // the late answer is ignored
  });

  it('keeps only the newest of two jumps resolving out of order', () => {
    const g = createJumpGuard();
    const first = g.bump(); // Red
    const second = g.bump(); // Red again
    expect(g.isCurrent(second)).toBe(true); // the newer answer arrives first and applies
    expect(g.isCurrent(first)).toBe(false); // the older answer arrives late and is dropped
  });

  it('accepts the answer when nothing newer started', () => {
    const g = createJumpGuard();
    expect(g.isCurrent(g.bump())).toBe(true);
  });
});

describe('bannerNowNextStale', () => {
  it('is true for a visible banner showing the playing channel that got now/next', () => {
    expect(bannerNowNextStale(['a', 'b'], 'b', 'b', true)).toBe(true);
  });
  it('is false when the banner is hidden, shows another channel (zap preview) or the channel is not in the update', () => {
    expect(bannerNowNextStale(['b'], 'b', 'b', false)).toBe(false);
    expect(bannerNowNextStale(['b'], 'b', 'c', true)).toBe(false);
    expect(bannerNowNextStale(['a'], 'b', 'b', true)).toBe(false);
    expect(bannerNowNextStale(['a'], undefined, undefined, true)).toBe(false);
  });
});

describe('playerStatusText refused', () => {
  it('refused has its own message', () => {
    expect(playerStatusText({ kind: 'failed', reason: 'refused' }))
      .toEqual({ kind: 'centre', text: 'Your source refused this stream.' });
  });
  it('names the status and the account limit when known (spec §2.8)', () => {
    expect(playerStatusText({ kind: 'failed', reason: 'refused', httpStatus: 403 }, 2)).toEqual({
      kind: 'centre', text: 'Your source refused this stream (403). It allows 2 connections: another device may be using this account.',
    });
    expect(playerStatusText({ kind: 'failed', reason: 'gone', httpStatus: 404 })?.text).toBe("This channel isn't on your source anymore (404).");
    expect(playerStatusText({ kind: 'failed', reason: 'unavailable', httpStatus: 500 })?.text).toBe("This channel isn't available right now (500).");
  });
});

describe('livePill', () => {
  const info = (behindLiveS: number | undefined, source: 'pdt' | 'edge' | 'buffer' = 'edge') =>
    ({ behindLiveS, source, targetS: 6, stalls: 0, reconnects: 0 });
  it('nothing while loading, reconnecting or failed', () => {
    expect(livePill(undefined, undefined)).toBeUndefined();
    expect(livePill({ kind: 'loading' }, info(30))).toBeUndefined();
    expect(livePill({ kind: 'reconnecting', attempt: 1 }, info(30))).toBeUndefined();
    expect(livePill({ kind: 'failed', reason: 'unavailable' }, info(30))).toBeUndefined();
  });
  it('LIVE when close to the target, or when only the buffer is known', () => {
    expect(livePill({ kind: 'playing' }, info(9))).toEqual({ text: 'LIVE' });
    expect(livePill({ kind: 'playing' }, info(undefined, 'buffer'))).toEqual({ text: 'LIVE' });
    expect(livePill({ kind: 'playing' }, undefined)).toEqual({ text: 'LIVE' });
  });
  it('−N s with a Go live hint when more than 3 s past the target', () => {
    expect(livePill({ kind: 'playing' }, info(21.6))).toEqual({ text: '−22 s', hint: 'OK: Go live' });
  });
});

describe('livePill: final fixes', () => {
  it('1h: no pill at all on a non-live stream', () => {
    const vod = { behindLiveS: 635, source: 'edge' as const, targetS: 6, stalls: 0, reconnects: 0, isLive: false };
    expect(livePill({ kind: 'playing' }, vod)).toBeUndefined();
    expect(livePill({ kind: 'playing' }, { ...vod, isLive: true })).toEqual({ text: '−635 s', hint: 'OK: Go live' });
  });
  it('2: the pill steers by the edge distance, not the stream clock', () => {
    const info = { behindLiveS: 7, source: 'edge' as const, streamClockBehindS: 40, targetS: 6, stalls: 0, reconnects: 0 };
    expect(livePill({ kind: 'playing' }, info)).toEqual({ text: 'LIVE' });
  });
});

describe('pointer overlay', () => {
  it('shows in pointer mode, except while the options menu or the sleep question is open', () => {
    expect(playerOverlayShown(true, false)).toBe(true);
    expect(playerOverlayShown(true, true)).toBe(false);
    expect(playerOverlayShown(false, false)).toBe(false);
  });

  it('hides after 3 s idle only while the pointer is not over one of its buttons and no modal is open', () => {
    expect(playerAutoHide({ overButton: false, modalOpen: false })).toBe(true);
    expect(playerAutoHide({ overButton: true, modalOpen: false })).toBe(false);
    expect(playerAutoHide({ overButton: false, modalOpen: true })).toBe(false);
  });

  it('lifts the info banner above the bottom row while the row is shown', () => {
    expect(bannerLift(false)).toBe(0);
    expect(bannerLift(true)).toBe(POINTER_BAR_H + 24);
  });

  it('uses the spec copy', () => {
    expect(PLAYER_POINTER_LABELS).toEqual({
      back: '← Back', channelUp: '▲ Ch+', channelDown: '▼ Ch−', previous: '⟲ Previous',
      info: 'ⓘ Info', options: '☰ Options', guide: '▦ Guide', window: '⛶ Window',
    });
  });
});

describe('playerLeave', () => {
  it('to Home: the last channel to focus and the preview hold', () => {
    expect(playerLeave('home', 'c1')).toEqual({ params: { focusChannelId: 'c1' }, holdPreview: true });
    expect(playerLeave('home', undefined)).toEqual({ holdPreview: true });
  });

  it('to Start or Search: no focus param and no hold (they would suppress a later Home resume)', () => {
    for (const below of ['start', 'search', 'startSports', undefined] as const) {
      expect(playerLeave(below, 'c1')).toEqual({ holdPreview: false });
    }
  });
});

describe('wheelZapAllowed (trackpad inertia never zaps through many channels)', () => {
  it('allows the first wheel zap, then one every 300 ms at most', () => {
    expect(WHEEL_ZAP_MIN_MS).toBe(300);
    expect(wheelZapAllowed(undefined, 1000)).toBe(true);
    expect(wheelZapAllowed(1000, 1120)).toBe(false);
    expect(wheelZapAllowed(1000, 1299)).toBe(false);
    expect(wheelZapAllowed(1000, 1300)).toBe(true);
  });
});
