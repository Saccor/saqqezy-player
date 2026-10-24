import { describe, expect, test } from 'vitest';
import type { ChannelRow, SportsEventTile } from '@iptv/app-api';
import { COMPACT_H, MATCH_GRID_H, wideLines, wideSize } from './wideTileLogic.ts';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const chan = (extra: Partial<ChannelRow> = {}): ChannelRow =>
  ({ id: 'c1', number: 7, name: 'Channel Seven', group: 'G', favourite: false, ...extra });
const ev = (start: number, stop: number, channelCount = 2): SportsEventTile =>
  ({ key: 'p:1', title: 'Team A v Team B', start, stop, channelCount, followed: false });
const onNow = (title: string) => ({ title, start: NOW - 1, stop: NOW + 1 }) as ChannelRow['now'];

describe('wideLines', () => {
  test('a folder: the count line above the folder name (spec 2026-10-24 §3.2)', () => {
    const l = wideLines({ type: 'folder', hit: { kind: 'live', id: 'g:SE | Sport', name: 'SE | Sport', count: 214 } }, 0);
    expect(l).toEqual({ context: '214 channels', main: 'SE | Sport', live: false });
    expect(wideLines({ type: 'folder', hit: { kind: 'series', id: 'c1', name: 'Synthetic Drama', count: 1 } }, 0).context).toBe('1 series');
  });
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
  test('short (compact tiles): "N ch", and a match with two sides gives them for their own lines', () => {
    const e = { ...ev(NOW - 60_000, NOW + 3600_000, 4), sides: ['Lakeshore', 'Pinecrest'] as [string, string] };
    expect(wideLines({ type: 'event', event: e }, NOW, false, true))
      .toEqual({ context: 'Live · 4 ch', main: 'Team A v Team B', live: true, sides: ['Lakeshore', 'Pinecrest'] });
    expect(wideLines({ type: 'event', event: ev(NOW + 20 * 60_000, NOW + 7200_000, 1) }, NOW, false, true).context).toBe('In 20 min · 1 ch');
  });
  test('a title-only event has no sides', () => {
    expect(wideLines({ type: 'event', event: ev(NOW, NOW + 1) }, NOW, false, true).sides).toBeUndefined();
  });
  test('a context equal to the main line is dropped', () => {
    expect(wideLines({ type: 'channel', channel: chan({ name: 'Same', now: onNow('Same') }) }, NOW).context).toBe('');
  });
});

describe('wideSize', () => {
  test('the compact tile is 360 × 112, much shorter than the wide one; the grid tile adds one 24 px line', () => {
    expect(wideSize(false)).toEqual({ w: 314, h: 176 });
    expect(wideSize(true)).toEqual({ w: 360, h: 112 });
    expect(MATCH_GRID_H - COMPACT_H).toBe(24);
  });
});
