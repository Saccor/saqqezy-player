import { describe, expect, test } from 'vitest';
import type { ChannelRow, SportsEventTile } from '@iptv/app-api';
import { wideLines, wideSize } from './wideTileLogic.ts';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const chan = (extra: Partial<ChannelRow> = {}): ChannelRow =>
  ({ id: 'c1', number: 7, name: 'Channel Seven', group: 'G', favourite: false, ...extra });
const ev = (start: number, stop: number, channelCount = 2): SportsEventTile =>
  ({ key: 'p:1', title: 'Team A v Team B', start, stop, channelCount, followed: false });
const onNow = (title: string) => ({ title, start: NOW - 1, stop: NOW + 1 }) as ChannelRow['now'];

describe('wideLines', () => {
  test('a live match: "Live · N channels" marked live, the guide title as the main line', () => {
    expect(wideLines({ type: 'event', event: ev(NOW - 60_000, NOW + 3600_000) }, NOW))
      .toEqual({ context: 'Live · 2 channels', main: 'Team A v Team B', live: true });
  });
  test('a later match is not marked live', () => {
    expect(wideLines({ type: 'event', event: ev(NOW + 20 * 60_000, NOW + 7200_000, 1) }, NOW))
      .toEqual({ context: 'In 20 min · 1 channel', main: 'Team A v Team B', live: false });
  });
  test('a channel: its name, then the programme on now (or a placeholder); numbers only when asked', () => {
    expect(wideLines({ type: 'channel', channel: chan({ now: onNow('Evening show') }) }, NOW))
      .toEqual({ context: 'Channel Seven', main: 'Evening show', live: false });
    expect(wideLines({ type: 'channel', channel: chan() }, NOW, true))
      .toEqual({ context: '7 · Channel Seven', main: 'No guide information', live: false });
  });
  test('View all: just the label', () => {
    expect(wideLines({ type: 'viewAll', target: 'sports', total: 30 }, NOW)).toEqual({ context: '', main: 'View all', live: false });
  });
  test('a context equal to the main line is dropped', () => {
    expect(wideLines({ type: 'channel', channel: chan({ name: 'Same', now: onNow('Same') }) }, NOW).context).toBe('');
  });
});

describe('wideSize', () => {
  test('the compact tile is much shorter than the wide one', () => {
    expect(wideSize(false)).toEqual({ w: 314, h: 176 });
    expect(wideSize(true)).toEqual({ w: 300, h: 100 });
  });
});
