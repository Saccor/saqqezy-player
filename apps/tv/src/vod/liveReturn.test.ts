import { describe, expect, test } from 'vitest';
import { createLiveReturn, liveToRemember } from './liveReturn.ts';

describe('liveToRemember', () => {
  test('a live channel that plays, loads or reconnects is remembered', () => {
    expect(liveToRemember('ch-1', 'playing')).toBe('ch-1');
    expect(liveToRemember('ch-1', 'loading')).toBe('ch-1');
    expect(liveToRemember('ch-1', 'reconnecting')).toBe('ch-1');
  });
  test('nothing current, a failed or held channel (no status), or a VOD stand-in is not', () => {
    expect(liveToRemember(undefined, 'playing')).toBeUndefined();
    expect(liveToRemember('ch-1', 'failed')).toBeUndefined();
    expect(liveToRemember('ch-1', undefined)).toBeUndefined();
    expect(liveToRemember('vod:s:movie1', 'playing')).toBeUndefined();
  });
});

describe('liveReturn slot', () => {
  test('take returns the remembered id once, for the same source', () => {
    const slot = createLiveReturn();
    slot.remember('ch-1', 'src-a');
    expect(slot.take('src-a')).toBe('ch-1');
    expect(slot.take('src-a')).toBeUndefined();
  });
  test('nothing to remember keeps the earlier id (Movies to Series, or back from a VOD title)', () => {
    const slot = createLiveReturn();
    slot.remember('ch-1', 'src-a');
    slot.remember(undefined, 'src-a');
    expect(slot.take('src-a')).toBe('ch-1');
  });
  test('a channel of another source is dropped: the active source changed meanwhile', () => {
    const slot = createLiveReturn();
    slot.remember('ch-1', 'src-a');
    expect(slot.take('src-b')).toBeUndefined();
    expect(slot.take('src-a')).toBeUndefined();
    slot.remember('ch-1', undefined);
    expect(slot.take(undefined)).toBeUndefined();
  });
});
