import { describe, expect, test } from 'vitest';
import { AutoMute } from './autoMute.ts';

describe('AutoMute', () => {
  test('mute() mutes and remembers; release() unmutes once', () => {
    const media = { muted: false };
    const m = new AutoMute(media);
    expect(m.mute()).toBe(true);
    expect(media.muted).toBe(true);
    expect(m.active).toBe(true);
    m.release();
    expect(media.muted).toBe(false);
    expect(m.active).toBe(false);
    media.muted = true; // muted by someone else afterwards
    m.release();
    expect(media.muted).toBe(true);
  });

  test('mute() on an already muted element does nothing and is not remembered', () => {
    const media = { muted: true };
    const m = new AutoMute(media);
    expect(m.mute()).toBe(false);
    expect(m.active).toBe(false);
    m.release();
    expect(media.muted).toBe(true);
  });

  test('release() without a prior auto-mute leaves the element alone', () => {
    const media = { muted: false };
    const m = new AutoMute(media);
    m.release();
    expect(media.muted).toBe(false);
  });

  test('releaseIfActivated() clears the mute only after user activation', () => {
    const media = { muted: false };
    const m = new AutoMute(media);
    m.mute();
    m.releaseIfActivated(undefined);
    expect(media.muted).toBe(true);
    m.releaseIfActivated({ hasBeenActive: false });
    expect(media.muted).toBe(true);
    m.releaseIfActivated({ hasBeenActive: true });
    expect(media.muted).toBe(false);
    expect(m.active).toBe(false);
  });
});
