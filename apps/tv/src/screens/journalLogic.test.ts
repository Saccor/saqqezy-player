import { describe, expect, it } from 'vitest';
import type { JournalEvent } from '@iptv/player';
import { eventText, formatEvent, journalSummary, journalText, logRows, logTime } from './journalLogic.ts';

// Local-time stamps, so the expectations hold in any time zone.
const at = (h: number, m: number, s: number, day = 14) => new Date(2026, 9, day, h, m, s).getTime();
const NOW = at(22, 10, 0);

describe('logTime', () => {
  it('shows HH:MM:SS today and DD/MM HH:MM:SS on other days', () => {
    expect(logTime(at(22, 9, 14), NOW)).toBe('22:09:14');
    expect(logTime(at(8, 5, 3, 13), NOW)).toBe('13/10 08:05:03');
  });
});

describe('eventText', () => {
  const t = 0;
  it.each<[JournalEvent, string]>([
    [{ k: 'page', t, what: 'load', nav: 'reload' }, 'Page reload'],
    [{ k: 'page', t, what: 'load', nav: 'navigate' }, 'App started'],
    [{ k: 'page', t, what: 'load' }, 'App started'],
    [{ k: 'page', t, what: 'hidden' }, 'App in background'],
    [{ k: 'page', t, what: 'visible' }, 'App back in front'],
    [{ k: 'play', t, channel: 'Channel X', preset: 'balanced', urls: 2 }, 'Play · Channel X · Balanced'],
    [{ k: 'play', t, preset: 'stable', urls: 1 }, 'Play · Channel · Stable'],
    [{ k: 'open', t, attempt: 2, urlIndex: 0 }, 'Connect (attempt 2)'],
    [{ k: 'open', t, attempt: 3, urlIndex: 1 }, 'Connect (attempt 3) · other format'],
    [{ k: 'playing', t, attempt: 1, firstFrameMs: 1234, engine: 'hls.js' }, 'Playing · hls.js · 1.2 s to picture'],
    [{ k: 'playing', t, attempt: 1 }, 'Playing'],
    [{ k: 'stall', t, phase: 'start', bufferAheadS: 1.26 }, 'Stall · 1.3 s buffered'],
    [{ k: 'stall', t, phase: 'start' }, 'Stall'],
    [{ k: 'stall', t, phase: 'end', durationMs: 700 }, 'Stall over · 0.7 s'],
    [{ k: 'ladder', t, action: 'gapJump' }, 'Skipped a gap in the stream'],
    [{ k: 'ladder', t, action: 'seekLive' }, 'Jumped to live'],
    [{ k: 'ladder', t, action: 'reconnect', reason: 'noBytes' }, 'Stream stuck · no data'],
    [{ k: 'ladder', t, action: 'reconnect', reason: 'frozenVideo' }, 'Stream stuck · picture frozen'],
    [{ k: 'error', t, code: 'AUTH', httpStatus: 403, detail: 'HttpStatusCodeInvalid', engine: 'mpegts.js' },
      'Error · source refused · HTTP 403 · HttpStatusCodeInvalid · mpegts.js'],
    [{ k: 'error', t, code: 'EOS' }, 'Error · source ended the stream'],
    [{ k: 'error', t, code: 'UNKNOWN' }, 'Error · unknown'],
    [{ k: 'reconnect', t, delayMs: 0, cause: 'noBytes' }, 'Reconnect · no data · 0 ms'],
    [{ k: 'reconnect', t, delayMs: 1000, cause: 'EOS' }, 'Reconnect · source ended the stream · 1000 ms'],
    [{ k: 'reconnect', t, delayMs: 0, cause: 'startTimeout' }, 'Reconnect · no picture at start · 0 ms'],
    [{ k: 'reconnect', t, delayMs: 0, cause: 'drift' }, 'Reconnect · far behind live · 0 ms'],
    [{ k: 'alternate', t, urlIndex: 1 }, 'Trying another stream format'],
    [{ k: 'drift', t, action: 'seek', behindS: 14.6, targetS: 6 }, 'Caught up to live · 15 s behind · target 6.0 s'],
    [{ k: 'drift', t, action: 'reopen', behindS: 40, targetS: 6 }, 'Restarted to catch up · 40 s behind · target 6.0 s'],
    [{ k: 'drift', t, action: 'rate', rate: 1.05, behindS: 9, targetS: 6 }, 'Speed 1.05× · 9 s behind · target 6.0 s'],
    [{ k: 'drift', t, action: 'rate', rate: 1, targetS: 6 }, 'Normal speed · target 6.0 s'],
    [{ k: 'failed', t, reason: 'unavailable' }, 'Gave up: stream unavailable'],
    [{ k: 'failed', t, reason: 'refused' }, 'Gave up: source refused'],
    [{ k: 'giveUpRetry', t }, 'Retrying in the background'],
    [{ k: 'stop', t }, 'Stopped'],
  ])('%j → %s', (e, text) => {
    expect(eventText(e)).toBe(text);
  });
});

describe('summary, rows and copy text', () => {
  const entries: JournalEvent[] = [
    { k: 'stall', t: at(21, 30, 0), phase: 'start' }, // older than 30 min: not counted
    { k: 'page', t: at(21, 50, 0), what: 'load', nav: 'reload' },
    { k: 'stall', t: at(22, 0, 0), phase: 'start' },
    { k: 'reconnect', t: at(22, 0, 5), delayMs: 0, cause: 'noBytes' },
    { k: 'stall', t: at(22, 5, 0), phase: 'start' },
    { k: 'reconnect', t: at(22, 5, 5), delayMs: 0, cause: 'noBytes' },
    { k: 'reconnect', t: at(22, 6, 0), delayMs: 0, cause: 'EOS' },
  ];

  it('summarises the last 30 minutes with the top reconnect cause', () => {
    expect(journalSummary(entries, NOW)).toBe('Last 30 min: 2 stalls, 3 reconnects (no data ×2), 1 page reload');
    expect(journalSummary([], NOW)).toBe('Last 30 min: no problems');
    expect(journalSummary([{ k: 'stop', t: at(22, 0, 0) }], NOW)).toBe('Last 30 min: no problems');
  });

  it('formatEvent pairs the time and the text', () => {
    expect(formatEvent({ k: 'stop', t: at(22, 9, 14) }, NOW)).toEqual({ time: '22:09:14', text: 'Stopped' });
  });

  it('rows are newest first with stable ids', () => {
    const rows = logRows(entries.slice(-2), NOW);
    expect(rows).toEqual([
      { id: 'e1', time: '22:06:00', text: 'Reconnect · source ended the stream · 0 ms' },
      { id: 'e0', time: '22:05:05', text: 'Reconnect · no data · 0 ms' },
    ]);
  });

  it('the copy text is the summary, then one line per event, newest first', () => {
    expect(journalText(entries.slice(-1), NOW))
      .toBe('Last 30 min: 1 reconnect (source ended the stream ×1)\n22:06:00  Reconnect · source ended the stream · 0 ms');
  });
});
