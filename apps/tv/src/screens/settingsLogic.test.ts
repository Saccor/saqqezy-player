import { describe, expect, it } from 'vitest';
import type { DiagnosticsInfo } from '@iptv/app-api';
import { DEFAULT_SETTINGS } from '@iptv/core';
import {
  AUTO_REFRESH_OPTIONS, FORMAT_OPTIONS, LIVE_DELAY_OPTIONS, SETTINGS_PAGES, autoRefreshLabel, cycleOption, diagnosticsLines, formatLabel, liveDelayLabel, screenLines, uaVersions,
  formatTime, liveLines, offsetLabel, onOff, rollbackTarget, sleepDefaultLabel, stepOffset, stripUrls,
  addTeamError, displayItems, openOnLabel,
} from './settingsLogic.ts';
import {
  HIDE_NO_EPG_HELP, HIDE_NO_EPG_NO_GUIDE, HIDE_NO_EPG_UNAVAILABLE, guideLoaded, hideNoEpgRow, listActions, listMoveTarget,
} from './settingsLogic.ts';

describe('SETTINGS_PAGES', () => {
  it('lists the nine pages in menu order', () => {
    expect(SETTINGS_PAGES.map((p) => p.title)).toEqual([
      'Sources', 'Manage on phone or computer', 'TV guide', 'Playback', 'Channels', 'Display', 'Storage', 'Diagnostics', 'About',
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
    settings: { epgOffsetHours: 1.5, preferredFormat: 'm3u8', autoRefreshHours: 6, sleepTimerMinutes: 30, showClock: false, liveDelay: 'low', subtitleLanguage: 'sv', audioLanguage: 'auto', subtitleExactMatch: true, combineDuplicates: true, preferredLanguages: [], openOn: 'lastChannel', followedTeams: [], posterSize: 'standard' },
  };

  it('shows version, platform, sources, errors and settings', () => {
    const text = diagnosticsLines(info, { platform: 'browser' }).map(([k, v]) => `${k}: ${v}`);
    expect(text).toContain('App version: 1.2.3');
    expect(text).toContain('Platform: browser');
    expect(text.some((l) => l.includes('Test') && l.includes('120 channels') && l.includes('2 skipped'))).toBe(true);
    expect(text).toContain('Guide offset: +1.5 h');
    expect(text).toContain('Stream format: HLS (m3u8)');
    expect(text).toContain('Live delay: Low');
    expect(text).toContain('Auto-refresh: 6 h');
    expect(text).toContain('Sleep timer: 30 min');
    expect(text).toContain('Clock: Off');
    expect(text).toContain('Subtitle language: Swedish');
    expect(text).toContain('Audio language: Stream default');
    expect(text).toContain('Exact-match subtitles: On');
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

describe('uaVersions', () => {
  it('keeps only the Tizen and Chrome versions', () => {
    const ua = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) 94.0.4606.31/7.0 TV Safari/537.36 Chrome/94.0.4606.31';
    expect(uaVersions(ua)).toBe('Tizen 7.0 \u00b7 Chrome 94.0.4606.31');
  });
  it('handles desktop Chrome and unknown strings', () => {
    expect(uaVersions('Mozilla/5.0 (Windows NT 10.0) Chrome/126.0.0.0 Safari/537.36')).toBe('Chrome 126.0.0.0');
    expect(uaVersions('Foo/1')).toBe('unknown');
    expect(uaVersions(undefined)).toBe('unknown');
  });
});

describe('screenLines', () => {
  const dev = { innerWidth: 1920, innerHeight: 1080, screenWidth: 5120, screenHeight: 1440, devicePixelRatio: 1,
    designScale: 1, userAgent: 'x Tizen 7.0 Chrome/94.0.1' };
  it('shows viewport, screen, pixel ratio, design scale and engine', () => {
    const t = screenLines(dev, 'browser').map(([k, v]) => `${k}: ${v}`);
    expect(t).toEqual([
      'Viewport: 1920\u00d71080 \u00b7 design scale 1.00',
      'Screen: 5120\u00d71440 \u00b7 pixel ratio 1',
      'Engine: Tizen 7.0 \u00b7 Chrome 94.0.1',
    ]);
  });
  it('adds the Tizen device line only on Tizen, with fallbacks', () => {
    expect(screenLines({ ...dev, tizenPlatformVersion: '7.0', tizenModel: 'QE-TEST' }, 'tizen')[2])
      .toEqual(['Device', 'Tizen 7.0 \u00b7 QE-TEST']);
    expect(screenLines(dev, 'tizen')[2]).toEqual(['Device', 'Tizen version unknown \u00b7 model unknown']);
  });
  it('says unknown for missing numbers and rounds odd ones', () => {
    const t = screenLines({ devicePixelRatio: 1.3333, designScale: 2 / 3 }, 'browser');
    expect(t[0]).toEqual(['Viewport', 'unknown \u00b7 design scale 0.67']);
    expect(t[1]).toEqual(['Screen', 'unknown \u00b7 pixel ratio 1.33']);
  });
  it('is included in diagnosticsLines right after the platform and never leaks the full user agent', () => {
    const info: DiagnosticsInfo = { appVersion: '1', sources: [], lastErrors: [],
      settings: { epgOffsetHours: 0, preferredFormat: 'ts', autoRefreshHours: 0, sleepTimerMinutes: 0, showClock: true, liveDelay: 'balanced', subtitleLanguage: 'off', audioLanguage: 'auto', subtitleExactMatch: false, combineDuplicates: true, preferredLanguages: [], openOn: 'lastChannel', followedTeams: [], posterSize: 'standard' } };
    const lines = diagnosticsLines(info, { platform: 'browser', device: { ...dev, userAgent: 'SECRET-AGENT Chrome/94.0.1' } });
    expect(lines.slice(0, 4).map(([k]) => k)).toEqual(['App version', 'Platform', 'Viewport', 'Screen']);
    expect(lines.flat().join('\n')).not.toContain('SECRET-AGENT');
  });
});

describe('liveDelayLabel', () => {
  it('labels each choice', () => {
    expect(LIVE_DELAY_OPTIONS.map(liveDelayLabel)).toEqual(['Low', 'Balanced (default)', 'Stable']);
  });
});

describe('guideLoaded', () => {
  it('follows whether the guide coverage is known', () => {
    expect(guideLoaded({ coverageKnown: true, hasGuideUrl: true })).toBe(true);
    expect(guideLoaded({ coverageKnown: false, hasGuideUrl: true })).toBe(false);
    expect(guideLoaded({ coverageKnown: false, hasGuideUrl: false })).toBe(false);
  });
});

describe('hideNoEpgRow', () => {
  const waiting = { coverageKnown: false, hasGuideUrl: true };
  const none = { coverageKnown: false, hasGuideUrl: false };
  const known = { coverageKnown: true, hasGuideUrl: true };

  it('is disabled until the guide has been downloaded, and reads Off meanwhile', () => {
    expect(hideNoEpgRow(waiting, false)).toEqual({ disabled: true, value: 'Off', help: HIDE_NO_EPG_UNAVAILABLE });
    expect(hideNoEpgRow(waiting, true)).toEqual({ disabled: true, value: 'Off', help: HIDE_NO_EPG_UNAVAILABLE });
    expect(HIDE_NO_EPG_UNAVAILABLE).toBe('Available after the TV guide has been downloaded.');
  });

  it('says so when the source has no guide at all', () => {
    expect(hideNoEpgRow(none, false)).toEqual({ disabled: true, value: 'Off', help: HIDE_NO_EPG_NO_GUIDE });
    expect(hideNoEpgRow(none, true).value).toBe('Off');
    expect(HIDE_NO_EPG_NO_GUIDE).toBe('This source has no TV guide.');
  });

  it('is a toggle once the guide is there', () => {
    expect(hideNoEpgRow(known, false)).toEqual({ disabled: false, value: 'Off', help: HIDE_NO_EPG_HELP });
    expect(hideNoEpgRow(known, true).value).toBe('On');
    expect(HIDE_NO_EPG_HELP).toBe('Channels with no programme information are hidden everywhere except your lists.');
  });
});

describe('listMoveTarget', () => {
  it('Favourites (first) never moves', () => {
    expect(listMoveTarget(0, -1, 4)).toBeUndefined();
    expect(listMoveTarget(0, 1, 4)).toBeUndefined();
  });

  it('a list never moves above Favourites', () => {
    expect(listMoveTarget(1, -1, 4)).toBeUndefined();
    expect(listMoveTarget(2, -1, 4)).toBe(1);
  });

  it('the last list cannot move down', () => {
    expect(listMoveTarget(3, 1, 4)).toBeUndefined();
    expect(listMoveTarget(2, 1, 4)).toBe(3);
  });

  it('out-of-range indexes do not move', () => {
    expect(listMoveTarget(-1, 1, 4)).toBeUndefined();
    expect(listMoveTarget(4, -1, 4)).toBeUndefined();
    expect(listMoveTarget(1, 1, 2)).toBeUndefined();
  });
});

describe('listActions', () => {
  const ids = (items: { id: string }[]) => items.map((i) => i.id);

  it('Favourites: rename only (cannot be moved or deleted)', () => {
    expect(ids(listActions('fav', 0, 3))).toEqual(['rename', 'cancel']);
  });

  it('a middle list can move both ways and be deleted', () => {
    expect(ids(listActions('l-a', 1, 3))).toEqual(['rename', 'moveDown', 'delete', 'cancel']);
    expect(ids(listActions('l-b', 2, 4))).toEqual(['rename', 'moveUp', 'moveDown', 'delete', 'cancel']);
    expect(ids(listActions('l-c', 3, 4))).toEqual(['rename', 'moveUp', 'delete', 'cancel']);
  });

  it('labels', () => {
    expect(listActions('l-b', 2, 4).map((i) => i.label)).toEqual(['Rename…', 'Move up', 'Move down', 'Delete…', 'Cancel']);
  });
});

describe('liveLines', () => {
  it('shows the delay with its source, the target and the counters', () => {
    expect(liveLines({ behindLiveS: 12.4, source: 'pdt', targetS: 6, stalls: 2, reconnects: 1 })).toEqual([
      ['Behind live', '12 s (stream clock)'], ['Live target', '6.0 s'], ['Stalls / reconnects', '2 / 1'],
    ]);
    expect(liveLines({ bufferAheadS: 2.46, source: 'buffer', targetS: 3, stalls: 0, reconnects: 0 })[0])
      .toEqual(['Behind live', '2.5 s buffered']);
    expect(liveLines({ targetS: 0, stalls: 0, reconnects: 0 })[0]).toEqual(['Behind live', 'Unknown']);
  });
});

describe('liveLines: stream clock and stream edge (final fixes)', () => {
  const base = { targetS: 6, stalls: 0, reconnects: 0 };
  it('shows the stream clock when known, plus the edge distance on its own line when both are known', () => {
    expect(liveLines({ ...base, behindLiveS: 7.2, source: 'edge', streamClockBehindS: 12.4 }).slice(0, 2)).toEqual([
      ['Behind live', '12 s (stream clock)'], ['Behind stream edge', '7 s'],
    ]);
  });
  it('the stream clock alone: one line', () => {
    const lines = liveLines({ ...base, streamClockBehindS: 12.4 });
    expect(lines[0]).toEqual(['Behind live', '12 s (stream clock)']);
    expect(lines.map((l) => l[0])).not.toContain('Behind stream edge');
  });
  it('the edge alone: labelled stream edge, one line', () => {
    const lines = liveLines({ ...base, behindLiveS: 7.2, source: 'edge' });
    expect(lines[0]).toEqual(['Behind live', '7 s (stream edge)']);
    expect(lines.map((l) => l[0])).not.toContain('Behind stream edge');
  });
});

describe('display page items', () => {
  it('Open on label', () => {
    expect(openOnLabel('lastChannel')).toBe('Last channel');
    expect(openOnLabel('start')).toBe('Start page');
  });
  it('rows: clock, open on, poster size, teams heading, each team, add', () => {
    const items = displayItems({ ...DEFAULT_SETTINGS, followedTeams: ['Northbridge FC', 'Pinecrest'] });
    expect(items.map((i) => i.id)).toEqual(['clock', 'openOn', 'posterSize', 'teamsHeading', 'team:0', 'team:1', 'addTeam']);
    expect(items.find((i) => i.id === 'openOn')?.value).toBe('Last channel');
    expect(items.find((i) => i.id === 'teamsHeading')?.heading).toBe(true);
  });
  it('Display lists Poster size', () => {
    const items = displayItems({ showClock: true, openOn: 'lastChannel', followedTeams: [], posterSize: 'compact' });
    expect(items.find((i) => i.id === 'posterSize')).toMatchObject({ label: 'Poster size', value: 'Compact', adjustable: true });
  });
  it('adding a team: empty, duplicate, full', () => {
    expect(addTeamError([], '   ')).toBe('Type a name');
    expect(addTeamError(['Pinecrest'], 'pinecrest')).toBe('Already in the list');
    expect(addTeamError(Array.from({ length: 50 }, (_, i) => `T${i}`), 'New')).toBe('The list is full (50)');
    expect(addTeamError(['Pinecrest'], 'Lakeshore')).toBeUndefined();
  });
});
