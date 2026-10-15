import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '@iptv/player';
import {
  SUBTITLE_KEY_OFF, SUBTITLES_OFF, clock, cueText, findTrack, knownDuration, minutesLeft, nextCardText, titleLengthMs, oneSpace, overlayVisible, remaining, resumeLabel, trackKey, trackRows,
} from './vodPlayerLogic.ts';

describe('clock', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(59_000)).toBe('0:59');
    expect(clock(61_000)).toBe('1:01');
    expect(clock(3_600_000)).toBe('1:00:00');
    expect(clock(3_730_000)).toBe('1:02:10');
    expect(clock(-5)).toBe('0:00');
  });
});

describe('remaining', () => {
  it('prefixes a minus', () => {
    expect(remaining(100_000, 3_730_000)).toBe('-1:00:30');
    expect(remaining(10, 5)).toBe('-0:00');
  });
});

describe('overlayVisible', () => {
  const base = { paused: false, seeking: false, problem: false, lastKeyAt: 0, now: 5000 };
  it('hides after 4 s idle', () => {
    expect(overlayVisible(base)).toBe(false);
    expect(overlayVisible({ ...base, now: 3999 })).toBe(true);
    expect(overlayVisible({ ...base, now: 4000 })).toBe(false);
  });
  it('stays for paused, seeking, problem', () => {
    expect(overlayVisible({ ...base, paused: true })).toBe(true);
    expect(overlayVisible({ ...base, seeking: true })).toBe(true);
    expect(overlayVisible({ ...base, problem: true })).toBe(true);
  });
});

describe('resumeLabel', () => {
  it('labels', () => {
    expect(resumeLabel(0)).toBe('Play');
    expect(resumeLabel(3_730_000)).toBe('Resume from 1:02:10');
  });
});

describe('minutesLeft', () => {
  it('rounds with minimum 1', () => {
    expect(minutesLeft(0, 3_120_000)).toBe('52 min left');
    expect(minutesLeft(0, 89_000)).toBe('1 min left');
    expect(minutesLeft(100, 100)).toBe('1 min left');
  });
});

describe('knownDuration', () => {
  it('prefers a finite engine duration, else the fallback', () => {
    expect(knownDuration(5000, 9000)).toBe(5000);
    expect(knownDuration(Number.NaN, 9000)).toBe(9000);
    expect(knownDuration(Infinity, undefined)).toBeUndefined();
    expect(knownDuration(undefined, 0)).toBeUndefined();
    expect(knownDuration(0, undefined)).toBeUndefined();
  });
});

describe('tracks', () => {
  const t = (id: string, label: string, language?: string, active = false): TrackInfo =>
    language === undefined ? { id, label, active } : { id, label, language, active };

  it('trackKey stores language and label', () => {
    expect(trackKey(t('1', 'English', 'en'))).toBe('en:English');
    expect(trackKey(t('1', 'Track 2'))).toBe(':Track 2');
    expect(trackKey(t('1', 'a:b', 'en'))).toBe('en:a:b');
  });

  it('findTrack matches language and label, then the language, then the label', () => {
    const list = [t('1', 'English', 'en'), t('2', 'English commentary', 'en'), t('3', 'Track 2'), t('4', 'a:b', 'fr')];
    expect(findTrack(list, 'en:English commentary')?.id).toBe('2');
    expect(findTrack(list, 'en:English')?.id).toBe('1');
    expect(findTrack(list, 'en:Renamed')?.id).toBe('1');
    expect(findTrack(list, ':Track 2')?.id).toBe('3');
    expect(findTrack(list, 'fr:a:b')?.id).toBe('4');
    expect(findTrack(list, 'xx:Nothing')).toBeUndefined();
    expect(findTrack(list, undefined)).toBeUndefined();
    expect(findTrack(list, SUBTITLE_KEY_OFF)).toBeUndefined();
  });

  it('findTrack still reads a bare language or label', () => {
    const list = [t('1', 'English', 'en'), t('3', 'Track 2')];
    expect(findTrack(list, 'en')?.id).toBe('1');
    expect(findTrack(list, 'Track 2')?.id).toBe('3');
  });

  it('the Off row id cannot collide with a track row', () => {
    const rows = trackRows([t('off', 'X')], [t('off', 'Y'), t('s:off', 'Z')]);
    const ids = rows.map((r) => (r.kind === 'list' ? r.id : ''));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === SUBTITLES_OFF)).toHaveLength(1);
  });

  it('trackRows lists audio, then subtitles and Off, checking the active ones', () => {
    const rows = trackRows([t('a1', 'English', 'en', true), t('a2', 'Other', 'xx')], [t('s1', 'English', 'en')]);
    expect(rows).toEqual([
      { kind: 'list', id: 'a:a1', label: 'Audio: English', checked: true },
      { kind: 'list', id: 'a:a2', label: 'Audio: Other', checked: false },
      { kind: 'list', id: 's:s1', label: 'Subtitles: English', checked: false },
      { kind: 'list', id: SUBTITLES_OFF, label: 'Subtitles off', checked: true },
    ]);
  });

  it('trackRows checks a subtitle and leaves Off unchecked', () => {
    const rows = trackRows([], [t('s1', 'One', undefined, true)]);
    expect(rows.map((r) => r.kind === 'list' && r.checked)).toEqual([true, false]);
  });
});

describe('nextCardText', () => {
  it('shows the next label and the countdown', () => {
    expect(nextCardText('S2 · E5 · Title', 7)).toBe('Next: S2 · E5 · Title in 7 s');
  });
});

describe('oneSpace', () => {
  it('collapses whitespace', () => {
    expect(oneSpace('  A  b	c ')).toBe('A b c');
    expect(trackRows([{ id: '1', label: 'Two  words', active: false }], [])[0]).toMatchObject({ label: 'Audio: Two words' });
  });
});

describe('cueText', () => {
  it('cleans each line and drops blank ones', () => {
    expect(cueText(null)).toBe('');
    expect(cueText('  One  line ')).toBe('One line');
    expect(cueText('First\r\n\n  Second   part')).toBe('First\nSecond part');
  });
});

describe('titleLengthMs', () => {
  it('prefers the length measured while playing over the catalogue runtime', () => {
    expect(titleLengthMs(60_000, 0.1, 91)).toBe(600_000);
  });
  it('falls back to the runtime, then 0', () => {
    expect(titleLengthMs(0, undefined, 91)).toBe(5_460_000);
    expect(titleLengthMs(60_000, 0, 0)).toBe(0);
    expect(titleLengthMs(0, undefined, undefined)).toBe(0);
  });
});
