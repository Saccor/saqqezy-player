import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PlaybackSupervisor,
  type AspectMode, type JournalEvent, type LiveProfile, type PlaybackHealth, type Player, type PlayerState, type Rect, type StateDetail,
  type StreamInfo, type SupervisorOptions, type SupervisorStatus, type TrackInfo,
} from '../src/index.ts';

type Listener = (s: PlayerState, d?: StateDetail) => void;

class FakePlayer implements Player {
  opened: string[] = [];
  ids: Array<number | undefined> = [];
  calls: string[] = [];
  pos = 0;
  throwOnOpen: unknown;
  health?: () => PlaybackHealth;
  seekToLive?: (t: number) => boolean;
  recover?: (a: 'gapJump' | 'softReload') => boolean;
  setPlaybackRate?: (r: number) => void;
  setLiveProfile = vi.fn((_p: LiveProfile) => undefined);
  holdLastFrame = vi.fn(() => undefined);
  releaseLastFrame = vi.fn(() => undefined);
  private listeners = new Set<Listener>();
  open(url: string, attemptId?: number): Promise<void> {
    this.opened.push(url); this.ids.push(attemptId); this.calls.push(`open:${url}`);
    if (this.throwOnOpen !== undefined) { const e = this.throwOnOpen; this.throwOnOpen = undefined; throw e; }
    return Promise.resolve();
  }
  stop(): void { this.calls.push('stop'); }
  setRect(_r: Rect | 'fullscreen'): void {}
  setAspect(_m: AspectMode): void {}
  audioTracks(): TrackInfo[] { return []; }
  selectAudioTrack(_id: string): void {}
  streamInfo(): StreamInfo { return {}; }
  position(): number { return this.pos; }
  onState(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  destroy(): void { this.listeners.clear(); }
  /** Emits a state event for open() number `idx` (default: the latest). */
  emit(s: PlayerState, d: StateDetail = {}, idx = this.ids.length - 1): void {
    const attemptId = this.ids[idx];
    for (const l of [...this.listeners]) l(s, attemptId === undefined ? d : { ...d, attemptId });
  }
}

const A = 'http://a.example.test/1';
const B = 'http://b.example.test/1';

function setup(opts: SupervisorOptions = {}) {
  const player = new FakePlayer();
  const sup = new PlaybackSupervisor(player, { random: () => 0.5, ...opts });
  const statuses: SupervisorStatus[] = [];
  sup.onStatus((s) => statuses.push(s));
  return { player, sup, statuses };
}

/** Advances time in 250 ms ticks while the position moves forward. */
function playFor(player: FakePlayer, ms: number) {
  for (let t = 0; t < ms; t += 250) { player.pos += 250; vi.advanceTimersByTime(250); }
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('PlaybackSupervisor: starting and failing', () => {
  it('releases any held frame, stops, opens; loading then playing', () => {
    const { player, sup, statuses } = setup();
    sup.play(A);
    expect(player.releaseLastFrame).toHaveBeenCalled();
    expect(player.calls).toEqual(['stop', `open:${A}`]);
    player.emit('playing');
    expect(statuses).toEqual([{ kind: 'loading' }, { kind: 'playing' }]);
  });

  it('passes the live profile before opening', () => {
    const { player, sup } = setup({ preset: () => 'stable', allowRate: true });
    sup.play(A);
    expect(player.setLiveProfile).toHaveBeenCalledWith({ preset: 'stable', targetS: 6, allowRate: true });
  });

  it('the first reconnect waits 1 s and holds the last frame; later ones back off 2 s, 4 s', () => {
    const { player, sup } = setup();
    sup.play(A);
    player.emit('playing');
    player.emit('error', { code: 'NETWORK' });
    expect(player.holdLastFrame).toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(player.opened).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(player.opened).toHaveLength(2);
    player.emit('playing');
    player.emit('error', { code: 'NETWORK' });
    vi.advanceTimersByTime(1999);
    expect(player.opened).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(player.opened).toHaveLength(3);
    player.emit('playing');
    player.emit('error', { code: 'NETWORK' });
    vi.advanceTimersByTime(3999);
    expect(player.opened).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(player.opened).toHaveLength(4);
  });

  it('applies jitter from the injected random source', () => {
    const { player, sup } = setup({ random: () => 1 }); // +20 %
    sup.play(A);
    player.emit('playing');
    player.emit('error');
    vi.advanceTimersByTime(1199);
    expect(player.opened).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(player.opened).toHaveLength(2);
    player.emit('playing');
    player.emit('error');
    vi.advanceTimersByTime(2399);
    expect(player.opened).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(player.opened).toHaveLength(3);
  });

  it('shows "reconnecting" only after 1 s without playing; a quick recovery shows nothing', () => {
    // The shortest reconnect wait is now 1 s, the same as the spinner delay, so with the default a reconnect
    // shows the spinner at once; a longer spinner delay keeps the "quick recovery shows nothing" case testable.
    const d = setup();
    d.sup.play(A);
    d.player.emit('playing');
    d.player.emit('error');
    vi.advanceTimersByTime(999);
    expect(d.statuses.at(-1)).toEqual({ kind: 'playing' });
    vi.advanceTimersByTime(1);
    expect(d.statuses.at(-1)).toEqual({ kind: 'reconnecting', attempt: 1 });
    d.sup.dispose();

    const { player, sup, statuses } = setup({ policy: { showSpinnerAfterMs: 1500 } });
    sup.play(A);
    player.emit('playing');
    player.emit('error');
    vi.advanceTimersByTime(1000); // reconnected within the spinner delay
    player.emit('playing');
    vi.advanceTimersByTime(2000);
    expect(statuses.map((s) => s.kind)).toEqual(['loading', 'playing']);
    player.emit('error'); // second failure in a row: retried after 2 s, still not playing at 1.5 s
    vi.advanceTimersByTime(1499);
    expect(statuses.at(-1)).toEqual({ kind: 'playing' });
    vi.advanceTimersByTime(1);
    expect(statuses.at(-1)).toEqual({ kind: 'reconnecting', attempt: 2 });
  });

  it('switches to the alternate after two failures; a string or an array is accepted', () => {
    for (const alt of [B, [B]] as const) {
      const { player, sup, statuses } = setup();
      sup.play(A, alt);
      player.emit('error'); vi.advanceTimersByTime(1000);
      player.emit('error');
      vi.advanceTimersByTime(999); // the switch waits for the 1 s gap since the last open
      expect(player.opened.at(-1)).toBe(A);
      vi.advanceTimersByTime(1);
      expect(player.opened.at(-1)).toBe(B);
      expect(statuses.at(-1)).toEqual({ kind: 'loading' });
      sup.dispose();
    }
  });

  it('UNSUPPORTED goes to the alternate after the 1 s gap, then fails as unsupported', () => {
    const { player, sup, statuses } = setup();
    sup.play(A, B);
    player.emit('error', { code: 'UNSUPPORTED' });
    vi.advanceTimersByTime(1000);
    expect(player.opened).toEqual([A, B]);
    player.emit('error', { code: 'UNSUPPORTED' });
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unsupported' });
  });

  it('keeps the code of a synchronous UNSUPPORTED throw from open()', () => {
    const { player, sup } = setup();
    player.throwOnOpen = { code: 'UNSUPPORTED' };
    sup.play(A, B);
    vi.advanceTimersByTime(1000);
    expect(player.opened).toEqual([A, B]);
  });

  it('AUTH reopens the same URL once, then the alternate, then fails as refused', () => {
    const { player, sup, statuses } = setup();
    sup.play(A, B);
    player.emit('error', { code: 'AUTH' });
    vi.advanceTimersByTime(999);
    expect(player.opened).toEqual([A]);
    vi.advanceTimersByTime(1);
    expect(player.opened).toEqual([A, A]);
    player.emit('error', { code: 'AUTH' });
    vi.advanceTimersByTime(1000);
    expect(player.opened).toEqual([A, A, B]);
    player.emit('error', { code: 'AUTH' });
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'refused' });
  });

  it('once the source refused, a network error before any playback ends as refused with no more retries', () => {
    // A cross-origin 403 on the alternate (raw TS fetch) surfaces as a plain network error: the refusal must stick.
    const { player, sup, statuses } = setup();
    sup.play(A, B);
    player.emit('error', { code: 'AUTH' });
    vi.advanceTimersByTime(1000);
    player.emit('error', { code: 'AUTH' });
    vi.advanceTimersByTime(1000);
    expect(player.opened).toEqual([A, A, B]);
    player.emit('error', { code: 'NETWORK' });
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'refused' });
    vi.advanceTimersByTime(10 * 60_000);
    expect(player.opened).toEqual([A, A, B]);
  });

  it('a refusal after the stream has played does not turn later network errors into refused', () => {
    const { player, sup, statuses } = setup();
    sup.play(A, B);
    player.emit('playing');
    player.emit('error', { code: 'AUTH' });
    vi.advanceTimersByTime(1000);
    player.emit('error', { code: 'NETWORK' });
    expect(statuses.at(-1)).not.toEqual({ kind: 'failed', reason: 'refused' });
    vi.advanceTimersByTime(1000);
    expect(player.opened.length).toBeGreaterThan(2);
  });

  it('EOS reconnects after the 1 s gap and never counts toward the alternate switch', () => {
    const { player, sup } = setup();
    sup.play(A, B);
    for (let i = 0; i < 3; i++) { player.emit('error', { code: 'EOS' }); vi.advanceTimersByTime(1000); }
    expect(player.opened).toEqual([A, A, A, A]);
  });

  it('a no-bytes start fails after 4 s when the engine tracks bytes; flowing bytes wait for the 15 s first-frame limit', () => {
    const { player, sup } = setup();
    player.health = () => ({ positionMs: 0, tracksBytes: true });
    sup.play(A);
    vi.advanceTimersByTime(3999);
    expect(player.opened).toHaveLength(1);
    vi.advanceTimersByTime(1); // fails here; the reconnect follows after the 1 s back-off
    expect(player.opened).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(player.opened).toHaveLength(2);

    const second = setup();
    second.player.health = () => ({ positionMs: 0, tracksBytes: true, lastByteAt: Date.now() });
    second.sup.play(A);
    vi.advanceTimersByTime(14_999);
    expect(second.player.opened).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(second.player.opened).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(second.player.opened).toHaveLength(2);
  });
});

describe('PlaybackSupervisor: stall ladder while playing', () => {
  it('without health data, only the 8 s backstop reconnects', () => {
    const { player, sup } = setup();
    sup.play(A);
    player.emit('playing');
    vi.advanceTimersByTime(7750);
    expect(player.opened).toHaveLength(1);
    vi.advanceTimersByTime(250); // the backstop decides here; the reconnect follows after 1 s
    expect(player.opened).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(player.opened).toHaveLength(2);
  });

  it('a moving position never reconnects', () => {
    const { player, sup } = setup();
    sup.play(A);
    player.emit('playing');
    playFor(player, 60_000);
    expect(player.opened).toHaveLength(1);
  });

  it('gap-jumps after 1 s without progress when data is buffered', () => {
    const { player, sup } = setup();
    player.recover = vi.fn(() => true);
    player.health = () => ({ positionMs: player.pos, bufferAheadS: 2 });
    sup.play(A);
    player.emit('playing');
    vi.advanceTimersByTime(750);
    expect(player.recover).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(player.recover).toHaveBeenCalledWith('gapJump');
  });

  it('reconnects when no bytes arrived for 2.5 s', () => {
    const { player, sup } = setup();
    const start = Date.now();
    player.health = () => ({ positionMs: player.pos, bufferAheadS: 0.2, tracksBytes: true, lastByteAt: start });
    sup.play(A);
    player.emit('playing');
    vi.advanceTimersByTime(2250);
    expect(player.opened).toHaveLength(1);
    vi.advanceTimersByTime(250); // decided here; the reconnect follows after 1 s
    expect(player.opened).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(player.opened).toHaveLength(2);
  });

  it('30 s of stable play restores the 1 s first retry', () => {
    const { player, sup } = setup();
    sup.play(A);
    player.emit('playing');
    player.emit('error'); vi.advanceTimersByTime(1000); // failure 1
    player.emit('playing');
    playFor(player, 30_000);
    player.emit('error');
    vi.advanceTimersByTime(999);
    expect(player.opened).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(player.opened).toHaveLength(3); // 1 s again, not the 2 s of a second failure
  });

  it('runs out of budget after 6 reconnects in a minute, then retries every 30 s and recovers', () => {
    const { player, sup, statuses } = setup();
    sup.play(A);
    player.emit('playing'); // background retries are only for a stream that played
    for (let i = 0; i < 6; i++) { player.emit('error', { code: 'EOS' }); vi.advanceTimersByTime(1000); }
    expect(player.opened).toHaveLength(7);
    player.emit('error', { code: 'EOS' });
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unavailable' });
    vi.advanceTimersByTime(29_999);
    expect(player.opened).toHaveLength(7);
    vi.advanceTimersByTime(1);
    expect(player.opened).toHaveLength(8);
    player.emit('playing');
    expect(statuses.at(-1)).toEqual({ kind: 'playing' });
  });

  it('give-up retries stop after 3 minutes and on stop()', () => {
    const { player, sup } = setup();
    sup.play(A);
    player.emit('playing');
    for (let i = 0; i < 7; i++) { player.emit('error', { code: 'EOS' }); vi.advanceTimersByTime(1000); }
    for (let i = 0; i < 10; i++) { vi.advanceTimersByTime(30_000); player.emit('error'); }
    const n = player.opened.length;
    expect(n).toBeLessThanOrEqual(7 + 6); // 3 minutes at one try per 30 s
    vi.advanceTimersByTime(60_000);
    expect(player.opened).toHaveLength(n);

    const other = setup();
    other.sup.play(A);
    other.player.emit('playing');
    for (let i = 0; i < 7; i++) { other.player.emit('error', { code: 'EOS' }); vi.advanceTimersByTime(1000); }
    other.sup.stop();
    vi.advanceTimersByTime(60_000);
    expect(other.player.opened).toHaveLength(7);
  });

  it('ignores events from old attempts and after stop()', () => {
    const { player, sup, statuses } = setup();
    sup.play(A);
    player.emit('error'); vi.advanceTimersByTime(0);
    player.emit('error', {}, 0); // attempt 1 is over
    vi.advanceTimersByTime(1000);
    expect(player.opened).toHaveLength(2);
    sup.stop();
    player.emit('error');
    vi.advanceTimersByTime(10_000);
    expect(player.opened).toHaveLength(2);
    expect(player.releaseLastFrame).toHaveBeenCalledTimes(2); // play() and stop()
    expect(statuses.filter((s) => s.kind === 'failed')).toEqual([]);
  });
});

describe('PlaybackSupervisor: live delay', () => {
  const liveHealth = (player: FakePlayer, behindLiveS: number, bufferAheadS = 3) =>
    () => ({ positionMs: player.pos, bufferAheadS, behindLiveS, behindLiveSource: 'edge' as const, targetDurationS: 2 });

  it('seeks to live after two over-threshold samples (every 2 s)', () => {
    const { player, sup } = setup();
    player.seekToLive = vi.fn(() => true);
    player.health = liveHealth(player, 15);
    sup.play(A);
    player.emit('playing');
    playFor(player, 3750);
    expect(player.seekToLive).not.toHaveBeenCalled();
    playFor(player, 250);
    expect(player.seekToLive).toHaveBeenCalledWith(6);
  });

  it('reopens when far behind for two samples in a row', () => {
    const { player, sup } = setup();
    player.health = liveHealth(player, 40);
    sup.play(A);
    player.emit('playing');
    playFor(player, 2000);
    expect(player.opened).toHaveLength(1);
    playFor(player, 2000);
    expect(player.opened).toHaveLength(2);
  });

  it('sets a gentle rate only when allowed', () => {
    const { player, sup } = setup({ allowRate: true });
    player.setPlaybackRate = vi.fn();
    player.health = liveHealth(player, 9);
    sup.play(A);
    player.emit('playing');
    playFor(player, 2000);
    expect(player.setPlaybackRate).toHaveBeenCalledWith(1.05);

    const tv = setup({ allowRate: false });
    tv.player.setPlaybackRate = vi.fn();
    tv.player.health = liveHealth(tv.player, 9);
    tv.sup.play(A);
    tv.player.emit('playing');
    playFor(tv.player, 2000);
    expect(tv.player.setPlaybackRate).not.toHaveBeenCalled();
  });

  it('loads the learned raise per source and saves it on stop()', () => {
    const store = { get: vi.fn((_k: string) => 1), set: vi.fn((_k: string, _v: number) => undefined) };
    const { player, sup } = setup({ liveTargets: store });
    sup.play(A, undefined, { sourceKey: 's1' });
    expect(store.get).toHaveBeenCalledWith('s1');
    expect(player.setLiveProfile).toHaveBeenCalledWith({ preset: 'balanced', targetS: 4, allowRate: false });
    sup.stop();
    expect(store.set).toHaveBeenCalledWith('s1', 1);
  });

  it('a stall while playing raises the target and is counted', () => {
    const { player, sup } = setup();
    sup.play(A);
    player.emit('playing');
    player.emit('buffering');
    player.emit('playing');
    expect(sup.liveInfo()).toMatchObject({ stalls: 1, targetS: 3.75, reconnects: 0 });
  });

  it('goLive seeks, or reopens when the engine cannot seek', () => {
    const { player, sup } = setup();
    player.seekToLive = vi.fn(() => false);
    sup.play(A);
    player.emit('playing');
    sup.goLive();
    expect(player.seekToLive).toHaveBeenCalledWith(3);
    vi.advanceTimersByTime(999);
    expect(player.opened).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(player.opened).toHaveLength(2);
  });

  it('jumps to live on resume after more than 30 s away', () => {
    const { player, sup } = setup();
    player.seekToLive = vi.fn(() => true);
    sup.play(A);
    player.emit('playing');
    sup.onResume(30_000);
    expect(player.seekToLive).not.toHaveBeenCalled();
    sup.onResume(30_001);
    expect(player.seekToLive).toHaveBeenCalledTimes(1);
  });

  it('liveInfo reports the latest health sample', () => {
    const { player, sup } = setup();
    player.health = liveHealth(player, 7);
    sup.play(A);
    player.emit('playing');
    playFor(player, 250);
    expect(sup.liveInfo()).toMatchObject({ behindLiveS: 7, source: 'edge', bufferAheadS: 3 });
  });
});

describe('PlaybackSupervisor: final fixes', () => {
  const vod = (player: FakePlayer, extra: Partial<PlaybackHealth> = {}) =>
    () => ({ positionMs: player.pos, bufferAheadS: 3, behindLiveS: 635, behindLiveSource: 'edge' as const, isLive: false, ...extra });

  it('1b: no live delay control without an explicit measure source', () => {
    const { player, sup } = setup();
    player.seekToLive = vi.fn(() => true);
    player.health = () => ({ positionMs: player.pos, bufferAheadS: 30 });
    sup.play(A);
    player.emit('playing');
    playFor(player, 10_000);
    expect(player.seekToLive).not.toHaveBeenCalled();
    expect(player.opened).toHaveLength(1);
  });

  it('1b/1c: a non-live stream is never seeked to its end or reopened for drift', () => {
    const { player, sup } = setup({ allowRate: true });
    player.seekToLive = vi.fn(() => true);
    player.setPlaybackRate = vi.fn();
    player.health = vod(player);
    sup.play(A);
    player.emit('playing');
    playFor(player, 20_000);
    expect(player.seekToLive).not.toHaveBeenCalled();
    expect(player.setPlaybackRate).not.toHaveBeenCalled();
    expect(player.opened).toHaveLength(1);
  });

  it('1c: the stall ladder gap-jumps or waits on a non-live stream, never seeks to the end', () => {
    const { player, sup } = setup();
    player.seekToLive = vi.fn(() => true);
    player.recover = vi.fn(() => true);
    player.health = vod(player);
    sup.play(A);
    player.emit('playing');
    vi.advanceTimersByTime(3500); // position frozen: gap jumps, then the edge seek would be next
    expect(player.recover).toHaveBeenCalledWith('gapJump');
    expect(player.seekToLive).not.toHaveBeenCalled();
  });

  it('1c: goLive and onResume do nothing on a non-live stream', () => {
    const { player, sup } = setup();
    player.seekToLive = vi.fn(() => false);
    player.health = vod(player);
    sup.play(A);
    player.emit('playing');
    playFor(player, 250);
    sup.goLive();
    sup.onResume(60_000);
    vi.advanceTimersByTime(0);
    expect(player.seekToLive).not.toHaveBeenCalled();
    expect(player.opened).toHaveLength(1);
  });

  it('sticky liveness: isLive true then false in one play() stays live (goLive still seeks, liveInfo stays live); a new play() resets', () => {
    const { player, sup } = setup();
    player.seekToLive = vi.fn(() => true);
    let live = true;
    player.health = () => ({ positionMs: player.pos, bufferAheadS: 3, behindLiveS: 5, behindLiveSource: 'edge' as const, isLive: live });
    sup.play(A);
    player.emit('playing');
    playFor(player, 250);
    live = false;
    playFor(player, 250);
    expect(sup.liveInfo()).toMatchObject({ isLive: true });
    sup.goLive();
    expect(player.seekToLive).toHaveBeenCalled();
    sup.play(B);
    player.emit('playing');
    playFor(player, 250);
    expect(sup.liveInfo()).toMatchObject({ isLive: false });
  });

  it('1c: stalls on a non-live stream are not counted, do not raise the target and are not persisted', () => {
    const store = { get: vi.fn((_k: string) => 0), set: vi.fn((_k: string, _v: number) => undefined) };
    const { player, sup } = setup({ liveTargets: store });
    player.health = vod(player);
    sup.play(A, undefined, { sourceKey: 's1' });
    player.emit('playing');
    playFor(player, 250);
    player.emit('buffering');
    player.emit('playing');
    expect(sup.liveInfo()).toMatchObject({ stalls: 0, targetS: 3, isLive: false });
    sup.stop();
    expect(store.set).not.toHaveBeenCalled();
  });

  it("1d/1f: 'idle' (a non-live stream ended) stops the stall ladder: nothing reconnects", () => {
    const { player, sup } = setup();
    sup.play(A);
    player.emit('playing');
    player.emit('idle');
    vi.advanceTimersByTime(30_000);
    expect(player.opened).toHaveLength(1);
  });

  it('1h/2: liveInfo carries isLive and the stream clock', () => {
    const { player, sup } = setup();
    player.health = () => ({
      positionMs: player.pos, behindLiveS: 7, behindLiveSource: 'edge' as const, streamClockBehindS: 12, isLive: true,
    });
    sup.play(A);
    player.emit('playing');
    playFor(player, 250);
    expect(sup.liveInfo()).toMatchObject({ behindLiveS: 7, source: 'edge', streamClockBehindS: 12, isLive: true });
  });

  it('2: a drift reopen that did not help is not repeated within this play(); a new play() resets it', () => {
    const { player, sup } = setup();
    player.seekToLive = vi.fn(() => true);
    player.health = () => ({ positionMs: player.pos, bufferAheadS: 3, behindLiveS: 40, behindLiveSource: 'edge' as const, targetDurationS: 2 });
    sup.play(A);
    player.emit('playing');
    playFor(player, 4000);
    expect(player.opened).toHaveLength(2); // two samples above the line: one reopen
    player.emit('playing');
    playFor(player, 30_000);
    expect(player.opened).toHaveLength(2); // still 40 s behind after the reopen: no loop
    sup.play(A);
    player.emit('playing');
    playFor(player, 4000);
    expect(player.opened).toHaveLength(4);
  });

  it('4: waiting/playing right after our own seek or gap jump is not a stall', () => {
    const { player, sup } = setup();
    player.seekToLive = vi.fn(() => true);
    sup.play(A);
    player.emit('playing');
    sup.goLive();
    player.emit('buffering');
    player.emit('playing');
    expect(sup.liveInfo()).toMatchObject({ stalls: 0, targetS: 3 });
    playFor(player, 2500);
    player.emit('buffering'); // a real stall later still counts
    player.emit('playing');
    expect(sup.liveInfo().stalls).toBe(1);

    const g = setup();
    g.player.recover = vi.fn(() => true);
    g.player.health = () => ({ positionMs: g.player.pos, bufferAheadS: 2 });
    g.sup.play(A);
    g.player.emit('playing');
    vi.advanceTimersByTime(1000);
    expect(g.player.recover).toHaveBeenCalledWith('gapJump');
    g.player.emit('buffering');
    g.player.emit('playing');
    expect(g.sup.liveInfo().stalls).toBe(0);
  });

  it('5: frozen frames while hidden never reconnect; becoming visible starts a fresh watch', () => {
    const { player, sup } = setup();
    player.health = () => ({ positionMs: player.pos, framesPresented: 100 });
    sup.play(A);
    player.emit('playing');
    playFor(player, 1000);
    sup.setHidden(true);
    playFor(player, 20_000);
    expect(player.opened).toHaveLength(1);
    sup.setHidden(false);
    player.health = () => ({ positionMs: player.pos, framesPresented: 200 + player.pos });
    playFor(player, 5000);
    expect(player.opened).toHaveLength(1);
  });

  it('6: a failed edge seek in the tick reopens without counting a failure', () => {
    const { player, sup } = setup();
    player.seekToLive = vi.fn(() => false);
    player.recover = vi.fn(() => true);
    player.health = () => ({ positionMs: player.pos, bufferAheadS: 3 });
    sup.play(A, B);
    player.emit('playing');
    vi.advanceTimersByTime(3250); // three gap jumps, then the edge seek fails
    expect(player.seekToLive).toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(player.opened).toEqual([A, A]);
    player.emit('error', { code: 'NETWORK' }); // the first real failure: retried on A, not the alternate
    vi.advanceTimersByTime(1000);
    expect(player.opened).toEqual([A, A, A]);
  });

  it('6: EOS and AUTH while playing are not stalls and do not raise the target', () => {
    for (const code of ['EOS', 'AUTH'] as const) {
      const { player, sup } = setup();
      sup.play(A);
      player.emit('playing');
      player.emit('error', { code });
      expect(sup.liveInfo()).toMatchObject({ stalls: 0, targetS: 3 });
      sup.dispose();
    }
  });

  it('6: a player-dispatched failure switches to the alternate one macrotask later, with the same guards', () => {
    const { player, sup, statuses } = setup();
    sup.play(A, B);
    player.emit('error', { code: 'UNSUPPORTED' });
    expect(player.opened).toEqual([A]); // never torn down inside the engine callback
    vi.advanceTimersByTime(999);
    expect(player.opened).toEqual([A]);
    vi.advanceTimersByTime(1);
    expect(player.opened).toEqual([A, B]);
    expect(statuses.at(-1)).toEqual({ kind: 'loading' });

    const s = setup();
    s.sup.play(A, B);
    s.player.emit('error', { code: 'UNSUPPORTED' });
    s.sup.stop();
    vi.advanceTimersByTime(1000);
    expect(s.player.opened).toEqual([A]);
  });
});

describe('PlaybackSupervisor: gentle on sources (single-connection accounts)', () => {
  it('never opens the stream again sooner than 1 s after the last open, whatever failed', () => {
    for (const code of ['NETWORK', 'EOS'] as const) {
      const { player, sup } = setup();
      sup.play(A);
      player.emit('playing');
      player.emit('error', { code });
      vi.advanceTimersByTime(999);
      expect(player.opened).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(player.opened).toHaveLength(2);
      sup.dispose();
    }
  });

  it('backs off 1 s, 2 s, 4 s between repeated failures of a stream that had played', () => {
    const { player, sup } = setup();
    sup.play(A);
    player.emit('playing');
    player.emit('error'); vi.advanceTimersByTime(1000);
    expect(player.opened).toHaveLength(2);
    player.emit('error'); vi.advanceTimersByTime(1999);
    expect(player.opened).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(player.opened).toHaveLength(3);
    player.emit('error'); vi.advanceTimersByTime(3999);
    expect(player.opened).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(player.opened).toHaveLength(4);
  });

  it('switches to the alternate no sooner than 1 s after the last open', () => {
    const { player, sup } = setup();
    sup.play(A, B);
    player.emit('error', { code: 'UNSUPPORTED' });
    vi.advanceTimersByTime(999);
    expect(player.opened).toEqual([A]);
    vi.advanceTimersByTime(1);
    expect(player.opened).toEqual([A, B]);
  });

  it('a channel that never started gets two tries per format, then stops for good', () => {
    const { player, sup, statuses } = setup();
    sup.play(A, B);
    for (let i = 0; i < 4; i++) { player.emit('error', { code: 'NETWORK' }); vi.advanceTimersByTime(5000); }
    expect(player.opened).toEqual([A, A, B, B]);
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unavailable' });
    vi.advanceTimersByTime(30 * 60_000);
    expect(player.opened).toEqual([A, A, B, B]);
  });

  it('a stream that played and then dropped is retried in the background every 30 s for 3 minutes', () => {
    const { player, sup, statuses } = setup();
    sup.play(A);
    player.emit('playing');
    for (let i = 0; i < 7; i++) { player.emit('error', { code: 'EOS' }); vi.advanceTimersByTime(1000); }
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unavailable' });
    const n = player.opened.length;
    vi.advanceTimersByTime(28_999); // the loop already advanced 1 s after the give-up began
    expect(player.opened).toHaveLength(n);
    vi.advanceTimersByTime(1);
    expect(player.opened).toHaveLength(n + 1);
    for (let i = 0; i < 10; i++) { player.emit('error'); vi.advanceTimersByTime(30_000); }
    const m = player.opened.length;
    expect(m).toBeLessThanOrEqual(n + 6); // 3 minutes at one try per 30 s
    vi.advanceTimersByTime(10 * 60_000);
    expect(player.opened).toHaveLength(m);
  });
});

describe('PlaybackSupervisor: journal', () => {
  function journaled(opts: SupervisorOptions = {}) {
    const log: JournalEvent[] = [];
    const s = setup({ ...opts, journal: { add: (e) => { log.push(e); } } });
    return { ...s, log, kinds: () => log.map((e) => e.k) };
  }

  it('play, open and the first frame, with the engine and time to picture', () => {
    const { player, sup, log } = journaled();
    player.health = () => ({ positionMs: player.pos, engine: 'hls.js' });
    sup.play(A, B, { channel: 'Channel 1' });
    vi.advanceTimersByTime(300);
    player.emit('playing');
    expect(log).toMatchObject([
      { k: 'play', channel: 'Channel 1', preset: 'balanced', urls: 2 },
      { k: 'open', attempt: 1, urlIndex: 0 },
      { k: 'playing', attempt: 1, firstFrameMs: 300, engine: 'hls.js' },
    ]);
    expect(log.every((e) => typeof e.t === 'number')).toBe(true);
  });

  it('a no-bytes ladder step: ladder reconnect, then reconnect with its cause and real delay', () => {
    const { player, sup, log } = journaled();
    const start = Date.now();
    player.health = () => ({ positionMs: player.pos, bufferAheadS: 0.2, tracksBytes: true, lastByteAt: start });
    sup.play(A);
    player.emit('playing');
    vi.advanceTimersByTime(2500);
    expect(log.slice(-2)).toMatchObject([
      { k: 'ladder', action: 'reconnect', reason: 'noBytes', bufferAheadS: 0.2 },
      { k: 'reconnect', cause: 'noBytes', delayMs: 1000 },
    ]);
  });

  it('engine errors keep code, status, detail and engine; EOS and AUTH name their cause', () => {
    const { player, sup, log } = journaled();
    player.health = () => ({ positionMs: 0, engine: 'mpegts.js' });
    sup.play(A);
    player.emit('error', { code: 'AUTH', httpStatus: 403, detail: 'HttpStatusCodeInvalid' });
    expect(log.slice(-2)).toMatchObject([
      { k: 'error', code: 'AUTH', httpStatus: 403, detail: 'HttpStatusCodeInvalid', engine: 'mpegts.js' },
      { k: 'reconnect', cause: 'AUTH', delayMs: 1000 },
    ]);

    const eos = journaled();
    eos.sup.play(A);
    eos.player.emit('playing');
    eos.player.emit('error', { code: 'EOS' });
    expect(eos.log.slice(-2)).toMatchObject([{ k: 'error', code: 'EOS' }, { k: 'reconnect', cause: 'EOS' }]);
  });

  it('an error without a code is UNKNOWN; a start timeout is logged as such', () => {
    const { player, sup, log } = journaled();
    sup.play(A);
    player.emit('error');
    expect(log.at(-2)).toMatchObject({ k: 'error', code: 'UNKNOWN' });

    const slow = journaled();
    slow.player.health = () => ({ positionMs: 0, tracksBytes: true });
    slow.sup.play(A);
    vi.advanceTimersByTime(4000);
    expect(slow.log.slice(-2)).toMatchObject([
      { k: 'error', code: 'NETWORK', detail: 'noBytesAtStart' },
      { k: 'reconnect', cause: 'startTimeout', delayMs: 1000 },
    ]);
  });

  it('a stall while playing logs its start (with the buffer) and its end (with the duration)', () => {
    const { player, sup, log } = journaled();
    player.health = () => ({ positionMs: player.pos, bufferAheadS: 1.5 });
    sup.play(A);
    player.emit('playing');
    playFor(player, 3000);
    player.emit('buffering');
    vi.advanceTimersByTime(700);
    player.emit('playing');
    expect(log.filter((e) => e.k === 'stall')).toMatchObject([
      { phase: 'start', bufferAheadS: 1.5 },
      { phase: 'end', durationMs: 700 },
    ]);
  });

  it('a stall that ends in a reconnect still logs its end, before the reconnect', () => {
    const { player, sup, log } = journaled();
    player.health = () => ({ positionMs: player.pos, bufferAheadS: 1.5 });
    sup.play(A);
    player.emit('playing');
    playFor(player, 3000);
    player.emit('buffering');
    vi.advanceTimersByTime(500);
    player.emit('error', { code: 'NETWORK' });
    const stalls = log.filter((e) => e.k === 'stall');
    expect(stalls).toMatchObject([{ phase: 'start' }, { phase: 'end', durationMs: 500 }]);
    const end = log.findIndex((e) => e.k === 'stall' && e.phase === 'end');
    expect(log[end + 1]).toMatchObject({ k: 'reconnect', cause: 'NETWORK' });
  });

  it('a drift reopen and a go-live reopen name their cause', () => {
    const { player, sup, log } = journaled();
    player.health = () => ({ positionMs: player.pos, bufferAheadS: 3, behindLiveS: 40, behindLiveSource: 'edge' as const, targetDurationS: 2 });
    sup.play(A);
    player.emit('playing');
    playFor(player, 4000);
    const at = log.findIndex((e) => e.k === 'drift');
    expect(log[at]).toMatchObject({ k: 'drift', action: 'reopen', behindS: 40, targetS: expect.any(Number) });
    expect(log[at + 1]).toMatchObject({ k: 'reconnect', cause: 'drift' });

    const live = journaled();
    live.player.health = () => ({ positionMs: live.player.pos, isLive: true });
    live.sup.play(A);
    live.player.emit('playing');
    playFor(live.player, 1000);
    live.sup.goLive();
    expect(live.log.at(-1)).toMatchObject({ k: 'reconnect', cause: 'goLive', delayMs: 0 });
  });

  it('a gentle rate change is logged as drift rate', () => {
    const { player, sup, log } = journaled({ allowRate: true });
    player.setPlaybackRate = vi.fn();
    player.health = () => ({ positionMs: player.pos, bufferAheadS: 3, behindLiveS: 9, behindLiveSource: 'edge' as const, targetDurationS: 2 });
    sup.play(A);
    player.emit('playing');
    playFor(player, 2000);
    expect(log.find((e) => e.k === 'drift')).toMatchObject({ action: 'rate', rate: 1.05, behindS: 9 });
  });

  it('alternate, failed, give-up retry and stop', () => {
    const { player, sup, log } = journaled();
    sup.play(A, B);
    player.emit('error'); vi.advanceTimersByTime(1000);
    player.emit('error'); vi.advanceTimersByTime(1000);
    player.emit('error'); vi.advanceTimersByTime(1000);
    player.emit('error');
    expect(log.find((e) => e.k === 'alternate')).toMatchObject({ urlIndex: 1 });
    expect(log.at(-1)).toMatchObject({ k: 'failed', reason: 'unavailable' });

    const retry = journaled();
    retry.sup.play(A);
    retry.player.emit('playing');
    for (let i = 0; i < 7; i++) { retry.player.emit('error', { code: 'EOS' }); vi.advanceTimersByTime(1000); }
    vi.advanceTimersByTime(30_000);
    expect(retry.kinds()).toContain('giveUpRetry');
    retry.sup.stop();
    expect(retry.log.at(-1)).toMatchObject({ k: 'stop' });
  });

  it('a journal that throws never affects playback', () => {
    const { player, sup, statuses } = setup({ journal: { add: () => { throw new Error('broken'); } } });
    sup.play(A);
    player.emit('playing');
    expect(statuses).toEqual([{ kind: 'loading' }, { kind: 'playing' }]);
  });
});
