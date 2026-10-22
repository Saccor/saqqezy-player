import { describe, expect, it } from 'vitest';
import type { JournalEvent } from '@iptv/player';
import { connectionsHeader, connectionsRows, connectionsText } from './connectionsLogic.ts';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const at = (s: number) => NOW - s * 1000;

const run: JournalEvent[] = [
  { k: 'play', t: at(90), preset: 'balanced', urls: 1, channel: 'Channel 1' },
  { k: 'open', t: at(89), attempt: 1, urlIndex: 0 },
  { k: 'playing', t: at(88), attempt: 1 },
  { k: 'open', t: at(60), tile: 1, attempt: 1, urlIndex: 0, concurrent: 1 },
  { k: 'playing', t: at(59), tile: 1, attempt: 1 },
  { k: 'open', t: at(30), tile: 2, attempt: 1, urlIndex: 0, concurrent: 2 },
  { k: 'tileRefused', t: at(29), tile: 2, httpStatus: 403, concurrent: 2, scope: 'tile', reported: 2 },
  { k: 'stop', t: at(10), tile: 1 },
];

describe('connectionsHeader', () => {
  it('what the source reports, what was in use at sign-in, the most windows seen and where it refused', () => {
    expect(connectionsHeader({ reported: 2, activeAtLogin: 1, maxSeen: 2, refusedAt: 3 })).toEqual([
      ['Your source reports', '2 connections'],
      ['In use at the last sign-in', '1'],
      ['Most windows playing at once', '2'],
      ['Refused at', 'window 3'],
    ]);
  });

  it('says when the source reports no limit, and leaves out what is unknown', () => {
    expect(connectionsHeader({ maxSeen: 0 })).toEqual([
      ['Your source reports', 'no limit'],
      ['Most windows playing at once', '0'],
    ]);
  });
});

describe('connectionsRows', () => {
  it('only multiview events, newest first, with times', () => {
    const rows = connectionsRows(run, NOW);
    expect(rows.map((r) => r.text)).toEqual([
      'Window 2 · Stopped',
      'Window 3 · Refused (403) · 2 others open · kept on the window',
      'Window 3 · Connect (attempt 1) · 2 others open',
      'Window 2 · Playing',
      'Window 2 · Connect (attempt 1) · 1 other open',
    ]);
    expect(rows.every((r) => r.time.length > 0)).toBe(true);
  });

  it('nothing yet', () => {
    expect(connectionsRows([run[0]!, run[1]!], NOW)).toEqual([]);
  });
});

describe('connectionsText', () => {
  it('the header and the rows as plain text to paste, numbers only', () => {
    const text = connectionsText({ reported: 2, maxSeen: 2 }, run, NOW);
    expect(text.split('\n')[0]).toBe('Your source reports: 2 connections');
    expect(text).toContain('Window 3 · Refused (403)');
    expect(text).not.toMatch(/https?:|example\.test|Channel 1/);
  });

  it('says so when there was no multiview yet', () => {
    expect(connectionsText({ maxSeen: 0 }, [], NOW)).toContain('No multiview sessions yet.');
  });
});
