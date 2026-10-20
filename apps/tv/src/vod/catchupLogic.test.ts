import { describe, expect, it } from 'vitest';
import type { CatchupPlayable } from '@iptv/app-api';
import {
  EARLY_END_MS, MISSING_TTL_MS, archiveLine, canFromStart, archiveStateOf, catchupPosition, catchupSubtitle, catchupVodPlayable, createMissingMarks,
  endCardActions, guideOkAction, notAvailableFailure, reopenAllowed, reopenStartMs, seekLimitMs, seekPlan,
} from './catchupLogic.ts';

const H = 3_600_000;
const D = 24 * H;
const NOW = new Date(2026, 9, 20, 20, 0).getTime();

describe('archive state and the details line', () => {
  it('mirrors the worker rule at its boundaries', () => {
    expect(archiveStateOf(undefined, { start: NOW - 2 * H, stop: NOW - H }, NOW)).toBe('none');
    expect(archiveStateOf(3, { start: NOW + 1, stop: NOW + H }, NOW)).toBe('future');
    expect(archiveStateOf(3, { start: NOW - H, stop: NOW + 1 }, NOW)).toBe('onAir');
    expect(archiveStateOf(3, { start: NOW - 3 * D, stop: NOW - 3 * D + H }, NOW)).toBe('available');
    expect(archiveStateOf(3, { start: NOW - 3 * D - 1, stop: NOW - 3 * D + H }, NOW)).toBe('tooOld');
    expect(archiveStateOf(3, { start: NOW - 4 * D, stop: NOW - 4 * D + H }, NOW, true)).toBe('available');
    expect(archiveStateOf(3, { start: NOW - H, stop: NOW - 1 }, NOW, false)).toBe('none');
  });

  it('says how long a programme stays, or why it cannot play', () => {
    expect(archiveLine('available', 3, { start: NOW - H, stop: NOW }, NOW)).toBe('Catch-up · 2 days left');
    expect(archiveLine('available', 3, { start: NOW - 2 * D - H, stop: NOW - 2 * D }, NOW)).toBe('Catch-up · Last day');
    expect(archiveLine('onAir', 3, { start: NOW - H, stop: NOW + H }, NOW)).toBe('From the start available');
    expect(archiveLine('tooOld', 3, { start: NOW - 5 * D, stop: NOW - 5 * D + H }, NOW)).toBe('Not available: older than 3 days');
    expect(archiveLine('none', undefined, { start: NOW - 2 * H, stop: NOW - H }, NOW)).toBe('Not available on this channel');
    expect(archiveLine('none', undefined, { start: NOW - H, stop: NOW + H }, NOW)).toBeUndefined();
    expect(archiveLine('future', 3, { start: NOW + H, stop: NOW + 2 * H }, NOW)).toBeUndefined();
  });

  it('Ok: archive for an available past programme, live on air, details otherwise', () => {
    expect(guideOkAction('available', false)).toBe('catchup');
    expect(guideOkAction('onAir', true)).toBe('live');
    expect(guideOkAction('none', true)).toBe('live');
    for (const s of ['none', 'tooOld', 'future'] as const) expect(guideOkAction(s, false)).toBe('details');
  });
});

describe('the catch-up player', () => {
  const c: CatchupPlayable = {
    kind: 'catchup', channelId: 's:x1', channelName: 'Channel 001', title: 'Programme 4', start: NOW - 2 * H, stop: NOW - H,
    openedAtMs: 0, url: 'http://x.test/timeshift/u/p/61/s/1.ts', alternateUrl: 'http://x.test/streaming/timeshift.php?x=1',
    stepMs: 60_000, headers: { userAgent: 'SyntheticAgent/1.0' }, cooldownKey: 'k',
  };

  it('plays a stand-in title with the programme length, no resume and no remembered tracks', () => {
    expect(catchupVodPlayable(c)).toEqual({
      kind: 'movie', itemId: `catchup:s:x1:${c.start}`, url: c.url, alternateUrl: c.alternateUrl, title: 'Programme 4',
      episodeLabel: catchupSubtitle('Channel 001', c.start, c.stop), resumeMs: 0, durationMs: H, tracks: {},
      headers: { userAgent: 'SyntheticAgent/1.0' }, cooldownKey: 'k',
    });
    expect(catchupSubtitle('Channel 001', new Date(2026, 9, 20, 18, 0).getTime(), new Date(2026, 9, 20, 19, 30).getTime()))
      .toBe('Channel 001 · Tue 18:00–19:30');
  });

  it('position is the URL start plus the engine playhead', () => {
    expect(catchupPosition(120_000, 5_000)).toBe(125_000);
  });

  it('a programme on air is clamped to now; an ended one to its length', () => {
    expect(seekLimitMs({ start: NOW - H, stop: NOW + H }, NOW)).toBe(H);
    expect(seekLimitMs({ start: NOW - 2 * H, stop: NOW - H }, NOW)).toBe(H);
  });

  it('seeks in place when the open stream covers the target, else re-opens', () => {
    expect(seekPlan(600_000, 0, 3_600_000)).toEqual({ kind: 'inPlace', engineMs: 600_000 });
    expect(seekPlan(600_000, 120_000, 3_600_000)).toEqual({ kind: 'inPlace', engineMs: 480_000 });
    expect(seekPlan(60_000, 120_000, 3_600_000)).toEqual({ kind: 'reopen', offsetMs: 60_000 });
    expect(seekPlan(600_000, 0, undefined)).toEqual({ kind: 'reopen', offsetMs: 600_000 });
    expect(seekPlan(600_000, 0, Number.POSITIVE_INFINITY)).toEqual({ kind: 'reopen', offsetMs: 600_000 });
    expect(seekPlan(600_000, 0, 300_000)).toEqual({ kind: 'reopen', offsetMs: 600_000 });
  });

  it('the remainder below the step is kept for HLS and dropped for TS', () => {
    expect(reopenStartMs(125_400, 120_000, 'http://a.test/x/index-1-2.m3u8?t=1')).toBe(5_400);
    expect(reopenStartMs(125_400, 120_000, 'http://a.test/timeshift/u/p/29/s/1.ts')).toBe(0);
    expect(reopenStartMs(100, 120_000, 'http://a.test/x.m3u8')).toBe(0);
  });

  it('re-opens at most once per 2 s', () => {
    expect(reopenAllowed(undefined, NOW)).toBe(true);
    expect(reopenAllowed(NOW - 1999, NOW)).toBe(false);
    expect(reopenAllowed(NOW - 2000, NOW)).toBe(true);
  });

  it('the end card offers the next archived programme, Watch live and Back', () => {
    expect(endCardActions({ start: 1, stop: 2, title: 'Programme 5' }).map((a) => a.label)).toEqual(['Next: Programme 5', 'Watch live', 'Back']);
    expect(endCardActions(undefined).map((a) => a.id)).toEqual(['live', 'back']);
  });

  it('Not available: gone, 400/404/410/5xx before a frame, or an early end; refusals keep their own copy', () => {
    expect(notAvailableFailure({ kind: 'failed', reason: 'gone', httpStatus: 404 }, false, 500)).toBe(true);
    expect(notAvailableFailure({ kind: 'failed', reason: 'unavailable', httpStatus: 500 }, false, 500)).toBe(true);
    expect(notAvailableFailure({ kind: 'failed', reason: 'unavailable', httpStatus: 400 }, false, 500)).toBe(true);
    expect(notAvailableFailure({ kind: 'failed', reason: 'unavailable' }, false, 500)).toBe(true);
    expect(notAvailableFailure({ kind: 'failed', reason: 'unsupported' }, false, 500)).toBe(false);
    expect(notAvailableFailure({ kind: 'failed', reason: 'refused', httpStatus: 403 }, false, 500)).toBe(false);
    expect(notAvailableFailure({ kind: 'failed', reason: 'unavailable', httpStatus: 503 }, false, 500)).toBe(false);
    expect(notAvailableFailure({ kind: 'ended' }, false, EARLY_END_MS)).toBe(true);
    expect(notAvailableFailure({ kind: 'ended' }, false, EARLY_END_MS + 1)).toBe(false);
    expect(notAvailableFailure({ kind: 'failed', reason: 'gone' }, true, 500)).toBe(false);
  });
});

it('From the start: a catch-up channel with its now programme on air', () => {
  const now = { start: NOW - H, stop: NOW + H };
  expect(canFromStart({ archiveDays: 3, now }, NOW)).toBe(true);
  expect(canFromStart({ now }, NOW)).toBe(false);
  expect(canFromStart({ archiveDays: 3 }, NOW)).toBe(false);
  expect(canFromStart({ archiveDays: 3, now: { start: NOW - 2 * H, stop: NOW - H } }, NOW)).toBe(false);
});

it('not-available marks last 30 min, in memory', () => {
  const m = createMissingMarks();
  m.mark('c', 100, NOW);
  expect(m.has('c', 100, NOW + MISSING_TTL_MS - 1)).toBe(true);
  expect(m.has('c', 200, NOW)).toBe(false);
  expect(m.has('c', 100, NOW + MISSING_TTL_MS)).toBe(false);
});
