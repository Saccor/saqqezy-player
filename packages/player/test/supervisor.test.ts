import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PlaybackSupervisor,
  type AspectMode, type ErrorCode, type Player, type PlayerState, type Rect, type StreamInfo, type SupervisorStatus, type TrackInfo,
} from '../src/index.ts';

type Detail = { code?: ErrorCode; message?: string; attemptId?: number };
type Listener = (s: PlayerState, d?: Detail) => void;

class FakePlayer implements Player {
  opened: string[] = [];
  ids: Array<number | undefined> = [];
  calls: string[] = [];
  pos = 0;
  rejectNext: Error | undefined;
  private listeners = new Set<Listener>();
  async open(url: string, attemptId?: number): Promise<void> {
    this.opened.push(url); this.ids.push(attemptId); this.calls.push(`open:${url}`);
    if (this.rejectNext) { const e = this.rejectNext; this.rejectNext = undefined; throw e; }
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
  /** Emits a state event attributed to open() number `attemptIdx` (default: the latest one). */
  emit(s: PlayerState, d?: { code?: ErrorCode; message?: string }, attemptIdx = this.ids.length - 1): void {
    const attemptId = this.ids[attemptIdx];
    for (const l of [...this.listeners]) l(s, attemptId === undefined ? d : { ...d, attemptId });
  }
}

function setup(opts = {}) {
  const player = new FakePlayer();
  const sup = new PlaybackSupervisor(player, opts);
  const statuses: SupervisorStatus[] = [];
  sup.onStatus((s) => statuses.push(s));
  return { player, sup, statuses };
}

/** Plays for `seconds` of advancing position (one poll per second). */
function playFor(player: FakePlayer, seconds: number) {
  for (let t = 0; t < seconds; t++) { player.pos += 1000; vi.advanceTimersByTime(1000); }
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

  it('UNSUPPORTED on the primary opens the alternate at once and reaches playing', () => {
    const { player, sup, statuses } = setup();
    sup.play('http://a.example.test/live/1.ts', 'http://a.example.test/live/1.m3u8');
    player.emit('error', { code: 'UNSUPPORTED' });
    expect(player.opened).toEqual(['http://a.example.test/live/1.ts', 'http://a.example.test/live/1.m3u8']);
    expect(statuses.at(-1)).toEqual({ kind: 'loading' });
    expect(statuses.some((s) => s.kind === 'reconnecting' || s.kind === 'failed')).toBe(false);
    player.emit('playing');
    expect(statuses.at(-1)).toEqual({ kind: 'playing' });
  });

  it('UNSUPPORTED on both primary and alternate fails as unsupported', () => {
    const { player, sup, statuses } = setup();
    sup.play('http://a.example.test/live/1.ts', 'http://a.example.test/live/1.m3u8');
    player.emit('error', { code: 'UNSUPPORTED' });
    player.emit('error', { code: 'UNSUPPORTED' });
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unsupported' });
    vi.advanceTimersByTime(60000);
    expect(player.opened).toHaveLength(2);
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

  describe('per-attempt tokens', () => {
    it('passes a fresh attempt id to every open()', () => {
      const { player, sup } = setup();
      sup.play('http://a.example.test/1');
      player.emit('error');
      vi.advanceTimersByTime(1000);
      sup.play('http://a.example.test/2');
      expect(new Set(player.ids).size).toBe(3);
      expect(player.ids.every((i) => typeof i === 'number')).toBe(true);
    });

    it('an error event followed by a rejection of the same open() is one failure', async () => {
      const { player, sup, statuses } = setup();
      player.rejectNext = Object.assign(new Error('x'), { code: 'NETWORK' });
      sup.play('http://a.example.test/1');
      player.emit('error');
      await Promise.resolve(); await Promise.resolve();
      expect(statuses.filter((s) => s.kind === 'reconnecting')).toEqual([{ kind: 'reconnecting', attempt: 1 }]);
    });

    it('a rejection landing after the alternate was switched in does not count against it', async () => {
      const { player, sup, statuses } = setup();
      let rejectFirst!: (e: unknown) => void;
      const open = player.open.bind(player);
      let n = 0;
      player.open = (url: string, id?: number) => {
        void open(url, id);
        return n++ === 0 ? new Promise<void>((_, rej) => { rejectFirst = rej; }) : Promise.resolve();
      };
      sup.play('http://a.example.test/1', 'http://a.example.test/2');
      for (const delay of [1000, 2000, 4000]) { player.emit('error'); vi.advanceTimersByTime(delay); }
      player.emit('error'); // switch to alternate
      expect(player.opened.at(-1)).toBe('http://a.example.test/2');
      const before = statuses.length;
      rejectFirst(Object.assign(new Error('late'), { code: 'NETWORK' }));
      await Promise.resolve(); await Promise.resolve();
      expect(statuses.length).toBe(before);
      expect(statuses.at(-1)).toEqual({ kind: 'loading' });
    });

    it('a late error attributed to an older attempt does not reconnect the new stream', () => {
      const { player, sup, statuses } = setup();
      sup.play('http://a.example.test/A');
      sup.play('http://a.example.test/B');
      statuses.length = 0;
      player.emit('error', { code: 'NETWORK' }, 0); // attributed to A's attempt
      vi.advanceTimersByTime(5000);
      expect(statuses).toEqual([]);
      expect(player.opened).toHaveLength(2);
      player.emit('playing', undefined, 0);
      expect(statuses).toEqual([]);
      player.emit('playing');
      expect(statuses).toEqual([{ kind: 'playing' }]);
    });

    it('events while a retry is pending (no attempt in flight) are ignored, even playing', () => {
      const { player, sup, statuses } = setup();
      sup.play('http://a.example.test/1');
      player.emit('error');
      player.emit('playing');
      expect(statuses.at(-1)).toEqual({ kind: 'reconnecting', attempt: 1 });
      vi.advanceTimersByTime(1000);
      expect(player.opened).toHaveLength(2);
    });

    it('a late playing after the start timeout is intentionally ignored', () => {
      const { player, sup, statuses } = setup();
      sup.play('http://a.example.test/1');
      vi.advanceTimersByTime(10000);
      player.emit('playing', undefined, 0);
      expect(statuses.at(-1)).toEqual({ kind: 'reconnecting', attempt: 1 });
    });
  });

  describe('retry budget', () => {
    it('a flapping stream (plays 2 s, then errors) ends in failed without an alternate', () => {
      const { player, sup, statuses } = setup();
      sup.play('http://a.example.test/1');
      for (let i = 0; i < 10 && statuses.at(-1)?.kind !== 'failed'; i++) {
        player.emit('playing');
        vi.advanceTimersByTime(2000);
        player.emit('error');
        vi.advanceTimersByTime(4000);
      }
      expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unavailable' });
      expect(player.opened.length).toBeLessThanOrEqual(4);
    });

    it('a flapping stream reaches the alternate', () => {
      const { player, sup } = setup();
      sup.play('http://a.example.test/1', 'http://a.example.test/2');
      for (let i = 0; i < 6; i++) {
        player.emit('playing');
        vi.advanceTimersByTime(2000);
        player.emit('error');
        vi.advanceTimersByTime(4000);
      }
      expect(player.opened).toContain('http://a.example.test/2');
    });

    it('30 s of stable play restores the retry budget; total reconnects are capped at 10', () => {
      const { player, sup, statuses } = setup();
      sup.play('http://a.example.test/1');
      for (let i = 0; i < 20 && statuses.at(-1)?.kind !== 'failed'; i++) {
        player.emit('playing');
        playFor(player, 31);
        player.emit('error');
        vi.advanceTimersByTime(4000);
      }
      expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'unavailable' });
      expect(statuses.filter((s) => s.kind === 'reconnecting')).toHaveLength(10);
    });

    it('after the cap the alternate is tried if it has not been', () => {
      const { player, sup, statuses } = setup();
      sup.play('http://a.example.test/1', 'http://a.example.test/2');
      for (let i = 0; i < 11; i++) {
        player.emit('playing');
        playFor(player, 31);
        player.emit('error');
        vi.advanceTimersByTime(4000);
      }
      expect(player.opened.at(-1)).toBe('http://a.example.test/2');
      expect(statuses.at(-1)).toEqual({ kind: 'loading' });
    });

    it('the alternate gets a fresh reconnect budget after the primary hits the cap', () => {
      const { player, sup, statuses } = setup();
      sup.play('http://a.example.test/1', 'http://a.example.test/2');
      for (let i = 0; i < 11; i++) {
        player.emit('playing');
        playFor(player, 31);
        player.emit('error');
        vi.advanceTimersByTime(4000);
      }
      expect(player.opened.at(-1)).toBe('http://a.example.test/2');
      const before = statuses.length;
      for (const delay of [1000, 2000, 4000]) {
        player.emit('error');
        vi.advanceTimersByTime(delay);
      }
      player.emit('error');
      expect(statuses.slice(before)).toEqual([
        { kind: 'reconnecting', attempt: 1 },
        { kind: 'reconnecting', attempt: 2 },
        { kind: 'reconnecting', attempt: 3 },
        { kind: 'failed', reason: 'unavailable' },
      ]);
    });
  });

  describe('stall watchdog', () => {
    it('repeated buffering events do not reset the watchdog: flat position for 9 s triggers', () => {
      const { player, sup, statuses } = setup();
      sup.play('http://a.example.test/1');
      player.emit('playing');
      for (let t = 0; t < 9; t++) {
        player.emit('buffering');
        vi.advanceTimersByTime(1000);
      }
      expect(statuses.at(-1)).toEqual({ kind: 'reconnecting', attempt: 1 });
    });

    it('buffering for 5 s then playing does not trigger', () => {
      const { player, sup, statuses } = setup();
      sup.play('http://a.example.test/1');
      player.emit('playing');
      player.pos = 1000;
      vi.advanceTimersByTime(4000);
      player.emit('buffering');
      vi.advanceTimersByTime(5000);
      player.emit('playing');
      vi.advanceTimersByTime(5000);
      expect(statuses.some((s) => s.kind === 'reconnecting')).toBe(false);
    });

    it('over 8 s of flat position triggers (timestamp based)', () => {
      const { player, sup, statuses } = setup();
      sup.play('http://a.example.test/1');
      player.emit('playing');
      vi.advanceTimersByTime(7000);
      expect(statuses.some((s) => s.kind === 'reconnecting')).toBe(false);
      vi.advanceTimersByTime(1000);
      expect(statuses.at(-1)).toEqual({ kind: 'reconnecting', attempt: 1 });
    });

    it('uses the injected clock now()', () => {
      let t = 0;
      const base = { setTimeout, clearTimeout, setInterval, clearInterval };
      const { player, sup, statuses } = setup({ clock: { ...base, now: () => t } });
      sup.play('http://a.example.test/1');
      player.emit('playing');
      t = 9000; // time jumped though only one tick elapsed
      vi.advanceTimersByTime(1000);
      expect(statuses.at(-1)).toEqual({ kind: 'reconnecting', attempt: 1 });
    });
  });
});
