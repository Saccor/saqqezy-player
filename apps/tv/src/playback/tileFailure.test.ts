import { describe, expect, it } from 'vitest';
import { RETRY_REST_MS, tileFailure } from './tileFailure.ts';

describe('tileFailure', () => {
  const at = 100_000;

  it('a refused window explains why; Retry waits 3 s, Close is always there', () => {
    const v = tileFailure({ reason: 'refused', httpStatus: 403, maxConnections: 2, at, now: at + 2_999 });
    expect(v.text).toBe('Your source refused another stream (403). It reports 2 connections.');
    expect(v.retry).toEqual({ enabled: false, inMs: 1 });
    expect(v.close).toBe(true);
    expect(tileFailure({ reason: 'refused', httpStatus: 403, at, now: at + RETRY_REST_MS }).retry).toEqual({ enabled: true, inMs: 0 });
  });

  it('a source that cut the oldest stream, or refused again and again, says so', () => {
    expect(tileFailure({ reason: 'refused', kicked: 2, at, now: at }).text).toBe('Your source seems to allow 2 streams at once.');
    expect(tileFailure({ reason: 'refused', httpStatus: 403, escalated: true, at, now: at }).text)
      .toBe('Your source refused extra streams several times. Try again in a few minutes.');
  });

  it('the TV refused a second picture: says so, whatever the stream did', () => {
    expect(tileFailure({ reason: 'unsupported', deviceLimit: true, at, now: at }).text).toBe('This TV can show one channel at a time.');
  });

  it('other failures use the window wording', () => {
    expect(tileFailure({ reason: 'unavailable', at, now: at }).text).toBe("This channel can't play right now.");
  });

  it('a window the cooldown holds is never black: the cooldown text, Retry now and Close window', () => {
    const cooldown = { state: 'waiting' as const, until: at + 150_000, reason: 'refused' as const };
    const v = tileFailure({ reason: 'refused', cooldown, at, now: at });
    expect(v.text).toBe("Your source is refusing connections. The app is waiting so you don't get blocked.");
    expect(v.retry).toEqual({ enabled: true, inMs: 0 });
    expect(v.retryNow).toBe(true);
    expect(v.hint).toBe('Trying again in 3 min');
    expect(v.close).toBe(true);
    // Unreachable says so; a clear cooldown changes nothing.
    expect(tileFailure({ reason: 'unavailable', cooldown: { ...cooldown, reason: 'unreachable' }, at, now: at }).text)
      .toBe("Your source isn't answering. The app is waiting so it doesn't flood it.");
    expect(tileFailure({ reason: 'unavailable', cooldown: { state: 'clear' }, at, now: at }).retryNow).toBeUndefined();
  });
});
