import { describe, expect, test } from 'vitest';
import { createLiveReturn, liveToRemember } from './liveReturn.ts';

describe('liveToRemember', () => {
  test('a playing live channel is remembered', () => {
    expect(liveToRemember('ch-1', 'playing')).toBe('ch-1');
  });
  test('nothing current, a channel that is not playing, or a VOD stand-in is not', () => {
    expect(liveToRemember(undefined, 'playing')).toBeUndefined();
    expect(liveToRemember('ch-1', 'loading')).toBeUndefined();
    expect(liveToRemember('ch-1', undefined)).toBeUndefined();
    expect(liveToRemember('vod:s:movie1', 'playing')).toBeUndefined();
  });
});

describe('liveReturn slot', () => {
  test('take returns the remembered id once', () => {
    const slot = createLiveReturn();
    slot.remember('ch-1');
    expect(slot.take()).toBe('ch-1');
    expect(slot.take()).toBeUndefined();
  });
  test('nothing to remember keeps the earlier id (Movies to Series, or back from a VOD title)', () => {
    const slot = createLiveReturn();
    slot.remember('ch-1');
    slot.remember(undefined);
    expect(slot.take()).toBe('ch-1');
  });
});
