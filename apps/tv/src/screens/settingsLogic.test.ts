import { describe, expect, it } from 'vitest';
import type { DiagnosticsInfo } from '@iptv/app-api';
import {
  AUTO_REFRESH_OPTIONS, FORMAT_OPTIONS, SETTINGS_PAGES, autoRefreshLabel, cycleOption, diagnosticsLines, formatLabel,
  formatTime, offsetLabel, onOff, rollbackTarget, sleepDefaultLabel, stepOffset, stripUrls,
} from './settingsLogic.ts';

describe('SETTINGS_PAGES', () => {
  it('lists the eight pages in menu order', () => {
    expect(SETTINGS_PAGES.map((p) => p.title)).toEqual([
      'Sources', 'TV guide', 'Playback', 'Channels', 'Display', 'Storage', 'Diagnostics', 'About',
    ]);
  });
});

describe('stepOffset', () => {
  it('moves in 0.5 h steps', () => {
    expect(stepOffset(0, 1)).toBe(0.5);
    expect(stepOffset(0, -1)).toBe(-0.5);
    expect(stepOffset(1.5, 1)).toBe(2);
  });
  it('clamps to -12..+12', () => {
    expect(stepOffset(12, 1)).toBe(12);
    expect(stepOffset(-12, -1)).toBe(-12);
    expect(stepOffset(40, -1)).toBe(11.5);
  });
  it('snaps odd values to the half-hour grid and never yields -0', () => {
    expect(stepOffset(0.3, 1)).toBe(1);
    expect(Object.is(stepOffset(0.5, -1), 0)).toBe(true);
  });
});

describe('offsetLabel', () => {
  it('shows a sign and hours', () => {
    expect(offsetLabel(0)).toBe('0 h');
    expect(offsetLabel(1.5)).toBe('+1.5 h');
    expect(offsetLabel(-2)).toBe('−2 h');
  });
});

describe('cycleOption', () => {
  it('moves forward and backward with wrap-around', () => {
    expect(cycleOption(AUTO_REFRESH_OPTIONS, 0, 1)).toBe(6);
    expect(cycleOption(AUTO_REFRESH_OPTIONS, 24, 1)).toBe(0);
    expect(cycleOption(AUTO_REFRESH_OPTIONS, 0, -1)).toBe(24);
    expect(cycleOption(FORMAT_OPTIONS, 'ts', 1)).toBe('m3u8');
    expect(cycleOption(FORMAT_OPTIONS, 'm3u8', 1)).toBe('ts');
  });
  it('starts from the first option for an unknown value', () => {
    expect(cycleOption(AUTO_REFRESH_OPTIONS, 7, 1)).toBe(0);
  });
});

describe('labels', () => {
  it('formats choices', () => {
    expect(autoRefreshLabel(0)).toBe('Never');
    expect(autoRefreshLabel(12)).toBe('12 h');
    expect(formatLabel('ts')).toBe('TS (default)');
    expect(formatLabel('m3u8')).toBe('HLS (m3u8)');
    expect(sleepDefaultLabel(0)).toBe('Off');
    expect(sleepDefaultLabel(30)).toBe('30 min');
    expect(onOff(true)).toBe('On');
    expect(onOff(false)).toBe('Off');
  });
  it('formats timestamps, 0 as Never', () => {
    expect(formatTime(0)).toBe('Never');
    const t = new Date(2026, 0, 5, 7, 3).getTime();
    expect(formatTime(t)).toBe('2026-01-05 07:03');
  });
});

describe('stripUrls', () => {
  it('removes URLs and user:pass@host credentials', () => {
    expect(stripUrls('Failed http://example.test:8080/live/u/p/1.ts now')).toBe('Failed [link] now');
    expect(stripUrls('at u:secret@example.test')).toBe('at [link]');
    expect(stripUrls('Could not reach the provider.')).toBe('Could not reach the provider.');
  });
  it('removes bare host:port forms', () => {
    expect(stripUrls('connect example.test:8080/live/1.ts failed')).toBe('connect [link] failed');
    expect(stripUrls('connect 10.0.0.5:8080 failed')).toBe('connect [link] failed');
  });
  it('removes dotted hosts followed by / or :', () => {
    expect(stripUrls('GET example.test/player_api.php done')).toBe('GET [link] done');
    expect(stripUrls('host example.test: refused')).toBe('host [link] refused');
  });
  it('removes user=/username=/pass=/password= values', () => {
    expect(stripUrls('bad user=test pass=hunter2 end')).toBe('bad [link] [link] end');
    expect(stripUrls('username=test&password=test')).toBe('[link]');
    expect(stripUrls('Password=abc')).toBe('[link]');
  });
});

describe('rollbackTarget', () => {
  it('restores the previous value only when no newer save has started', () => {
    expect(rollbackTarget({ a: 1 }, 3, 3)).toEqual({ a: 1 });
    expect(rollbackTarget({ a: 1 }, 3, 4)).toBeUndefined();
    expect(rollbackTarget(undefined, 3, 3)).toBeUndefined();
  });
});

describe('diagnosticsLines', () => {
  const info: DiagnosticsInfo = {
    appVersion: '1.2.3',
    sources: [{ id: 'src-secret-id', name: 'Test', kind: 'xtream', channels: 120, skipped: 2, playlistAt: 0, epgAt: 0 }],
    lastErrors: [
      { at: 1, where: 'refresh', message: 'HTTP 403 for http://example.test:8899/player_api.php?username=test&password=test' },
      { at: 2, where: 'getPlayable', message: 'Login failed for test:test@example.test' },
    ],
    settings: { epgOffsetHours: 1.5, preferredFormat: 'm3u8', autoRefreshHours: 6, sleepTimerMinutes: 30, showClock: false },
  };

  it('shows version, platform, sources, errors and settings', () => {
    const text = diagnosticsLines(info, { platform: 'browser' }).map(([k, v]) => `${k}: ${v}`);
    expect(text).toContain('App version: 1.2.3');
    expect(text).toContain('Platform: browser');
    expect(text.some((l) => l.includes('Test') && l.includes('120 channels') && l.includes('2 skipped'))).toBe(true);
    expect(text).toContain('Guide offset: +1.5 h');
    expect(text).toContain('Stream format: HLS (m3u8)');
    expect(text).toContain('Auto-refresh: 6 h');
    expect(text).toContain('Sleep timer: 30 min');
    expect(text).toContain('Clock: Off');
  });

  it('never contains a URL, username, password or source id; only the source name matches "test"', () => {
    const lines = diagnosticsLines(info, { platform: 'browser' });
    const all = lines.flat().join('\n');
    expect(all).not.toMatch(/https?:|:\/\/|example\.test|password|username|player_api|src-secret-id/i);
    const hits = lines.filter(([k, v]) => /test/i.test(`${k} ${v}`));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.join(' ')).toMatch(/Test · Xtream/);
  });

  it('says so when there are no sources or errors', () => {
    const text = diagnosticsLines({ ...info, sources: [], lastErrors: [] }, { platform: 'tizen' })
      .map(([k, v]) => `${k}: ${v}`);
    expect(text).toContain('Sources: None');
    expect(text).toContain('Errors: None');
  });
});
