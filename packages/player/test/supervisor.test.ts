import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_POLICY, PlaybackSupervisor,
  type AspectMode, type JournalEvent, type LiveProfile, type OpenOptions, type PlaybackHealth, type Player, type PlayerState, type Rect, type StateDetail,
  type StreamInfo, type SupervisorOptions, type SupervisorStatus, type TrackInfo,
} from '../src/index.ts';

type Listener = (s: PlayerState, d?: StateDetail) => void;

class FakePlayer implements Player {
  opened: string[] = [];
  ids: Array<number | undefined> = [];
  openOpts: Array<OpenOptions | undefined> = [];
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
  pause = vi.fn(() => undefined);
  play = vi.fn(() => undefined);
  seek?: (ms: number) => boolean;
  duration?: () => number | undefined;
  onSubtitle?: (fn: (text: string | null) => void) => () => void;
  private listeners = new Set<Listener>();
  open(url: string, attemptId?: number, opts?: OpenOptions): Promise<void> {
    this.opened.push(url); this.ids.push(attemptId); this.openOpts.push(opts); this.calls.push(`open:${url}`);
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
  // The gap spread and the open-rate wake jitter are pinned to 0 here so the older tests keep exact timings; their
  // own tests set them.
  const sup = new PlaybackSupervisor(player, {
    random: () => 0.5, ...opts, policy: { openGapSpreadMs: 0, openRateWakeJitterMs: 0, ...opts.policy },
  });
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

/** Lets resolved promises run without moving the clock. */
async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve(); }

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
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'refused', urlIndex: 1 });
  });

  it('the refused status names the URL whose attempt the source refused (no URL in it)', () => {
    const first = setup();
    first.sup.play(A, B);
    first.player.emit('error', { code: 'AUTH' });
    vi.advanceTimersByTime(1000);
    first.player.emit('error', { code: 'AUTH' });
    vi.advanceTimersByTime(1000);
    first.player.emit('error', { code: 'NETWORK' }); // the alternate fails in disguise: the refusal was the primary's
    expect(first.statuses.at(-1)).toEqual({ kind: 'failed', reason: 'refused', urlIndex: 0 });
    first.sup.dispose();
    const alt = setup();
    alt.sup.play(A, B);
    alt.player.emit('error', { code: 'AUTH' });
    vi.advanceTimersByTime(1000);
    alt.player.emit('error', { code: 'AUTH' });
    vi.advanceTimersByTime(1000);
    alt.player.emit('error', { code: 'AUTH' }); // the alternate was refused itself
    expect(alt.statuses.at(-1)).toEqual({ kind: 'failed', reason: 'refused', urlIndex: 1 });
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
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'refused', urlIndex: 0 });
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

  it('runs out of budget after 6 reconnects in a minute, then retries in the background once the budget has room, and recovers', () => {
    const { player, sup, statuses } = setup();
    sup.play(A);
    player.emit('playing'); // background retries are only for a stream that played
    for (let i = 0; i < 6; i++) { player.emit('error', { code: 'EOS' }); vi.advanceTimersByTime(1000); }
    expect(player.opened).toHaveLength(7);
    player.emit('error', { code: 'EOS' });
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unavailable' });
    // The 30 s step finds the budget still spent and is skipped; the 60 s step after it opens.
    vi.advanceTimersByTime(89_999);
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
    vi.advanceTimersByTime(1000); // the gap after the last open
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

  it('a stream that played and then dropped is retried in the background a few times, then left alone', () => {
    const { player, sup, statuses } = setup({ budget: [{ max: 6, windowMs: 20_000 }] });
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
    expect(m).toBeLessThanOrEqual(n + 3); // 30 s, 60 s, 120 s
    vi.advanceTimersByTime(10 * 60_000);
    expect(player.opened).toHaveLength(m);
  });
});

describe('PlaybackSupervisor: one format per play', () => {
  it('a stream that played keeps its format on every reconnect', () => {
    const { player, sup } = setup();
    sup.play(A, B);
    player.emit('playing');
    for (let i = 0; i < 3; i++) { player.emit('error', { code: 'NETWORK' }); vi.advanceTimersByTime(8000); }
    expect(player.opened).toEqual([A, A, A, A]);
  });

  it('a give-up retry reopens the format that played, never the first one again', () => {
    const { player, sup } = setup();
    sup.play(A, B);
    player.emit('error'); vi.advanceTimersByTime(1000);
    player.emit('error'); vi.advanceTimersByTime(1000);
    expect(player.opened).toEqual([A, A, B]);
    player.emit('playing');
    for (let i = 0; i < 7; i++) { player.emit('error', { code: 'EOS' }); vi.advanceTimersByTime(1000); }
    vi.advanceTimersByTime(30_000);
    expect(player.opened.length).toBeGreaterThan(3);
    expect(player.opened.slice(2).every((u) => u === B)).toBe(true);
  });

  it('UNSUPPORTED after the stream played stops as unsupported without switching', () => {
    const { player, sup, statuses } = setup();
    sup.play(A, B);
    player.emit('playing');
    player.emit('error', { code: 'UNSUPPORTED' });
    vi.advanceTimersByTime(5000);
    expect(player.opened).toEqual([A]);
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unsupported' });
  });

  it('AUTH after the stream played retries the same URL once, then stops as refused without switching', () => {
    const { player, sup, statuses } = setup();
    sup.play(A, B);
    player.emit('playing');
    player.emit('error', { code: 'AUTH' });
    vi.advanceTimersByTime(1000);
    expect(player.opened).toEqual([A, A]);
    player.emit('error', { code: 'AUTH' });
    vi.advanceTimersByTime(5000);
    expect(player.opened).toEqual([A, A]);
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'refused', urlIndex: 0 });
  });

  it('a channel that never played still tries the other format once', () => {
    const { player, sup } = setup();
    sup.play(A, B);
    player.emit('error', { code: 'UNSUPPORTED' });
    vi.advanceTimersByTime(1000);
    expect(player.opened).toEqual([A, B]);
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
    vi.advanceTimersByTime(90_000); // the 30 s step is skipped while the budget is spent
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

describe('PlaybackSupervisor – per-source open rate', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a user play() is never held by the cap and does not count against it', () => {
    const taken: string[] = [];
    const journal: JournalEvent[] = [];
    const { player, sup } = setup({
      openRate: { waitMs: () => 60_000, take: (k) => { taken.push(k); } },
      journal: { add: (e: unknown) => { journal.push(e as JournalEvent); } } as never,
    });
    // Paced only by the gap (1 s here), never by the cap.
    sup.play(A, undefined, { sourceKey: 'src' });
    vi.advanceTimersByTime(1000);
    sup.play(B, undefined, { sourceKey: 'src' });
    vi.advanceTimersByTime(1000);
    sup.play(A, undefined, { sourceKey: 'src' });
    vi.advanceTimersByTime(1000);
    expect(player.opened).toEqual([A, B, A]);
    expect(taken).toEqual([]);
    expect(journal.some((e) => e.k === 'rateWait')).toBe(false);
  });

  it('an automatic play() waits for room and counts against the cap', () => {
    let wait = 5000;
    const taken: string[] = [];
    const { player, sup } = setup({ openRate: { waitMs: () => wait, take: (k) => { taken.push(k); } } });
    sup.play(A, undefined, { sourceKey: 'src', automatic: true });
    vi.advanceTimersByTime(4000);
    expect(player.opened).toEqual([]);
    wait = 0;
    vi.advanceTimersByTime(5000);
    expect(player.opened).toEqual([A]);
    expect(taken).toEqual(['src']);
  });

  it('an automatic play() keeps the fail count and the reconnect budget', () => {
    const { player, sup } = setup({ budget: [{ windowMs: 600_000, max: 1 }] });
    sup.play(A, undefined, { sourceKey: 'src' });
    player.emit('playing');
    player.emit('error', { code: 'NETWORK' });
    vi.advanceTimersByTime(2000); // the one budgeted reconnect is spent
    expect(player.opened).toEqual([A, A]);
    sup.play(A, undefined, { sourceKey: 'src', automatic: true });
    vi.advanceTimersByTime(2000);
    player.emit('error', { code: 'NETWORK' });
    vi.advanceTimersByTime(60_000);
    // A user play() would have reset the budget and reconnected again right away.
    expect(player.opened).toEqual([A, A, A]); // no further reconnect: the budget was kept
  });

  it('a reconnect waits for room, counts against the cap, and journals the wait', () => {
    let wait = 0;
    const taken: string[] = [];
    const journal: JournalEvent[] = [];
    const { player, sup } = setup({
      openRate: { waitMs: () => wait, take: (k) => { taken.push(k); } },
      journal: { add: (e: unknown) => { journal.push(e as JournalEvent); } } as never,
    });
    sup.play(A, undefined, { sourceKey: 'src' });
    player.emit('playing');
    wait = 5000;
    player.emit('error', { code: 'NETWORK' });
    vi.advanceTimersByTime(1000); // the reconnect delay and the gap
    expect(player.opened).toEqual([A]);
    expect(journal.some((e) => e.k === 'rateWait')).toBe(true);
    vi.advanceTimersByTime(4999);
    expect(player.opened).toEqual([A]);
    wait = 0;
    vi.advanceTimersByTime(1);
    expect(player.opened).toEqual([A, A]);
    expect(taken).toEqual(['src']);
  });

  it('an alternate switch counts against the cap', () => {
    const taken: string[] = [];
    const { player, sup } = setup({ openRate: { waitMs: () => 0, take: (k) => { taken.push(k); } } });
    sup.play(A, B, { sourceKey: 'src' });
    player.emit('error', { code: 'UNSUPPORTED' }); // never played: the other format
    vi.advanceTimersByTime(1000);
    expect(player.opened).toEqual([A, B]);
    expect(taken).toEqual(['src']);
  });

  it('a newer play() or stop() drops the held reconnect', () => {
    let wait = 0;
    const { player, sup } = setup({ openRate: { waitMs: () => wait, take: () => undefined } });
    sup.play(A, undefined, { sourceKey: 'src' });
    player.emit('playing');
    wait = 1000;
    player.emit('error', { code: 'NETWORK' });
    vi.advanceTimersByTime(1500);
    sup.stop();
    wait = 0;
    vi.advanceTimersByTime(5000);
    expect(player.opened).toEqual([A]);
  });

  it('without a source key nothing is limited', () => {
    const { player, sup } = setup({ openRate: { waitMs: () => 1000, take: () => undefined } });
    sup.play(A);
    expect(player.opened).toEqual([A]);
  });
});

describe('PlaybackSupervisor: VOD mode', () => {
  const V = 'http://a.example.test/movie/1';
  /** A finite stream's health: position from the fake, plus the given fields. */
  const vodHealth = (player: FakePlayer, extra: Partial<PlaybackHealth> = {}) =>
    () => ({ positionMs: player.pos, isLive: false, ...extra });

  it('opens with live:false and the start position; live opens stay as they were', () => {
    const { player, sup } = setup();
    sup.play(V, undefined, { vod: true, startMs: 5000 });
    expect(player.openOpts[0]).toEqual({ live: false, startMs: 5000 });
    sup.play(A);
    vi.advanceTimersByTime(1000); // the gap after the last open
    expect(player.opened).toHaveLength(2);
    expect(player.openOpts[1]).toBeUndefined();
  });

  it('never reads or writes the learned live raise', () => {
    const store = { get: vi.fn((_k: string) => 2), set: vi.fn((_k: string, _v: number) => undefined) };
    const { player, sup } = setup({ liveTargets: store });
    sup.play(V, undefined, { vod: true, sourceKey: 's1' });
    player.emit('playing');
    playFor(player, 70_000);
    sup.stop();
    expect(store.get).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

  it('pause suspends the stall ladder; live pause and seek do nothing', () => {
    const { player, sup } = setup();
    player.health = vodHealth(player, { bufferAheadS: 0 });
    sup.play(V, undefined, { vod: true });
    player.emit('playing');
    playFor(player, 1000);
    sup.pause();
    expect(player.pause).toHaveBeenCalled();
    expect(sup.paused()).toBe(true);
    vi.advanceTimersByTime(30_000); // the position stands still while paused
    expect(player.opened).toHaveLength(1);

    const live = setup();
    live.player.seek = vi.fn(() => true);
    live.sup.play(A);
    live.player.emit('playing');
    live.sup.pause();
    live.sup.seek(10_000);
    expect(live.player.pause).not.toHaveBeenCalled();
    expect(live.player.seek).not.toHaveBeenCalled();
    expect(live.sup.paused()).toBe(false);
  });

  it('resume plays, starts a fresh watch, and a waiting/playing pair right after it is not a stall', () => {
    const log: JournalEvent[] = [];
    const { player, sup } = setup({ journal: { add: (e) => { log.push(e); } } });
    player.health = vodHealth(player, { bufferAheadS: 0 });
    sup.play(V, undefined, { vod: true });
    player.emit('playing');
    playFor(player, 1000);
    sup.pause();
    vi.advanceTimersByTime(60_000);
    sup.resume();
    expect(player.play).toHaveBeenCalled();
    expect(sup.paused()).toBe(false);
    player.emit('buffering');
    player.emit('playing');
    expect(log.filter((e) => e.k === 'stall')).toEqual([]);
    playFor(player, 5000);
    expect(player.opened).toHaveLength(1);
  });

  it('the last known position follows the tick; a NETWORK error reopens there', () => {
    const { player, sup } = setup();
    player.health = vodHealth(player);
    player.pos = 60_000;
    sup.play(V, undefined, { vod: true, startMs: 60_000 });
    player.emit('playing');
    playFor(player, 2000);
    expect(sup.positionMs()).toBe(62_000);
    player.emit('error', { code: 'NETWORK' });
    player.pos = 0; // the engine forgets its position while it reopens
    expect(sup.positionMs()).toBe(62_000);
    vi.advanceTimersByTime(1000);
    expect(player.opened).toHaveLength(2);
    expect(player.openOpts[1]).toEqual({ live: false, startMs: 62_000 });
  });

  it('a stall reconnect also reopens at the last position', () => {
    const { player, sup } = setup();
    player.health = vodHealth(player, { bufferAheadS: 0 });
    sup.play(V, undefined, { vod: true });
    player.emit('playing');
    playFor(player, 3000);
    vi.advanceTimersByTime(4000); // empty buffer, no progress for 4 s
    vi.advanceTimersByTime(1000);
    expect(player.opened).toHaveLength(2);
    expect(player.openOpts[1]).toEqual({ live: false, startMs: 3000 });
  });

  it('a buffered gap is never jumped, seeked to live or reopened early; the 8 s backstop reopens, with its cause journaled', () => {
    const log: JournalEvent[] = [];
    const { player, sup } = setup({ journal: { add: (e) => { log.push(e); } } });
    player.recover = vi.fn(() => true);
    player.seekToLive = vi.fn(() => true);
    player.health = vodHealth(player, { bufferAheadS: 5, rangeCount: 2, isLive: undefined });
    sup.play(V, undefined, { vod: true });
    player.emit('playing');
    playFor(player, 2000);
    vi.advanceTimersByTime(7500);
    expect(player.recover).not.toHaveBeenCalled();
    expect(player.seekToLive).not.toHaveBeenCalled();
    expect(player.opened).toHaveLength(1);
    vi.advanceTimersByTime(1500); // backstop at 8 s, reopen 1 s later
    expect(player.opened).toHaveLength(2);
    expect(player.openOpts[1]).toEqual({ live: false, startMs: 2000 });
    expect(log).toContainEqual(expect.objectContaining({ k: 'ladder', action: 'reconnect', reason: 'backstop' }));
    expect(log).toContainEqual(expect.objectContaining({ k: 'reconnect', cause: 'backstop' }));
  });

  it('after a seek or resume, a landing seek (two ranges, frozen playhead) never reopens', () => {
    for (const act of ['seek', 'resume'] as const) {
      const { player, sup } = setup();
      player.seek = vi.fn(() => true);
      player.health = vodHealth(player, { bufferAheadS: 5, rangeCount: 2 });
      sup.play(V, undefined, { vod: true });
      player.emit('playing');
      playFor(player, 1000);
      if (act === 'seek') sup.seek(30_000);
      else { sup.pause(); vi.advanceTimersByTime(5000); sup.resume(); }
      vi.advanceTimersByTime(3000);
      expect(player.opened).toHaveLength(1);
      sup.dispose();
    }
  });

  it('the seek/resume grace holds the ladder until the playhead moves, or 10 s', () => {
    const run = (act: 'seek' | 'resume') => {
      const s = setup();
      s.player.seek = vi.fn((ms: number) => { s.player.pos = ms; return true; });
      s.player.health = vodHealth(s.player, { bufferAheadS: 0 });
      s.sup.play(V, undefined, { vod: true });
      s.player.emit('playing');
      playFor(s.player, 1000);
      if (act === 'seek') s.sup.seek(30_000);
      else { s.sup.pause(); s.sup.resume(); }
      return s;
    };
    for (const act of ['seek', 'resume'] as const) {
      // Frozen with an empty buffer: without the grace the 4 s emptyBuffer rung would reopen at 5 s.
      const a = run(act);
      vi.advanceTimersByTime(9750);
      expect(a.player.opened).toHaveLength(1);
      vi.advanceTimersByTime(1500); // the grace is over: the ladder acts
      expect(a.player.opened).toHaveLength(2);
      a.sup.dispose();

      // The playhead moved: the grace ends and a later freeze is a stall again.
      const b = run(act);
      playFor(b.player, 1000);
      vi.advanceTimersByTime(5000);
      expect(b.player.opened).toHaveLength(2);
      b.sup.dispose();
    }
  });

  it('a pause survives a reopen; pause needs an engine that can pause', () => {
    const { player, sup } = setup();
    sup.play(V, undefined, { vod: true });
    player.emit('playing');
    sup.pause();
    player.emit('error', { code: 'NETWORK' });
    vi.advanceTimersByTime(1000);
    expect(player.opened).toHaveLength(2);
    expect(sup.paused()).toBe(true);
    player.emit('playing');
    expect(player.pause).toHaveBeenCalledTimes(2);
    sup.resume();
    expect(sup.paused()).toBe(false);

    const n = setup();
    Object.assign(n.player, { pause: undefined });
    n.sup.play(V, undefined, { vod: true });
    n.player.emit('playing');
    n.sup.pause();
    expect(n.sup.paused()).toBe(false);
  });

  it('VOD ignores alternate URLs', () => {
    const { player, sup } = setup();
    sup.play(V, B, { vod: true });
    for (let i = 0; i < 3; i++) { player.emit('error', { code: 'NETWORK' }); vi.advanceTimersByTime(8000); }
    expect(player.opened).toEqual([V, V, V, V]);
  });

  it('catch-up (vodAlternate): after the reopens fail before a frame, the alternate is tried once', () => {
    const { player, sup, statuses } = setup();
    sup.play(V, B, { vod: true, vodAlternate: true });
    for (let i = 0; i < 4; i++) { player.emit('error', { code: 'NETWORK' }); vi.advanceTimersByTime(8000); }
    expect(player.opened).toEqual([V, V, V, V, B]);
    for (let i = 0; i < 4; i++) { player.emit('error', { code: 'NETWORK' }); vi.advanceTimersByTime(8000); }
    expect(player.opened).toEqual([V, V, V, V, B, B, B, B]);
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unavailable' });
  });

  it('catch-up (vodAlternate): a frame played keeps the primary', () => {
    const { player, sup } = setup();
    sup.play(V, B, { vod: true, vodAlternate: true });
    player.emit('playing');
    for (let i = 0; i < 4; i++) { player.emit('error', { code: 'NETWORK' }); vi.advanceTimersByTime(8000); }
    expect(player.opened.every((u) => u === V)).toBe(true);
  });

  it('byte silence is not a stall in VOD (lazy loading parks downloads far ahead)', () => {
    const health = (player: FakePlayer) => () => ({ positionMs: player.pos, bufferAheadS: 0.3, tracksBytes: true, lastByteAt: 0 });
    const live = setup();
    live.player.health = health(live.player);
    live.sup.play(A);
    live.player.emit('playing');
    vi.advanceTimersByTime(3000);
    expect(live.player.opened).toHaveLength(2); // live: no bytes for 2.5 s reconnects
    live.sup.dispose();

    const { player, sup } = setup();
    player.health = health(player);
    sup.play(V, undefined, { vod: true });
    player.emit('playing');
    vi.advanceTimersByTime(7000);
    expect(player.opened).toHaveLength(1); // only the 8 s backstop applies
    vi.advanceTimersByTime(2000);
    expect(player.opened).toHaveLength(2);
  });

  it('after 3 reopens the 4th failure ends as unavailable, with no background retries', () => {
    const { player, sup, statuses } = setup();
    sup.play(V, undefined, { vod: true });
    player.emit('playing');
    for (let i = 0; i < 3; i++) {
      player.emit('error', { code: i === 1 ? 'MEDIA' : 'NETWORK' });
      vi.advanceTimersByTime(8000);
      player.emit('playing');
    }
    expect(player.opened).toHaveLength(4);
    player.emit('error', { code: 'NETWORK' });
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unavailable' });
    vi.advanceTimersByTime(300_000);
    expect(player.opened).toHaveLength(4);
  });

  it('UNSUPPORTED and DECODE fail as unsupported at once, without reopening', () => {
    for (const code of ['UNSUPPORTED', 'DECODE'] as const) {
      const { player, sup, statuses } = setup();
      sup.play(V, B, { vod: true });
      player.emit('playing');
      player.emit('error', { code });
      expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unsupported' });
      vi.advanceTimersByTime(60_000);
      expect(player.opened).toEqual([V]);
      sup.dispose();
    }
  });

  it("the stream reaching its end reports 'ended'; live never does", () => {
    const { player, sup, statuses } = setup();
    sup.play(V, undefined, { vod: true });
    player.emit('playing');
    player.emit('idle');
    expect(statuses.at(-1)).toEqual({ kind: 'ended' });
    vi.advanceTimersByTime(30_000);
    expect(player.opened).toHaveLength(1);

    const live = setup();
    live.sup.play(A);
    live.player.emit('playing');
    live.player.emit('idle');
    expect(live.statuses.map((s) => s.kind)).not.toContain('ended');
  });

  it('seek calls the engine and marks a self action; an impossible seek reopens at the target', () => {
    const log: JournalEvent[] = [];
    const { player, sup } = setup({ journal: { add: (e) => { log.push(e); } } });
    player.health = vodHealth(player, { bufferAheadS: 0 });
    player.seek = vi.fn(() => true);
    sup.play(V, undefined, { vod: true });
    player.emit('playing');
    playFor(player, 1000);
    sup.seek(30_000);
    expect(player.seek).toHaveBeenCalledWith(30_000);
    player.emit('buffering');
    player.emit('playing');
    expect(log.filter((e) => e.k === 'stall')).toEqual([]);
    expect(player.opened).toHaveLength(1);

    player.seek = vi.fn(() => false);
    sup.seek(90_000);
    vi.advanceTimersByTime(1000);
    expect(player.opened).toHaveLength(2);
    expect(player.openOpts[1]).toEqual({ live: false, startMs: 90_000 });
  });

  it('positionMs, durationMs and onSubtitle come from the engine', () => {
    const { player, sup } = setup();
    expect(sup.onSubtitle(() => undefined)).toBeTypeOf('function'); // no engine support: a no-op unsubscribe
    player.duration = () => 5_400_000;
    const off = vi.fn();
    let cue: ((t: string | null) => void) | undefined;
    player.onSubtitle = vi.fn((fn: (t: string | null) => void) => { cue = fn; return off; });
    const seen: Array<string | null> = [];
    const unsub = sup.onSubtitle((t) => seen.push(t));
    cue?.('Hello');
    cue?.(null);
    expect(seen).toEqual(['Hello', null]);
    unsub();
    expect(off).toHaveBeenCalled();
    sup.play(V, undefined, { vod: true, startMs: 1234 });
    expect(sup.durationMs()).toBe(5_400_000);
    expect(sup.positionMs()).toBe(1234);
    player.emit('playing');
    player.pos = 2000;
    expect(sup.positionMs()).toBe(2000);
  });

  it('the 3-reopen cap resets after stable playback, like the live failure count', () => {
    const { player, sup, statuses } = setup();
    player.health = vodHealth(player, { bufferAheadS: 10 });
    sup.play(V, undefined, { vod: true });
    player.emit('playing');
    for (let i = 0; i < 4; i++) {
      playFor(player, 31_000); // stable for longer than stableMs
      player.emit('error', { code: 'NETWORK' });
      vi.advanceTimersByTime(8000);
      player.emit('playing');
    }
    expect(player.opened).toHaveLength(5);
    expect(statuses.map((s) => s.kind)).not.toContain('failed');
  });

  it('pause before the first frame only records it; the first frame then pauses (no start timeout burns a reopen)', () => {
    const { player, sup } = setup();
    sup.play(V, undefined, { vod: true });
    sup.pause();
    expect(sup.paused()).toBe(true);
    expect(player.pause).not.toHaveBeenCalled();
    player.emit('playing');
    expect(player.pause).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000);
    expect(player.opened).toHaveLength(1);
  });

  it('startedAttempts counts attempts that reached their first frame', () => {
    const { player, sup } = setup();
    expect(sup.startedAttempts()).toBe(0);
    sup.play(V, undefined, { vod: true });
    expect(sup.startedAttempts()).toBe(0);
    player.emit('playing');
    player.emit('playing');
    expect(sup.startedAttempts()).toBe(1);
    player.emit('error', { code: 'NETWORK' });
    vi.advanceTimersByTime(1000);
    player.emit('playing');
    expect(sup.startedAttempts()).toBe(2);
  });

  it('stop clears the paused flag', () => {
    const { player, sup } = setup();
    sup.play(V, undefined, { vod: true });
    player.emit('playing');
    sup.pause();
    expect(sup.paused()).toBe(true);
    sup.stop();
    expect(sup.paused()).toBe(false);
  });

  it('seek clamps to [0, duration - 1 s] when the duration is known', () => {
    const { player, sup } = setup();
    player.duration = () => 100_000;
    player.seek = vi.fn((ms: number) => { player.pos = ms; return true; });
    sup.play(V, undefined, { vod: true });
    player.emit('playing');
    sup.seek(500_000);
    expect(player.seek).toHaveBeenLastCalledWith(99_000);
    expect(sup.positionMs()).toBe(99_000);
    sup.seek(-5);
    expect(player.seek).toHaveBeenLastCalledWith(0);
    player.duration = () => undefined;
    sup.seek(500_000);
    expect(player.seek).toHaveBeenLastCalledWith(500_000);
  });
});

describe('PlaybackSupervisor: status probe', () => {
  type ProbeResult = { status?: number; retryAfterMs?: number };
  function probed(result: ProbeResult, opts: SupervisorOptions = {}) {
    const calls: Array<{ url: string; signal: AbortSignal }> = [];
    const probe = vi.fn((url: string, signal: AbortSignal) => { calls.push({ url, signal }); return Promise.resolve(result); });
    return { ...setup({ probe, ...opts }), probe, calls };
  }
  /** Runs the 0 ms deferral of a failure from an engine event, then lets resolved promises run. */
  async function settle() { vi.advanceTimersByTime(0); await flush(); }

  it('a native NETWORK failure before the first frame probes once, outside the engine callback; a refusal ends at once as refused', async () => {
    const { player, sup, statuses, calls } = probed({ status: 403, retryAfterMs: 90_000 });
    sup.play(A);
    player.emit('error', { code: 'NETWORK' });
    expect(player.calls).toEqual(['stop', `open:${A}`]); // nothing torn down inside the engine's callback
    await settle();
    expect(player.calls).toEqual(['stop', `open:${A}`, 'stop']); // the attempt is stopped before the probe
    expect(calls.map((c) => c.url)).toEqual([A]);
    vi.advanceTimersByTime(60_000);
    expect(player.opened).toEqual([A]); // a confirmed refusal is not tried again
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'refused', httpStatus: 403, retryAfterMs: 90_000, urlIndex: 0 });
  });

  it('a confirmed refusal tries the other format once (after the gap), then ends as refused', async () => {
    const { player, sup, statuses, calls } = probed({ status: 403, retryAfterMs: 90_000 });
    sup.play(A, B);
    player.emit('error', { code: 'NETWORK' });
    await settle();
    vi.advanceTimersByTime(999);
    expect(player.opened).toEqual([A]); // the probe counts as an open: the gap runs from it
    vi.advanceTimersByTime(1);
    expect(player.opened).toEqual([A, B]);
    player.emit('error', { code: 'NETWORK' });
    await settle();
    vi.advanceTimersByTime(60_000);
    expect(calls).toHaveLength(1);
    expect(player.opened).toEqual([A, B]);
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'refused', httpStatus: 403, retryAfterMs: 90_000, urlIndex: 0 });
  });

  it('a play with custom headers never probes (the browser cannot send them): it keeps the NETWORK path', async () => {
    for (const headers of [{ userAgent: 'SyntheticAgent/1.0' }, { referrer: 'http://ref.test/' }]) {
      const { player, sup, statuses, probe } = probed({ status: 403 });
      sup.play(A, undefined, { headers });
      player.emit('error', { code: 'NETWORK' });
      await settle();
      expect(probe).not.toHaveBeenCalled();
      expect(statuses.some((st) => st.kind === 'failed')).toBe(false);
      vi.advanceTimersByTime(2000);
      expect(player.opened).toEqual([A, A]); // the normal NETWORK reconnect
      sup.dispose();
    }
    // Empty header values are no custom headers: the probe runs.
    const plain = probed({ status: 403 });
    plain.sup.play(A, undefined, { headers: { userAgent: '' } });
    plain.player.emit('error', { code: 'NETWORK' });
    await settle();
    expect(plain.probe).toHaveBeenCalledTimes(1);
  });

  it('a refusal confirmed by the probe on the alternate names the alternate (urlIndex 1)', async () => {
    const { player, sup, statuses, calls } = probed({ status: 403 });
    sup.play(A, B);
    player.emit('error', { code: 'AUTH' });
    vi.advanceTimersByTime(1000);
    player.emit('error', { code: 'AUTH' });
    vi.advanceTimersByTime(1000);
    expect(player.opened).toEqual([A, A, B]);
    player.emit('error', { code: 'NETWORK' });
    await settle();
    expect(calls.map((c) => c.url)).toEqual([B]);
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'refused', httpStatus: 403, urlIndex: 1 });
  });

  it('404 or 410 ends as gone: no retry, no alternate', async () => {
    for (const status of [404, 410]) {
      const { player, sup, statuses } = probed({ status });
      sup.play(A, B);
      player.emit('error', { code: 'NETWORK' });
      await settle();
      vi.advanceTimersByTime(10 * 60_000);
      expect(player.opened).toEqual([A]);
      expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'gone', httpStatus: status });
      sup.dispose();
    }
  });

  it('any other answer keeps the normal NETWORK path, and a play() probes at most once', async () => {
    const { player, sup, statuses, calls } = probed({ status: 500 });
    sup.play(A, B);
    player.emit('error', { code: 'NETWORK' });
    await settle();
    vi.advanceTimersByTime(999);
    expect(player.opened).toEqual([A]);
    vi.advanceTimersByTime(1);
    expect(player.opened).toEqual([A, A]);
    player.emit('error', { code: 'NETWORK' });
    await settle();
    vi.advanceTimersByTime(1000);
    expect(player.opened).toEqual([A, A, B]); // two tries, then the other format, as before
    expect(calls).toHaveLength(1);
    player.emit('error', { code: 'NETWORK' });
    vi.advanceTimersByTime(1000);
    player.emit('error', { code: 'NETWORK' });
    vi.advanceTimersByTime(1000);
    // Unavailable carries no status (the probe's 500 belonged to an earlier attempt).
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unavailable' });
  });

  it('an unknown answer (a rejected probe) is NETWORK as well', async () => {
    const probe = vi.fn((_u: string, _s: AbortSignal) => Promise.reject(new Error('cors')));
    const { player, sup } = setup({ probe });
    sup.play(A);
    player.emit('error', { code: 'NETWORK' });
    await settle();
    vi.advanceTimersByTime(1000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(player.opened).toEqual([A, A]);
  });

  it('a later play() probes again', async () => {
    const { player, sup, calls } = probed({});
    sup.play(A);
    player.emit('error', { code: 'NETWORK' });
    await settle();
    sup.play(B);
    vi.advanceTimersByTime(1000); // the gap after the probe
    player.emit('error', { code: 'NETWORK' });
    await settle();
    expect(calls.map((c) => c.url)).toEqual([A, B]);
  });

  it('does not probe an engine that maps statuses itself, after a first frame, or for other codes', async () => {
    const aware = probed({ status: 403 });
    (aware.player as FakePlayer & { supportsStatus?: () => boolean }).supportsStatus = () => true;
    aware.sup.play(A);
    aware.player.emit('error', { code: 'NETWORK' });
    await settle();
    expect(aware.probe).not.toHaveBeenCalled();
    aware.sup.dispose();

    const played = probed({ status: 403 });
    played.sup.play(A);
    played.player.emit('playing');
    played.player.emit('error', { code: 'NETWORK' });
    await settle();
    expect(played.probe).not.toHaveBeenCalled();
    played.sup.dispose();

    const media = probed({ status: 403 });
    media.sup.play(A);
    media.player.emit('error', { code: 'MEDIA' });
    await settle();
    expect(media.probe).not.toHaveBeenCalled();
  });

  it('a start timeout (no first frame) probes at once, from the supervisor\'s own timer', async () => {
    const { player, sup, probe, statuses } = probed({ status: 404 });
    sup.play(A);
    vi.advanceTimersByTime(15_000);
    expect(probe).toHaveBeenCalledTimes(1);
    await flush();
    expect(player.opened).toEqual([A]);
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'gone', httpStatus: 404 });
  });

  it('catch-up (vodAlternate): a primary that is gone (404) switches to the alternate at once; the alternate is probed too', async () => {
    const { player, sup, statuses, calls } = probed({ status: 404 });
    const t0 = Date.now();
    sup.play(A, B, { vod: true, vodAlternate: true });
    player.emit('error', { code: 'NETWORK' });
    await settle();
    vi.advanceTimersByTime(1000);
    expect(player.opened).toEqual([A, B]);
    // The alternate is another URL: its own probe answers 404 too, so the play ends as gone in seconds.
    player.emit('error', { code: 'NETWORK' });
    await settle();
    expect(calls.map((c) => c.url)).toEqual([A, B]);
    expect(player.opened).toEqual([A, B]);
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'gone', httpStatus: 404 });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('catch-up: an engine that reports 404/410 itself ends as gone within a few seconds, primary then alternate', () => {
    for (const status of [404, 410]) {
      const { player, sup, statuses } = setup();
      (player as FakePlayer & { supportsStatus?: () => boolean }).supportsStatus = () => true;
      const t0 = Date.now();
      sup.play(A, B, { vod: true, vodAlternate: true });
      player.emit('error', { code: 'NETWORK', httpStatus: status });
      vi.advanceTimersByTime(1000); // the minimum gap since the last open
      expect(player.opened).toEqual([A, B]);
      player.emit('error', { code: 'NETWORK', httpStatus: status });
      vi.advanceTimersByTime(0);
      expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'gone', httpStatus: status });
      expect(Date.now() - t0).toBeLessThan(3000);
      vi.advanceTimersByTime(60_000);
      expect(player.opened).toEqual([A, B]); // nothing more is opened
      sup.dispose();
    }
  });

  it('a live channel keeps the NETWORK path on an engine 404 (the other format may still play); after a frame VOD does too', () => {
    const live = setup();
    (live.player as FakePlayer & { supportsStatus?: () => boolean }).supportsStatus = () => true;
    live.sup.play(A, B);
    live.player.emit('error', { code: 'NETWORK', httpStatus: 404 });
    vi.advanceTimersByTime(1000);
    expect(live.player.opened).toEqual([A, A]);
    expect(live.statuses.some((st) => st.kind === 'failed')).toBe(false);
    live.sup.dispose();

    const vod = setup();
    (vod.player as FakePlayer & { supportsStatus?: () => boolean }).supportsStatus = () => true;
    vod.sup.play(A, B, { vod: true, vodAlternate: true });
    vod.player.emit('playing');
    vod.player.emit('error', { code: 'NETWORK', httpStatus: 404 });
    vi.advanceTimersByTime(1000);
    expect(vod.player.opened).toEqual([A, A]); // a reopen at the position, not gone
    expect(vod.statuses.some((st) => st.kind === 'failed')).toBe(false);
  });

  it('never probes while the source is blocked', async () => {
    const blocked = vi.fn((_k?: string) => true);
    const { player, sup, probe } = probed({ status: 403 }, { blocked });
    sup.play(A, undefined, { sourceKey: 'src' });
    player.emit('error', { code: 'NETWORK' });
    await settle();
    expect(probe).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledWith('src', A);
    vi.advanceTimersByTime(1000);
    expect(player.opened).toEqual([A, A]); // the normal path
  });

  it('counts against the open-rate cap, and is skipped when the source has no room', async () => {
    const taken: string[] = [];
    let wait = 0;
    const openRate = { waitMs: () => wait, take: (k: string) => { taken.push(k); } };
    const roomy = probed({}, { openRate });
    roomy.sup.play(A, undefined, { sourceKey: 'src' });
    roomy.player.emit('error', { code: 'NETWORK' });
    await settle();
    expect(roomy.probe).toHaveBeenCalledTimes(1);
    expect(taken).toEqual(['src']); // the probe only: the user's open does not count
    roomy.sup.dispose();

    const full = probed({}, { openRate });
    full.sup.play(A, undefined, { sourceKey: 'src' });
    wait = 5000;
    full.player.emit('error', { code: 'NETWORK' });
    await settle();
    expect(full.probe).not.toHaveBeenCalled();
  });

  it('waits for the failed attempt to close (at most 1.5 s) before probing', async () => {
    const { player, sup, probe } = probed({});
    sup.play(A);
    let close!: () => void;
    (player as FakePlayer & { closed?: () => Promise<void> }).closed = () => new Promise<void>((r) => { close = r; });
    player.emit('error', { code: 'NETWORK' });
    await settle();
    expect(probe).not.toHaveBeenCalled();
    close();
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);

    const hung = probed({});
    hung.sup.play(A);
    (hung.player as FakePlayer & { closed?: () => Promise<void> }).closed = () => new Promise<void>(() => undefined);
    hung.player.emit('error', { code: 'NETWORK' });
    vi.advanceTimersByTime(1499);
    expect(hung.probe).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hung.probe).toHaveBeenCalledTimes(1);
  });

  it('stop() during the probe aborts it and drops its answer', async () => {
    let answer!: (r: ProbeResult) => void;
    const signals: AbortSignal[] = [];
    const probe = vi.fn((_u: string, signal: AbortSignal) => { signals.push(signal); return new Promise<ProbeResult>((r) => { answer = r; }); });
    const { player, sup, statuses } = setup({ probe });
    sup.play(A);
    player.emit('error', { code: 'NETWORK' });
    await settle();
    sup.stop();
    expect(signals[0]!.aborted).toBe(true);
    answer({ status: 404 });
    await flush();
    vi.advanceTimersByTime(60_000);
    expect(player.opened).toEqual([A]);
    expect(statuses.some((s) => s.kind === 'failed')).toBe(false);
  });

  it('a stale probe answering during a newer play\'s probe never disarms the newer one\'s 5 s cap', async () => {
    const answers: Array<(r: ProbeResult) => void> = [];
    const probe = vi.fn((_u: string, _s: AbortSignal) => new Promise<ProbeResult>((r) => { answers.push(r); }));
    const { player, sup } = setup({ probe });
    sup.play(A);
    player.emit('error', { code: 'NETWORK' });
    await settle(); // probe 1 (A) in flight
    sup.play(B);
    vi.advanceTimersByTime(1000);
    player.emit('error', { code: 'NETWORK' });
    await settle(); // probe 2 (B) in flight, never answers
    answers[0]!({ status: 404 }); // the old probe answers late
    await flush();
    vi.advanceTimersByTime(5000); // the new probe's cap still fires: unknown, the normal path
    vi.advanceTimersByTime(1000);
    expect(player.opened).toEqual([A, B, B]);
  });

  it('gives up waiting on the probe after 5 s and treats it as unknown', async () => {
    const probe = vi.fn((_u: string, _s: AbortSignal) => new Promise<{ status?: number }>(() => undefined));
    const { player, sup } = setup({ probe });
    sup.play(A);
    player.emit('error', { code: 'NETWORK' });
    await settle();
    vi.advanceTimersByTime(4999);
    expect(player.opened).toEqual([A]);
    vi.advanceTimersByTime(1);
    expect(probe.mock.calls[0]![1].aborted).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(player.opened).toEqual([A, A]);
  });

  it('a probe refusal during the background retries stops them as refused', async () => {
    const { player, sup, statuses } = probed({ status: 403 }, { budget: [{ max: 6, windowMs: 20_000 }] });
    sup.play(A);
    player.emit('playing');
    for (let i = 0; i < 7; i++) { player.emit('error', { code: 'EOS' }); vi.advanceTimersByTime(1000); }
    const n = player.opened.length;
    vi.advanceTimersByTime(30_000);
    expect(player.opened).toHaveLength(n + 1);
    player.emit('error', { code: 'NETWORK' });
    await settle();
    vi.advanceTimersByTime(10 * 60_000);
    expect(player.opened).toHaveLength(n + 1);
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'refused', httpStatus: 403, urlIndex: 0 });
  });

  it('an engine-reported status rides on the failure', () => {
    const { player, sup, statuses } = setup();
    sup.play(A);
    player.emit('playing');
    player.emit('error', { code: 'AUTH', httpStatus: 401 });
    vi.advanceTimersByTime(1000);
    player.emit('error', { code: 'AUTH', httpStatus: 403 });
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'refused', httpStatus: 403, urlIndex: 0 });
  });
});

describe('PlaybackSupervisor: spaced give-up retries', () => {
  /** Room again after 20 s, so every background step has budget unless a test says otherwise. */
  const roomy = { budget: [{ max: 6, windowMs: 20_000 }] };
  /** Plays, then drops until the reconnect budget runs out: the background retries begin. */
  function exhaust(s: ReturnType<typeof setup>) {
    s.sup.play(A);
    s.player.emit('playing');
    for (let i = 0; i < 7; i++) { s.player.emit('error', { code: 'EOS' }); vi.advanceTimersByTime(1000); }
    expect(s.statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unavailable' });
    return s.player.opened.length;
  }

  it('retries after 30 s, 60 s and 120 s, then stops', () => {
    const s = setup(roomy);
    const n = exhaust(s);
    const opensAt = (ms: number) => {
      vi.advanceTimersByTime(ms - 1);
      const before = s.player.opened.length;
      vi.advanceTimersByTime(1);
      return [before, s.player.opened.length];
    };
    expect(opensAt(29_000)).toEqual([n, n + 1]); // the loop already spent 1 s of the first wait
    s.player.emit('error', { code: 'NETWORK' });
    expect(opensAt(60_000)).toEqual([n + 1, n + 2]);
    s.player.emit('error', { code: 'NETWORK' });
    expect(opensAt(120_000)).toEqual([n + 2, n + 3]);
    s.player.emit('error', { code: 'NETWORK' });
    vi.advanceTimersByTime(60 * 60_000);
    expect(s.player.opened).toHaveLength(n + 3);
  });

  it('isGivingUp() is true while the background retries are scheduled, false once they end or stop()', () => {
    const s = setup(roomy);
    expect(s.sup.isGivingUp()).toBe(false);
    exhaust(s);
    expect(s.sup.isGivingUp()).toBe(true);
    vi.advanceTimersByTime(29_000); // the first retry opens and is still pending: still giving up
    expect(s.sup.isGivingUp()).toBe(true);
    s.player.emit('playing');
    expect(s.sup.isGivingUp()).toBe(false);
    const stopped = setup(roomy);
    exhaust(stopped);
    stopped.sup.stop();
    expect(stopped.sup.isGivingUp()).toBe(false);
    // A channel that never played stops for good: no background retries.
    const never = setup();
    never.sup.play(A);
    for (let i = 0; i < 4; i++) { never.player.emit('error', { code: 'NETWORK' }); vi.advanceTimersByTime(10_000); }
    expect(never.statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unavailable' });
    expect(never.sup.isGivingUp()).toBe(false);
  });

  it('the waits get ±20 % jitter', () => {
    const s = setup({ ...roomy, random: () => 1 });
    const n = exhaust(s);
    vi.advanceTimersByTime(36_000 - 1000 - 1);
    expect(s.player.opened).toHaveLength(n);
    vi.advanceTimersByTime(1);
    expect(s.player.opened).toHaveLength(n + 1);
    s.player.emit('error', { code: 'NETWORK' });
    vi.advanceTimersByTime(72_000 - 1);
    expect(s.player.opened).toHaveLength(n + 1);
    vi.advanceTimersByTime(1);
    expect(s.player.opened).toHaveLength(n + 2);
  });

  it('a step with no room in the reconnect budget is skipped', () => {
    const s = setup(); // 6 a minute: the 30 s step still finds the budget spent
    const n = exhaust(s);
    vi.advanceTimersByTime(29_000);
    expect(s.player.opened).toHaveLength(n);
    vi.advanceTimersByTime(60_000);
    expect(s.player.opened).toHaveLength(n + 1);
  });

  it('keeps the reconnect budget: a retry that plays and drops at once gets no fresh reconnects', () => {
    const s = setup({ budget: [{ max: 6, windowMs: 20_000 }, { max: 7, windowMs: 600_000 }] });
    const n = exhaust(s);
    vi.advanceTimersByTime(29_000);
    expect(s.player.opened).toHaveLength(n + 1); // the 7th take of ten minutes
    s.player.emit('playing');
    expect(s.statuses.at(-1)).toEqual({ kind: 'playing' });
    s.player.emit('error', { code: 'EOS' });
    vi.advanceTimersByTime(5000);
    expect(s.player.opened).toHaveLength(n + 1); // the budget is still spent: no reconnect
    expect(s.statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unavailable' });
  });

  it('defaults', () => {
    expect(DEFAULT_POLICY.giveUpRetryDelaysMs).toEqual([30_000, 60_000, 120_000]);
    expect(DEFAULT_POLICY.minOpenGapMs).toBe(1000);
    expect(DEFAULT_POLICY.openGapSpreadMs).toBe(300);
    expect(DEFAULT_POLICY.openRateWakeJitterMs).toBe(500);
  });
});

describe('PlaybackSupervisor: gap jitter, close before open, open-rate wake', () => {
  type Closable = FakePlayer & { closed?: () => Promise<void> };

  it('the gap between opens is 1000–1300 ms, drawn per open', () => {
    for (const [r, gap] of [[0, 1000], [0.5, 1150], [1, 1300]] as const) {
      const { player, sup } = setup({ random: () => r, policy: { openGapSpreadMs: 300 } });
      sup.play(A);
      player.emit('playing');
      player.emit('error', { code: 'EOS' }); // reconnect at once, but not before the gap
      vi.advanceTimersByTime(gap - 1);
      expect(player.opened).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(player.opened).toHaveLength(2);
      sup.dispose();
    }
  });

  it('a user play() keeps the gap after the last open too', () => {
    const { player, sup } = setup();
    sup.play(A);
    vi.advanceTimersByTime(400);
    sup.play(B);
    vi.advanceTimersByTime(599);
    expect(player.opened).toEqual([A]);
    vi.advanceTimersByTime(1);
    expect(player.opened).toEqual([A, B]);
  });

  it('an open waits for the previous attempt to close', async () => {
    const { player, sup } = setup();
    let close!: () => void;
    (player as Closable).closed = () => new Promise<void>((r) => { close = r; });
    sup.play(A);
    expect(player.opened).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(player.opened).toEqual([]);
    close();
    await flush();
    expect(player.opened).toEqual([A]);
  });

  it('a hung teardown delays the open by at most 1.5 s, after the gap', () => {
    const { player, sup } = setup();
    (player as Closable).closed = () => new Promise<void>(() => undefined);
    sup.play(A);
    vi.advanceTimersByTime(1499);
    expect(player.opened).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(player.opened).toEqual([A]);
    player.emit('playing');
    player.emit('error', { code: 'EOS' }); // the gap (1 s), then the teardown wait (1.5 s)
    vi.advanceTimersByTime(1000 + 1499);
    expect(player.opened).toEqual([A]);
    vi.advanceTimersByTime(1);
    expect(player.opened).toEqual([A, A]);
  });

  it('a new play() while waiting for the close drops the old open', async () => {
    const { player, sup } = setup();
    const closers: Array<() => void> = [];
    (player as Closable).closed = () => new Promise<void>((r) => { closers.push(r); });
    sup.play(A);
    sup.play(B);
    closers.forEach((c) => c());
    await flush();
    expect(player.opened).toEqual([B]);
  });

  it('an older play\'s close resolving late never cancels the newer play\'s 1.5 s cap', async () => {
    const { player, sup } = setup();
    const closers: Array<() => void> = [];
    let hang = false;
    (player as Closable).closed = () => new Promise<void>((r) => { if (!hang) closers.push(r); });
    sup.play(A);
    hang = true; // the next teardown never reports
    sup.play(B);
    closers[0]!(); // the first play's close resolves late
    await flush();
    expect(player.opened).toEqual([]);
    vi.advanceTimersByTime(1500); // B's own cap still fires
    expect(player.opened).toEqual([B]);
  });

  it('stop() during the close wait never opens', async () => {
    const { player, sup } = setup();
    let close!: () => void;
    (player as Closable).closed = () => new Promise<void>((r) => { close = r; });
    sup.play(A);
    sup.stop();
    close();
    await flush();
    vi.advanceTimersByTime(10_000);
    expect(player.opened).toEqual([]);
  });

  it('an open held by the open-rate cap wakes 0–500 ms after the slot frees', () => {
    for (const [r, extra] of [[0, 0], [1, 500]] as const) {
      let wait = 0;
      const { player, sup } = setup({
        random: () => r, policy: { openRateWakeJitterMs: 500, openGapSpreadMs: 0, jitter: 0 },
        openRate: { waitMs: () => wait, take: () => undefined },
      });
      sup.play(A, undefined, { sourceKey: 'src' });
      player.emit('playing');
      player.emit('error', { code: 'NETWORK' });
      wait = 5000;
      vi.advanceTimersByTime(1000); // the reconnect delay: now held by the cap
      expect(player.opened).toEqual([A]);
      wait = 0;
      vi.advanceTimersByTime(5000 + extra - 1);
      expect(player.opened).toEqual([A]);
      vi.advanceTimersByTime(1);
      expect(player.opened).toEqual([A, A]);
      sup.dispose();
    }
  });

  it('passes the stream headers to every open, live and VOD', () => {
    const headers = { userAgent: 'TestAgent/1.0', referrer: 'http://ref.example.test/' };
    const { player, sup } = setup();
    sup.play(A, undefined, { headers });
    expect(player.openOpts[0]).toEqual({ headers });
    sup.play(A, undefined, { vod: true, startMs: 5000, headers });
    vi.advanceTimersByTime(1000);
    expect(player.openOpts[1]).toEqual({ live: false, startMs: 5000, headers });
  });
});
