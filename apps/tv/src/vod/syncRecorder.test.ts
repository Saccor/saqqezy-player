import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '@iptv/player';
import { SYNC_GIVE_UP_PLAYED_MS, SyncRecorder, syncReferenceTrack } from './syncRecorder.ts';

const track = (id: string, over: Partial<TrackInfo> = {}): TrackInfo => ({ id, label: id, active: false, ...over });

describe('SyncRecorder', () => {
  it('records each line on screen and the spans played without a seek', () => {
    const r = new SyncRecorder();
    r.tick(10_000, true);
    r.cue(true, 10_500);
    r.tick(11_000, true);
    r.cue(false, 12_000);
    r.tick(12_000, true);
    r.cue(true, 13_000);
    r.cue(true, 14_000); // the next line straight after: the first ends, the next starts
    r.cue(false, 15_000);
    r.tick(15_000, true);
    expect(r.sample()).toEqual({ cues: [[10_500, 12_000], [13_000, 14_000], [14_000, 15_000]], played: [[10_000, 15_000]] });
    expect(r.playedMs()).toBe(5000);
  });

  it('a seek starts a new span and drops a line left open across it; a pause ends the span', () => {
    const r = new SyncRecorder();
    r.tick(0, true);
    r.tick(1000, true);
    r.cue(true, 1500);
    r.tick(60_000, true); // seek forward
    r.cue(false, 60_200);
    r.tick(61_000, true);
    r.tick(61_500, false); // paused
    r.tick(61_500, false);
    r.tick(61_500, true);
    r.tick(62_500, true);
    expect(r.sample()).toEqual({ cues: [], played: [[0, 1000], [60_000, 61_000], [61_500, 62_500]] });
  });

  it('gives up after enough played video', () => {
    const r = new SyncRecorder();
    for (let t = 0; t <= SYNC_GIVE_UP_PLAYED_MS; t += 1000) r.tick(t, true);
    expect(r.exhausted()).toBe(true);
  });
});

describe('syncReferenceTrack', () => {
  it('the loaded file\'s language when the stream has it, else the first full (not forced) track', () => {
    const tracks = [track('1', { label: 'Svenska', language: 'swe' }), track('2', { label: 'English', language: 'eng' }), track('3', { label: 'English forced', language: 'eng', forced: true })];
    expect(syncReferenceTrack(tracks, 'en')?.id).toBe('2');
    expect(syncReferenceTrack(tracks, 'de')?.id).toBe('1');
    expect(syncReferenceTrack(tracks, undefined)?.id).toBe('1');
    expect(syncReferenceTrack([track('9', { label: 'Forced', forced: true })], 'en')).toBeUndefined();
    expect(syncReferenceTrack([], 'en')).toBeUndefined();
  });
});
