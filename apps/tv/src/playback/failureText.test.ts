import { describe, expect, it } from 'vitest';
import { FAILURE_COPY } from '../copy/failure.ts';
import { failureText } from './failureText.ts';

describe('failureText: five messages (spec 2026-10-26 §1.4)', () => {
  it('unavailable: couldn\'t reach the source, with the status when known', () => {
    expect(failureText({ reason: 'unavailable' })).toBe("Couldn't reach the source.");
    expect(failureText({ reason: 'unavailable', httpStatus: 503 })).toBe("Couldn't reach the source (503).");
  });
  it('refused: the source refused; a known account limit adds one short sentence (401, 403 or no status only)', () => {
    expect(failureText({ reason: 'refused' })).toBe('The source refused this stream.');
    expect(failureText({ reason: 'refused', httpStatus: 429 })).toBe('The source refused this stream (429).');
    expect(failureText({ reason: 'refused', httpStatus: 403, maxConnections: 1 })).toBe('The source refused this stream (403). It allows 1 connection.');
    expect(failureText({ reason: 'refused', maxConnections: 3 })).toBe('The source refused this stream. It allows 3 connections.');
    expect(failureText({ reason: 'refused', httpStatus: 503, maxConnections: 2 })).toBe('The source refused this stream (503).');
    expect(failureText({ reason: 'refused', httpStatus: 403, maxConnections: 0 })).toBe('The source refused this stream (403).');
  });
  it('unsupported: no picture', () => {
    expect(failureText({ reason: 'unsupported' })).toBe(FAILURE_COPY.noPicture);
  });
  it('gone: try another source', () => {
    expect(failureText({ reason: 'gone' })).toBe('Gone from the source. Try another source.');
    expect(failureText({ reason: 'gone', httpStatus: 404 })).toBe('Gone from the source (404). Try another source.');
  });
  it('every message fits one line and stays neutral', () => {
    const all = [
      failureText({ reason: 'refused', httpStatus: 403, maxConnections: 10 }), failureText({ reason: 'unavailable', httpStatus: 503 }),
      failureText({ reason: 'gone', httpStatus: 410 }), failureText({ reason: 'unsupported' }), FAILURE_COPY.noSound, FAILURE_COPY.noSoundTryTrack,
    ];
    for (const s of all) expect(s.length, s).toBeLessThanOrEqual(70);
    expect(all.join(' ')).not.toMatch(/https?:|www\.|free|buy|subscribe|provider/i);
  });
});
