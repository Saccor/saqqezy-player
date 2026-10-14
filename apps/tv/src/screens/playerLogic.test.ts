import { describe, expect, it } from 'vitest';
import { ASPECT_MODES, aspectLabel, nextAspect, playerStatusText, sleepLabel } from './playerLogic.ts';

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
