import { describe, expect, it, vi } from 'vitest';
import type { Rect, SupervisorStatus } from '@iptv/player';
import { createPlaybackController } from './controller.ts';

function fakes() {
  let statusFn: ((s: SupervisorStatus) => void) | undefined;
  const supervisor = {
    play: vi.fn((_url: string, _alt?: string) => undefined),
    stop: vi.fn(),
    onStatus: vi.fn((fn: (s: SupervisorStatus) => void) => { statusFn = fn; return () => { statusFn = undefined; }; }),
  };
  const player = { setRect: vi.fn((_r: Rect | 'fullscreen') => undefined) };
  return { supervisor, player, emit: (s: SupervisorStatus) => statusFn?.(s) };
}

const ch = (id: string) => ({
  id, number: 1, name: 'Channel', group: 'g', favourite: false,
  url: `http://example.test/live/u/p/${id}.ts`, alternateUrl: `http://example.test/live/u/p/${id}.m3u8`,
});

describe('playback controller', () => {
  it('plays through the supervisor with the url and alternate url', () => {
    const f = fakes();
    const pb = createPlaybackController(f.player, f.supervisor);
    expect(pb.playChannel(ch('1'))).toBe(true);
    expect(f.supervisor.play).toHaveBeenCalledWith('http://example.test/live/u/p/1.ts', 'http://example.test/live/u/p/1.m3u8');
    expect(pb.current()?.id).toBe('1');
  });

  it('does not restart the channel that is already playing; a rect change never reopens', () => {
    const f = fakes();
    const pb = createPlaybackController(f.player, f.supervisor);
    pb.playChannel(ch('1'));
    f.emit({ kind: 'playing' });
    expect(pb.playChannel(ch('1'))).toBe(false);
    pb.setRect('fullscreen');
    expect(f.player.setRect).toHaveBeenCalledWith('fullscreen');
    expect(f.supervisor.play).toHaveBeenCalledTimes(1);
  });

  it('retries a failed channel and switches channels', () => {
    const f = fakes();
    const pb = createPlaybackController(f.player, f.supervisor);
    pb.playChannel(ch('1'));
    f.emit({ kind: 'failed', reason: 'unavailable' });
    expect(pb.status()).toEqual({ kind: 'failed', reason: 'unavailable' });
    expect(pb.playChannel(ch('1'))).toBe(true);
    expect(pb.playChannel(ch('2'))).toBe(true);
    expect(f.supervisor.play).toHaveBeenCalledTimes(3);
  });

  it('stop clears current and status and reports status changes', () => {
    const f = fakes();
    const seen: (SupervisorStatus | undefined)[] = [];
    const pb = createPlaybackController(f.player, f.supervisor, (s) => seen.push(s));
    pb.playChannel(ch('1'));
    f.emit({ kind: 'loading' });
    pb.stop();
    expect(f.supervisor.stop).toHaveBeenCalled();
    expect(pb.current()).toBeUndefined();
    expect(pb.status()).toBeUndefined();
    expect(seen).toEqual([{ kind: 'loading' }, undefined]);
  });
});
