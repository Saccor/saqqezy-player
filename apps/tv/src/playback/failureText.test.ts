import { describe, expect, it } from 'vitest';
import { failureText } from './failureText.ts';

describe('failureText (spec 2026-10-16-source-retry §2.8)', () => {
  it('refused with a known connection limit names the limit', () => {
    expect(failureText({ reason: 'refused', httpStatus: 403, maxConnections: 1 }))
      .toBe('Your source refused this stream (403). It allows 1 connection: another device may be using this account.');
    expect(failureText({ reason: 'refused', httpStatus: 401, maxConnections: 3 }))
      .toBe('Your source refused this stream (401). It allows 3 connections: another device may be using this account.');
  });

  it('refused without a known limit', () => {
    expect(failureText({ reason: 'refused', httpStatus: 403 })).toBe('Your source refused this stream (403).');
    expect(failureText({ reason: 'refused', httpStatus: 403, maxConnections: 0 })).toBe('Your source refused this stream (403).');
  });

  it('refused without a status (a TV-native player) leaves the status out', () => {
    expect(failureText({ reason: 'refused' })).toBe('Your source refused this stream.');
    expect(failureText({ reason: 'refused', maxConnections: 2 }))
      .toBe('Your source refused this stream. It allows 2 connections: another device may be using this account.');
  });

  it('names the limit only for 401, 403 or no status (another device on the account); never for 503', () => {
    expect(failureText({ reason: 'refused', httpStatus: 503, maxConnections: 2 })).toBe('Your source refused this stream (503).');
    expect(failureText({ reason: 'refused', httpStatus: 500, maxConnections: 2 })).toBe('Your source refused this stream (500).');
    expect(failureText({ reason: 'refused', httpStatus: 401, maxConnections: 2 })).toContain('another device');
  });

  it('rate limits say the source is limiting connections', () => {
    for (const s of [429, 458, 509]) {
      expect(failureText({ reason: 'refused', httpStatus: s, maxConnections: 2 })).toBe(`Your source is limiting connections (${s}).`);
    }
  });

  it('gone says the item is no longer on the source', () => {
    expect(failureText({ reason: 'gone', httpStatus: 404 })).toBe("This channel isn't on your source anymore (404).");
    expect(failureText({ reason: 'gone', httpStatus: 410 })).toBe("This channel isn't on your source anymore (410).");
    expect(failureText({ reason: 'gone' })).toBe("This channel isn't on your source anymore.");
    expect(failureText({ reason: 'gone', httpStatus: 404 }, 'video')).toBe("This video isn't on your source anymore (404).");
  });

  it("unavailable keeps today's text, plus the status when known", () => {
    expect(failureText({ reason: 'unavailable' })).toBe("This channel isn't available right now.");
    expect(failureText({ reason: 'unavailable', httpStatus: 500 })).toBe("This channel isn't available right now (500).");
    expect(failureText({ reason: 'unavailable', httpStatus: 503 }, 'stream')).toBe("This channel isn't available right now (503).");
    expect(failureText({ reason: 'unavailable' }, 'video')).toBe("This video can't play right now.");
    expect(failureText({ reason: 'unavailable', httpStatus: 502 }, 'video')).toBe("This video can't play right now (502).");
  });

  it('unsupported keeps each screen\'s text', () => {
    expect(failureText({ reason: 'unsupported' }, 'stream')).toBe("This stream's format isn't supported on this device.");
    expect(failureText({ reason: 'unsupported' }, 'channel')).toBe("This channel's format isn't supported on this device.");
    expect(failureText({ reason: 'unsupported' }, 'video')).toBe("This video format can't play on this device.");
  });

  it('the copy stays neutral', () => {
    const all = [
      failureText({ reason: 'refused', httpStatus: 403, maxConnections: 2 }),
      failureText({ reason: 'refused', httpStatus: 429 }),
      failureText({ reason: 'gone', httpStatus: 404 }),
      failureText({ reason: 'unavailable', httpStatus: 500 }),
    ].join(' ');
    expect(all).not.toMatch(/https?:|www\.|free|buy|subscribe/i);
  });
});
