import { describe, expect, it } from 'vitest';
import type { SupervisorStatus } from '@iptv/player';
import { installFormatReport, playedAlternate } from './formatReport.ts';

type Ch = { id: string; url: string; alternateUrl?: string };
const ch: Ch = { id: 's:1', url: 'http://example.test/live/u/p/1.ts', alternateUrl: 'http://example.test/live/u/p/1.m3u8' };

describe('playedAlternate', () => {
  it('tells which of the two URLs is in flight', () => {
    expect(playedAlternate(ch, ch.url)).toBe(false);
    expect(playedAlternate(ch, ch.alternateUrl)).toBe(true);
    expect(playedAlternate(ch, 'http://example.test/other.ts')).toBeUndefined();
    expect(playedAlternate({ url: ch.url }, ch.url)).toBeUndefined();
    expect(playedAlternate(undefined, ch.url)).toBeUndefined();
    expect(playedAlternate(ch, undefined)).toBeUndefined();
  });
});

describe('installFormatReport', () => {
  function rig() {
    let fn: ((s: SupervisorStatus) => void) | undefined;
    const state: { current: Ch | undefined; inFlight: string | undefined } = { current: ch, inFlight: ch.url };
    const reports: [string, string][] = [];
    const off = installFormatReport({
      onStatus: (f) => { fn = f; return () => { fn = undefined; }; },
      current: () => state.current,
      inFlight: () => state.inFlight,
      report: (id, format) => { reports.push([id, format]); },
    });
    return { state, reports, off, emit: (s: SupervisorStatus) => fn?.(s) };
  }

  it('reports the first frame once per channel and format', () => {
    const r = rig();
    r.emit({ kind: 'loading' });
    expect(r.reports).toEqual([]);
    r.emit({ kind: 'playing' });
    r.emit({ kind: 'reconnecting', attempt: 1 });
    r.emit({ kind: 'playing' });
    expect(r.reports).toEqual([['s:1', 'ts']]);
    r.state.inFlight = ch.alternateUrl;
    r.emit({ kind: 'playing' });
    expect(r.reports).toEqual([['s:1', 'ts'], ['s:1', 'm3u8']]);
  });

  it('reports nothing for a channel with one format, and nothing after off()', () => {
    const r = rig();
    r.state.current = { id: 's:2', url: 'http://example.test/s2.m3u8' };
    r.state.inFlight = 'http://example.test/s2.m3u8';
    r.emit({ kind: 'playing' });
    expect(r.reports).toEqual([]);
    r.state.current = ch;
    r.state.inFlight = ch.url;
    r.off();
    r.emit({ kind: 'playing' });
    expect(r.reports).toEqual([]);
  });

  it('never reports a movie or episode (the vod: stand-in channel), even with two URLs', () => {
    const r = rig();
    r.state.current = { id: 'vod:x:v1', url: 'http://example.test/movie/u/p/1.ts', alternateUrl: 'http://example.test/movie/u/p/1.m3u8' };
    r.state.inFlight = 'http://example.test/movie/u/p/1.ts';
    r.emit({ kind: 'playing' });
    expect(r.reports).toEqual([]);
  });
});
