import { describe, expect, it } from 'vitest';
import {
  ASPECT_MODES, aspectLabel, bannerNowNextStale, createJumpGuard, isModalOpen, nextAspect, playerStatusText, sleepLabel,
} from './playerLogic.ts';

describe('playerStatusText', () => {
  it('maps supervisor states to player copy', () => {
    expect(playerStatusText(undefined)).toBeUndefined();
    expect(playerStatusText({ kind: 'playing' })).toBeUndefined();
    expect(playerStatusText({ kind: 'loading' })).toBeUndefined();
    expect(playerStatusText({ kind: 'reconnecting', attempt: 2 })).toEqual({ kind: 'toast', text: 'Reconnecting… (2/3)' });
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
