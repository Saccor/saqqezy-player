import { describe, expect, it } from 'vitest';
import {
  ASPECT_MODES, aspectLabel, bannerNowNextStale, createJumpGuard, isModalOpen, livePill, nextAspect, playerStatusText, sleepLabel,
} from './playerLogic.ts';

describe('playerStatusText', () => {
  it('maps supervisor states to player copy', () => {
    expect(playerStatusText(undefined)).toBeUndefined();
    expect(playerStatusText({ kind: 'playing' })).toBeUndefined();
    expect(playerStatusText({ kind: 'loading' })).toBeUndefined();
    expect(playerStatusText({ kind: 'reconnecting', attempt: 2 })).toEqual({ kind: 'toast', text: 'Reconnecting…' });
    expect(playerStatusText({ kind: 'failed', reason: 'unavailable' }))
      .toEqual({ kind: 'centre', text: "This channel isn't available right now" });
    expect(playerStatusText({ kind: 'failed', reason: 'unsupported' }))
      .toEqual({ kind: 'centre', text: "This stream's format isn't supported on this device" });
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
      .toEqual({ kind: 'centre', text: 'Your source refused this stream' });
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
