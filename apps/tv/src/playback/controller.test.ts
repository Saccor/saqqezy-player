import { describe, expect, it, vi } from 'vitest';
import type { Rect, SupervisorStatus } from '@iptv/player';
import { createPlaybackController } from './controller.ts';

function fakes() {
  let statusFn: ((s: SupervisorStatus) => void) | undefined;
  const supervisor = {
    play: vi.fn((_url: string, _alt?: string, _opts?: { sourceKey?: string }) => undefined),
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
  it('reports the active player kind (HTML5 by default, AVPlay when told)', () => {
    const f = fakes();
    expect(createPlaybackController(f.player, f.supervisor).playerKind()).toBe('HTML5');
    expect(createPlaybackController(f.player, f.supervisor, undefined, 'AVPlay').playerKind()).toBe('AVPlay');
  });

  it('plays through the supervisor with the url and alternate url', () => {
    const f = fakes();
    const pb = createPlaybackController(f.player, f.supervisor);
    expect(pb.playChannel(ch('1'))).toBe(true);
    expect(f.supervisor.play).toHaveBeenCalledWith('http://example.test/live/u/p/1.ts', 'http://example.test/live/u/p/1.m3u8', { sourceKey: undefined });
    expect(pb.current()?.id).toBe('1');
  });

  it('passes the active source id as the live-delay key', () => {
    const f = fakes();
    const pb = createPlaybackController(f.player, f.supervisor, undefined, 'HTML5', () => 'src-1');
    pb.playChannel(ch('1'));
    expect(f.supervisor.play).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), { sourceKey: 'src-1' });
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

  it('a fresh answer for the playing channel updates its info (e.g. a rename) without reopening', () => {
    const f = fakes();
    const pb = createPlaybackController(f.player, f.supervisor);
    pb.playChannel(ch('1'));
    f.emit({ kind: 'playing' });
    const renamed = { ...ch('1'), name: 'Renamed', url: 'http://example.test/live/u/p/1.m3u8', alternateUrl: undefined };
    expect(pb.playChannel(renamed)).toBe(false);
    expect(pb.current()?.name).toBe('Renamed');
    // The stream keeps running, so the urls stay those of the open stream.
    expect(pb.current()?.url).toBe('http://example.test/live/u/p/1.ts');
    expect(pb.current()?.alternateUrl).toBe('http://example.test/live/u/p/1.m3u8');
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

  it('request tokens: only the latest begin() is current; stop() supersedes every pending request', () => {
    const f = fakes();
    const pb = createPlaybackController(f.player, f.supervisor);
    const a = pb.begin();
    expect(pb.isLatest(a)).toBe(true);
    const b = pb.begin();
    expect(pb.isLatest(a)).toBe(false);
    expect(pb.isLatest(b)).toBe(true);
    // playChannel itself does not supersede the request that led to it.
    pb.playChannel(ch('1'));
    expect(pb.isLatest(b)).toBe(true);
    pb.stop();
    expect(pb.isLatest(b)).toBe(false);
  });

  it('a slow answer for an older request does not replace the newer channel', async () => {
    const f = fakes();
    const pb = createPlaybackController(f.player, f.supervisor);
    let releaseA!: (c: ReturnType<typeof ch>) => void;
    const slowA = new Promise<ReturnType<typeof ch>>((r) => { releaseA = r; });
    const request = async (load: Promise<ReturnType<typeof ch>>) => {
      const t = pb.begin();
      const c = await load;
      if (pb.isLatest(t)) pb.playChannel(c);
    };
    const pa = request(slowA);
    await request(Promise.resolve(ch('2')));
    releaseA(ch('1'));
    await pa;
    expect(pb.current()?.id).toBe('2');
    expect(f.supervisor.play).toHaveBeenCalledTimes(1);
  });

  it('tracks whether the video rect is fullscreen (false until a screen asks for it)', () => {
    const f = fakes();
    const pb = createPlaybackController(f.player, f.supervisor);
    expect(pb.rectIsFullscreen()).toBe(false);
    pb.setRect('fullscreen');
    expect(pb.rectIsFullscreen()).toBe(true);
    expect(f.player.setRect).toHaveBeenLastCalledWith('fullscreen');
    pb.setRect({ x: 96, y: 54, w: 480, h: 270 });
    expect(pb.rectIsFullscreen()).toBe(false);
    // A rect covering the whole design space is fullscreen too.
    pb.setRect({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(pb.rectIsFullscreen()).toBe(true);
  });
});
