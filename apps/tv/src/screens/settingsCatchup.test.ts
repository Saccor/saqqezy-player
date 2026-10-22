import { describe, expect, it } from 'vitest';
import type { DiagnosticsInfo } from '@iptv/app-api';
import { catchupOffsetChoices, catchupOffsetFromId, catchupOffsetIndex, catchupOffsetLabel, diagnosticsLines } from './settingsLogic.ts';

describe('Catch-up time (spec 2026-10-20-catch-up §5.6)', () => {
  it('offers Auto and −12 h … +14 h in 15 min steps', () => {
    const c = catchupOffsetChoices();
    expect(c[0]).toEqual({ id: 'auto', label: 'Auto' });
    expect(c[1]).toEqual({ id: '-720', label: 'UTC-12:00' });
    expect(c.at(-1)).toEqual({ id: '840', label: 'UTC+14:00' });
    expect(c).toHaveLength(1 + (26 * 4 + 1));
    expect(c.find((x) => x.id === '-210')?.label).toBe('UTC-3:30');
  });

  it('the list opens on the current value: Auto at the top, a manual time on its own row', () => {
    const c = catchupOffsetChoices();
    expect(catchupOffsetIndex(c, undefined)).toBe(0);
    expect(c[catchupOffsetIndex(c, 60)]).toEqual({ id: '60', label: 'UTC+1:00' });
    expect(c[catchupOffsetIndex(c, -210)]?.label).toBe('UTC-3:30');
    expect(catchupOffsetIndex(c, 7)).toBe(0); // not a choice: the top
  });

  it('maps a choice back to minutes; anything else is Auto', () => {
    expect(catchupOffsetFromId('auto')).toBeUndefined();
    expect(catchupOffsetFromId('60')).toBe(60);
    expect(catchupOffsetFromId('61')).toBeUndefined();
    expect(catchupOffsetFromId('9999')).toBeUndefined();
    expect(catchupOffsetLabel(undefined)).toBe('Auto');
    expect(catchupOffsetLabel(0)).toBe('UTC+0:00');
  });
});

describe('Diagnostics catch-up lines', () => {
  const settings: DiagnosticsInfo['settings'] = {
    epgOffsetHours: 0, preferredFormat: 'ts', autoRefreshHours: 6, sleepTimerMinutes: 0, showClock: true, liveDelay: 'balanced', subtitleLanguage: 'off',
    audioLanguage: 'auto', subtitleExactMatch: false, combineDuplicates: true, preferredLanguages: [], openOn: 'lastChannel', followedTeams: [], posterSize: 'standard', combineChannels: false, regions: { codes: [], mode: 'off' }, combineCategories: false, foldCountries: true, pinnedCompetitions: [], hiddenCompetitions: [], matchCategories: [], maxWindows: 'auto',
  };
  const base = { appVersion: '1', lastErrors: [], settings };
  const source = { id: 'secret-id', name: 'Test', kind: 'm3u', channels: 9, skipped: 0, playlistAt: 0, epgAt: 0 };

  it('counts catch-up channels and names the catch-up time; no URLs or templates', () => {
    const info = { ...base, sources: [{ ...source, catchupChannels: 412, catchupUnsupported: 3, catchupTime: 'Europe/Stockholm' }] };
    const text = diagnosticsLines(info as DiagnosticsInfo, { platform: 'browser' }).map(([, v]) => v);
    expect(text).toContain('Catch-up: 412 channels, 3 not supported');
    expect(text).toContain('Catch-up time: Europe/Stockholm');
    const fixed = { ...base, sources: [{ ...source, catchupChannels: 2, catchupTime: 'UTC+1:00 (fixed offset)' }] };
    expect(diagnosticsLines(fixed as DiagnosticsInfo, { platform: 'browser' }).map(([, v]) => v)).toContain('Catch-up: 2 channels');
  });

  it('says nothing about catch-up for a source without it', () => {
    const text = diagnosticsLines({ ...base, sources: [source] } as unknown as DiagnosticsInfo, { platform: 'browser' }).map(([, v]) => v).join('\n');
    expect(text).not.toContain('Catch-up');
  });
});
