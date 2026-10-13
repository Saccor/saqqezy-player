import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PlaybackSupervisor,
  type AspectMode, type Player, type PlayerState, type Rect, type StreamInfo, type SupervisorStatus, type TrackInfo,
} from '../src/index.ts';

type Listener = (s: PlayerState, d?: { code?: string; message?: string }) => void;

class FakePlayer implements Player {
  opened: string[] = [];
  calls: string[] = [];
  pos = 0;
  private listeners = new Set<Listener>();
  async open(url: string): Promise<void> { this.opened.push(url); this.calls.push(`open:${url}`); }
  stop(): void { this.calls.push('stop'); }
  setRect(_r: Rect | 'fullscreen'): void {}
  setAspect(_m: AspectMode): void {}
  audioTracks(): TrackInfo[] { return []; }
  selectAudioTrack(_id: string): void {}
  streamInfo(): StreamInfo { return {}; }
  position(): number { return this.pos; }
  onState(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  destroy(): void { this.listeners.clear(); }
  emit(s: PlayerState, d?: { code?: string; message?: string }): void { for (const l of [...this.listeners]) l(s, d); }
}

function setup(opts = {}) {
  const player = new FakePlayer();
  const sup = new PlaybackSupervisor(player, opts);
  const statuses: SupervisorStatus[] = [];
  sup.onStatus((s) => statuses.push(s));
  return { player, sup, statuses };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('PlaybackSupervisor', () => {
  it('plays successfully: stops first, opens, emits loading then playing', () => {
    const { player, sup, statuses } = setup();
    sup.play('http://a.example.test/1');
    expect(player.calls).toEqual(['stop', 'open:http://a.example.test/1']);
    player.emit('playing');
    expect(statuses).toEqual([{ kind: 'loading' }, { kind: 'playing' }]);
  });

  it('error -> 3 reconnects with 1s/2s/4s -> failed unavailable', () => {
    const { player, sup, statuses } = setup();
    sup.play('http://a.example.test/1');
    player.emit('error', { code: 'NETWORK' });
    expect(statuses.at(-1)).toEqual({ kind: 'reconnecting', attempt: 1 });
    vi.advanceTimersByTime(999);
    expect(player.opened).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(player.opened).toHaveLength(2);
    player.emit('error');
    expect(statuses.at(-1)).toEqual({ kind: 'reconnecting', attempt: 2 });
    vi.advanceTimersByTime(1999);
    expect(player.opened).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(player.opened).toHaveLength(3);
    player.emit('error');
    expect(statuses.at(-1)).toEqual({ kind: 'reconnecting', attempt: 3 });
    vi.advanceTimersByTime(3999);
    expect(player.opened).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(player.opened).toHaveLength(4);
    player.emit('error');
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unavailable' });
    vi.advanceTimersByTime(60000);
    expect(player.opened).toHaveLength(4);
  });

  it('error -> retries exhausted -> alternate URL -> playing', () => {
    const { player, sup, statuses } = setup();
    sup.play('http://a.example.test/live/1.ts', 'http://a.example.test/live/1.m3u8');
    for (const delay of [1000, 2000, 4000]) {
      player.emit('error');
      vi.advanceTimersByTime(delay);
    }
    player.emit('error');
    expect(player.opened.at(-1)).toBe('http://a.example.test/live/1.m3u8');
    expect(player.opened).toHaveLength(5);
    expect(statuses.at(-1)).toEqual({ kind: 'loading' });
    player.emit('playing');
    expect(statuses.at(-1)).toEqual({ kind: 'playing' });
    expect(statuses.some((s) => s.kind === 'failed')).toBe(false);
  });

  it('alternate gets a fresh retry budget, then failed', () => {
    const { player, sup, statuses } = setup();
    sup.play('http://a.example.test/1', 'http://a.example.test/2');
    for (const delay of [1000, 2000, 4000]) { player.emit('error'); vi.advanceTimersByTime(delay); }
    player.emit('error'); // switch to alternate
    for (const delay of [1000, 2000, 4000]) {
      player.emit('error');
      expect(statuses.at(-1)?.kind).toBe('reconnecting');
      vi.advanceTimersByTime(delay);
    }
    player.emit('error');
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unavailable' });
    expect(player.opened.filter((u) => u.endsWith('/2'))).toHaveLength(4);
  });

  it('start timeout counts as a failure', () => {
    const { player, sup, statuses } = setup();
    sup.play('http://a.example.test/1');
    vi.advanceTimersByTime(9999);
    expect(statuses).toEqual([{ kind: 'loading' }]);
    vi.advanceTimersByTime(1);
    expect(statuses.at(-1)).toEqual({ kind: 'reconnecting', attempt: 1 });
    vi.advanceTimersByTime(1000);
    expect(player.opened).toHaveLength(2);
  });

  it('stall watchdog triggers a reconnect when position does not advance for stallMs', () => {
    const { player, sup, statuses } = setup();
    sup.play('http://a.example.test/1');
    player.emit('playing');
    player.pos = 1000;
    vi.advanceTimersByTime(1000); // sees advance
    expect(statuses.at(-1)).toEqual({ kind: 'playing' });
    vi.advanceTimersByTime(7000);
    expect(statuses.at(-1)).toEqual({ kind: 'playing' });
    vi.advanceTimersByTime(1000);
    expect(statuses.at(-1)).toEqual({ kind: 'reconnecting', attempt: 1 });
    vi.advanceTimersByTime(1000);
    expect(player.opened).toHaveLength(2);
  });

  it('advancing position never triggers the watchdog', () => {
    const { player, sup, statuses } = setup();
    sup.play('http://a.example.test/1');
    player.emit('playing');
    for (let i = 0; i < 30; i++) { player.pos += 1000; vi.advanceTimersByTime(1000); }
    expect(statuses).toEqual([{ kind: 'loading' }, { kind: 'playing' }]);
  });

  it('a new play ignores events and timers from the old URL', () => {
    const { player, sup, statuses } = setup();
    sup.play('http://a.example.test/1');
    sup.play('http://a.example.test/2');
    expect(player.calls).toEqual(['stop', 'open:http://a.example.test/1', 'stop', 'open:http://a.example.test/2']);
    vi.advanceTimersByTime(5000);
    sup.play('http://a.example.test/3');
    statuses.length = 0;
    vi.advanceTimersByTime(9999); // neither older start timeout may fire
    expect(statuses).toEqual([]);
    player.emit('playing');
    expect(statuses).toEqual([{ kind: 'playing' }]);
  });

  it('stop cancels pending timers and ignores later events', () => {
    const { player, sup, statuses } = setup();
    sup.play('http://a.example.test/1');
    player.emit('error');
    sup.stop();
    statuses.length = 0;
    vi.advanceTimersByTime(60000);
    player.emit('error');
    expect(player.opened).toHaveLength(1);
    expect(statuses).toEqual([]);
  });

  it('UNSUPPORTED fails immediately with no retries', () => {
    const { player, sup, statuses } = setup();
    sup.play('http://a.example.test/1');
    player.emit('error', { code: 'UNSUPPORTED' });
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unsupported' });
    vi.advanceTimersByTime(60000);
    expect(player.opened).toHaveLength(1);
  });

  it('dispose stops reacting', () => {
    const { player, sup, statuses } = setup();
    sup.play('http://a.example.test/1');
    sup.dispose();
    statuses.length = 0;
    player.emit('playing');
    vi.advanceTimersByTime(60000);
    expect(statuses).toEqual([]);
  });
});
