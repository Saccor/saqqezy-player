import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PlaybackSupervisor,
  type AspectMode, type LiveProfile, type PlaybackHealth, type Player, type PlayerState, type Rect, type StateDetail,
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

  it('the first reconnect is immediate and holds the last frame; later ones back off 0.5 s, 1 s, 2 s', () => {
    const { player, sup } = setup();
    sup.play(A);
    player.emit('error', { code: 'NETWORK' });
    expect(player.holdLastFrame).toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(player.opened).toHaveLength(2);
    player.emit('error', { code: 'NETWORK' });
    vi.advanceTimersByTime(499);
    expect(player.opened).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(player.opened).toHaveLength(3);
    player.emit('error', { code: 'NETWORK' });
    vi.advanceTimersByTime(999);
    expect(player.opened).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(player.opened).toHaveLength(4);
  });

  it('applies jitter from the injected random source', () => {
    const { player, sup } = setup({ random: () => 1 }); // +20 %
    sup.play(A);
    player.emit('error'); vi.advanceTimersByTime(0);
    player.emit('error');
    vi.advanceTimersByTime(599);
    expect(player.opened).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(player.opened).toHaveLength(3);
  });

  it('shows "reconnecting" only after 1 s without playing; a quick recovery shows nothing', () => {
    const { player, sup, statuses } = setup();
    sup.play(A);
    player.emit('playing');
    player.emit('error');
    vi.advanceTimersByTime(0);
    player.emit('playing');
    vi.advanceTimersByTime(2000);
    expect(statuses.map((s) => s.kind)).toEqual(['loading', 'playing']);
    player.emit('error'); // second failure in a row: retried after 500 ms, still not playing at 1 s
    vi.advanceTimersByTime(999);
    expect(statuses.at(-1)).toEqual({ kind: 'playing' });
    vi.advanceTimersByTime(1);
    expect(statuses.at(-1)).toEqual({ kind: 'reconnecting', attempt: 2 });
  });

  it('switches to the alternate after two failures; a string or an array is accepted', () => {
    for (const alt of [B, [B]] as const) {
      const { player, sup, statuses } = setup();
      sup.play(A, alt);
      player.emit('error'); vi.advanceTimersByTime(0);
      player.emit('error');
      vi.advanceTimersByTime(0); // the switch runs one macrotask after the player's event
      expect(player.opened.at(-1)).toBe(B);
      expect(statuses.at(-1)).toEqual({ kind: 'loading' });
      sup.dispose();
    }
  });

  it('UNSUPPORTED goes to the alternate at once, then fails as unsupported', () => {
    const { player, sup, statuses } = setup();
    sup.play(A, B);
    player.emit('error', { code: 'UNSUPPORTED' });
    vi.advanceTimersByTime(0);
    expect(player.opened).toEqual([A, B]);
    player.emit('error', { code: 'UNSUPPORTED' });
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unsupported' });
  });

  it('keeps the code of a synchronous UNSUPPORTED throw from open()', () => {
    const { player, sup } = setup();
    player.throwOnOpen = { code: 'UNSUPPORTED' };
    sup.play(A, B);
    vi.advanceTimersByTime(0);
    expect(player.opened).toEqual([A, B]);
  });

  it('AUTH reopens the same URL once, then the alternate, then fails as refused', () => {
    const { player, sup, statuses } = setup();
    sup.play(A, B);
    player.emit('error', { code: 'AUTH' });
    vi.advanceTimersByTime(0);
    expect(player.opened).toEqual([A, A]);
    player.emit('error', { code: 'AUTH' });
    vi.advanceTimersByTime(0);
    expect(player.opened).toEqual([A, A, B]);
    player.emit('error', { code: 'AUTH' });
    vi.advanceTimersByTime(0);
    player.emit('error', { code: 'AUTH' });
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'refused' });
  });

  it('EOS reconnects at once and never counts toward the alternate switch', () => {
    const { player, sup } = setup();
    sup.play(A, B);
    for (let i = 0; i < 3; i++) { player.emit('error', { code: 'EOS' }); vi.advanceTimersByTime(0); }
    expect(player.opened).toEqual([A, A, A, A]);
  });

  it('a no-bytes start fails after 4 s when the engine tracks bytes; flowing bytes wait for the 15 s first-frame limit', () => {
    const { player, sup } = setup();
    player.health = () => ({ positionMs: 0, tracksBytes: true });
    sup.play(A);
    vi.advanceTimersByTime(3999);
    expect(player.opened).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(player.opened).toHaveLength(2);

    const second = setup();
    second.player.health = () => ({ positionMs: 0, tracksBytes: true, lastByteAt: Date.now() });
    second.sup.play(A);
    vi.advanceTimersByTime(14_999);
    expect(second.player.opened).toHaveLength(1);
    vi.advanceTimersByTime(1);
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
    vi.advanceTimersByTime(250);
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
    vi.advanceTimersByTime(250);
    expect(player.opened).toHaveLength(2);
  });

  it('30 s of stable play restores the immediate first retry', () => {
    const { player, sup } = setup();
    sup.play(A);
    player.emit('playing');
    player.emit('error'); vi.advanceTimersByTime(0); // failure 1
    player.emit('playing');
    playFor(player, 30_000);
    player.emit('error');
    vi.advanceTimersByTime(0);
    expect(player.opened).toHaveLength(3); // delay 0 again, not 500 ms
  });

  it('runs out of budget after 6 reconnects in a minute, then retries every 15 s and recovers', () => {
    const { player, sup, statuses } = setup();
    sup.play(A);
    for (let i = 0; i < 6; i++) { player.emit('error', { code: 'EOS' }); vi.advanceTimersByTime(0); }
    expect(player.opened).toHaveLength(7);
    player.emit('error', { code: 'EOS' });
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unavailable' });
    vi.advanceTimersByTime(14_999);
    expect(player.opened).toHaveLength(7);
    vi.advanceTimersByTime(1);
    expect(player.opened).toHaveLength(8);
    player.emit('playing');
    expect(statuses.at(-1)).toEqual({ kind: 'playing' });
  });

  it('give-up retries stop after 5 minutes and on stop()', () => {
    const { player, sup } = setup();
    sup.play(A);
    for (let i = 0; i < 7; i++) { player.emit('error', { code: 'EOS' }); vi.advanceTimersByTime(0); }
    for (let i = 0; i < 25; i++) { vi.advanceTimersByTime(15_000); player.emit('error'); }
    const n = player.opened.length;
    vi.advanceTimersByTime(60_000);
    expect(player.opened).toHaveLength(n);

    const other = setup();
    other.sup.play(A);
    for (let i = 0; i < 7; i++) { other.player.emit('error', { code: 'EOS' }); vi.advanceTimersByTime(0); }
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
    vi.advanceTimersByTime(0);
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
    vi.advanceTimersByTime(0);
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
    vi.advanceTimersByTime(0);
    expect(player.opened).toEqual([A, B]);
    expect(statuses.at(-1)).toEqual({ kind: 'loading' });

    const s = setup();
    s.sup.play(A, B);
    s.player.emit('error', { code: 'UNSUPPORTED' });
    s.sup.stop();
    vi.advanceTimersByTime(0);
    expect(s.player.opened).toEqual([A]);
  });
});
