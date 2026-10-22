import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '@iptv/player';
import type { VodPlayable } from '@iptv/app-api';
import {
  DV_COLOURS_TEXT, SUBTITLE_KEY_OFF, SUBTITLES_OFF, clock, dvColoursWarning, noSoundText, coverVideo, shapeCheckDue, pauseOnHidden, progressSaveArmed, resumeBarShown, tracksDue, cueText, findTrack, knownDuration, minutesLeft, nextCardText, titleLengthMs, oneSpace, overlayVisible, remaining, trackKey, trackRows, tracksKeyId,
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

  it('trackRows names bare language codes and numbers labels that repeat', () => {
    const rows = trackRows([t('1', 'eng', 'eng', true), t('2', 'eng', 'eng'), t('3', 'swe', 'swe')], [t('4', 'Track 1')]);
    expect(rows.map((r) => r.kind === 'list' && r.label)).toEqual([
      'Audio: English', 'Audio: English (2)', 'Audio: Swedish', 'Subtitles: Subtitle 1', 'Subtitles off',
    ]);
  });

  it('trackRows keeps a label that is not a bare language code, after its language', () => {
    const rows = trackRows([t('1', 'Director commentary', 'en')], []);
    expect(rows[0]!.kind === 'list' && rows[0]!.label).toBe('Audio: English · Director commentary');
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
  it('turns markup that reached it into plain lines (one sanitiser for every path)', () => {
    expect(cueText('<i>One</i><BR>Two&nbsp;too<BR')).toBe('One\nTwo too');
    expect(cueText('{\\an8}<br/>')).toBe('');
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

describe('progressSaveArmed', () => {
  const base = { armed: false, startMs: 600_000, playing: false, posMs: undefined as number | undefined };
  it('is armed at once for a start at 0 (Play from start or no resume point)', () => {
    expect(progressSaveArmed({ ...base, startMs: 0 })).toBe(true);
  });
  it('stays disarmed while loading, even though the playhead reads the start position before any frame', () => {
    expect(progressSaveArmed({ ...base, posMs: 600_000 })).toBe(false);
    expect(progressSaveArmed({ ...base, posMs: 600_000, userPaused: true })).toBe(false); // a pause before 'playing'
  });
  it('arms once this attempt plays near the start position', () => {
    expect(progressSaveArmed({ ...base, playing: true, posMs: 600_000 })).toBe(true);
    expect(progressSaveArmed({ ...base, playing: true, posMs: 595_000 })).toBe(true);
    expect(progressSaveArmed({ ...base, playing: true, posMs: 594_999 })).toBe(false);
    expect(progressSaveArmed({ ...base, playing: true, posMs: Number.NaN })).toBe(false);
  });
  it('stays disarmed while playing at 0 after a dropped start seek', () => {
    expect(progressSaveArmed({ ...base, playing: true, posMs: 0 })).toBe(false);
    expect(progressSaveArmed({ ...base, playing: true, posMs: 30_000 })).toBe(false);
  });
  it('a user seek arms unconditionally; a user pause arms once playing', () => {
    expect(progressSaveArmed({ ...base, userSeeked: true })).toBe(true);
    expect(progressSaveArmed({ ...base, playing: true, posMs: 0, userPaused: true })).toBe(true);
  });
  it('latches once armed', () => {
    expect(progressSaveArmed({ ...base, armed: true, posMs: 0 })).toBe(true);
  });
});

describe('pauseOnHidden', () => {
  it('pauses a playing title when the page hides, nothing else', () => {
    expect(pauseOnHidden({ hidden: true, paused: false, problem: false })).toBe(true);
    expect(pauseOnHidden({ hidden: false, paused: false, problem: false })).toBe(false); // visible again: no auto-resume
    expect(pauseOnHidden({ hidden: true, paused: true, problem: false })).toBe(false);
    expect(pauseOnHidden({ hidden: true, paused: false, problem: true })).toBe(false); // ended or failed
  });
});

describe('shapeCheckDue', () => {
  it('looks for late tracks once a second, only in the first 10 s after the tracks were applied', () => {
    expect(shapeCheckDue(0)).toBe(false);
    expect(shapeCheckDue(4)).toBe(true);
    expect(shapeCheckDue(5)).toBe(false);
    expect(shapeCheckDue(40)).toBe(true);
    expect(shapeCheckDue(44)).toBe(false);
  });
});

describe('tracksDue (late tracks)', () => {
  it('re-applies when the engine lists more tracks than when they were applied (tracks found after playing)', () => {
    expect(tracksDue(1, 1, true, '1/0', '1/2')).toBe(true);
    expect(tracksDue(1, 1, true, '1/2', '1/2')).toBe(false);
    expect(tracksDue(1, 1, false, '1/0', '1/2')).toBe(false);
  });
});

describe('tracksDue', () => {
  it('re-applies the remembered tracks once per engine attempt that plays', () => {
    expect(tracksDue(undefined, 0, true)).toBe(false); // nothing started yet
    expect(tracksDue(undefined, 1, false)).toBe(false);
    expect(tracksDue(undefined, 1, true)).toBe(true);
    expect(tracksDue(1, 1, true)).toBe(false); // applied for this attempt: no loop
    expect(tracksDue(1, 2, true)).toBe(true); // a quick reopen without 'reconnecting'
  });
});

describe('tracksKeyId', () => {
  const base: VodPlayable = { kind: 'movie', itemId: 'm1', url: 'http://x.test/m1', title: 'Synthetic Film', resumeMs: 0, tracks: {} };
  it('uses the item id for a movie', () => {
    expect(tracksKeyId(base)).toBe('m1');
  });
  it('uses the series id for an episode (tracks are remembered per series)', () => {
    const ep: VodPlayable = { ...base, kind: 'episode', itemId: 'e7', series: { id: 's3', season: 2, episode: 4 } };
    expect(tracksKeyId(ep)).toBe('s3');
  });
  it('falls back to the item id for an episode without a series pointer', () => {
    expect(tracksKeyId({ ...base, kind: 'episode', itemId: 'e8' })).toBe('e8');
  });
});

describe('resumeBarShown', () => {
  it('a resume point with a known length shows the bar', () => {
    expect(resumeBarShown(60_000, 600_000)).toBe(true);
  });
  it('no resume point, or an unknown length, hides it', () => {
    expect(resumeBarShown(0, 600_000)).toBe(false);
    expect(resumeBarShown(60_000, 0)).toBe(false);
    expect(resumeBarShown(60_000, Number.NaN)).toBe(false);
  });
});

describe('dvColoursWarning', () => {
  const P5 = { hdr: 'dv', dvProfile: 5, dvFallback: 'none' } as const;
  it('warns for DV without a base layer on a display without DV only', () => {
    expect(dvColoursWarning(P5, {}, 'none')).toBe(true);
    expect(dvColoursWarning({ hdr: 'dv' }, {}, 'none')).toBe(true);
    expect(dvColoursWarning(P5, {}, 'decode')).toBe(false);
    expect(dvColoursWarning(P5, {}, undefined)).toBe(false);
    expect(dvColoursWarning({ hdr: 'dv', dvProfile: 8, dvFallback: 'hdr10' }, {}, 'none')).toBe(false);
    expect(dvColoursWarning(undefined, {}, 'none')).toBe(false);
  });

  it('the player reading a DV-only fourCC is enough, and overrides the source', () => {
    expect(dvColoursWarning(undefined, { videoCodec: 'dvhe', hdr: 'dv' }, 'none')).toBe(true);
    expect(dvColoursWarning({ hdr: 'hdr10' }, { videoCodec: 'dvh1' }, 'none')).toBe(true);
    expect(dvColoursWarning(undefined, { videoCodec: 'HEVC' }, 'none')).toBe(false);
  });

  it('copy', () => {
    expect(DV_COLOURS_TEXT).toBe("Colours may look wrong on this TV: this video is in Dolby Vision, which it can't show.");
  });
});

describe('noSoundText', () => {
  it('says why there is no sound, and suggests another track when there is one', () => {
    expect(noSoundText(1)).toBe("No sound: this device can't play this video's audio format.");
    expect(noSoundText(0)).toBe("No sound: this device can't play this video's audio format.");
    expect(noSoundText(2)).toBe("No sound: this device can't play this video's audio format. Try another track in Audio & subtitles.");
  });
});

describe('coverVideo', () => {
  it('covers until the first picture: no status, loading, reconnecting', () => {
    expect(coverVideo(undefined, false)).toBe(true);
    expect(coverVideo({ kind: 'loading' }, false)).toBe(true);
    expect(coverVideo({ kind: 'reconnecting', attempt: 1 }, false)).toBe(true);
  });
  it('uncovers on playing, and stays uncovered after the first play (a later buffer keeps the picture)', () => {
    expect(coverVideo({ kind: 'playing' }, false)).toBe(false);
    expect(coverVideo({ kind: 'loading' }, true)).toBe(false);
    expect(coverVideo({ kind: 'ended' }, true)).toBe(false);
  });
});
