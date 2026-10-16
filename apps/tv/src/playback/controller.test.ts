import { describe, expect, it, vi } from 'vitest';
import type { Rect, SupervisorStatus } from '@iptv/player';
import type { VodPlayable } from '@iptv/app-api';
import { createPlaybackController, type CooldownStream, type PlaybackController } from './controller.ts';

function fakes() {
  let statusFn: ((s: SupervisorStatus) => void) | undefined;
  const supervisor = {
    play: vi.fn((_url: string, _alt?: string, _opts?: { sourceKey?: string; channel?: string }) => undefined),
    stop: vi.fn(),
    onStatus: vi.fn((fn: (s: SupervisorStatus) => void) => { statusFn = fn; return () => { statusFn = undefined; }; }),
    pause: vi.fn(),
    resume: vi.fn(),
    seek: vi.fn((_ms: number) => undefined),
    positionMs: vi.fn((): number | undefined => 42_000),
    durationMs: vi.fn((): number | undefined => 600_000),
    paused: vi.fn(() => true),
    onSubtitle: vi.fn((_fn: (t: string | null) => void) => () => undefined),
    startedAttempts: vi.fn(() => 3),
  };
  const player = {
    setRect: vi.fn((_r: Rect | 'fullscreen') => undefined),
    audioTracks: vi.fn(() => [{ id: 'a1', label: 'One', active: true }]),
    selectAudioTrack: vi.fn((_id: string) => undefined),
    textTracks: vi.fn(() => [{ id: 't1', label: 'Sub', active: false }]),
    selectTextTrack: vi.fn((_id: string | null) => undefined),
  };
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
    expect(f.supervisor.play).toHaveBeenCalledWith('http://example.test/live/u/p/1.ts', 'http://example.test/live/u/p/1.m3u8', { sourceKey: undefined, channel: 'Channel' });
    expect(pb.current()?.id).toBe('1');
  });

  it("passes the stream's headers to the supervisor, live and VOD; none when the playable has none", () => {
    const f = fakes();
    const pb = createPlaybackController(f.player, f.supervisor, undefined, 'HTML5', () => 'src-1');
    const headers = { userAgent: 'SyntheticAgent/1.0' };
    pb.playChannel({ ...ch('1'), headers });
    expect(f.supervisor.play).toHaveBeenLastCalledWith(ch('1').url, ch('1').alternateUrl, { sourceKey: 'src-1', channel: 'Channel', headers });
    const vod: VodPlayable = { kind: 'movie', itemId: 'm1', url: 'http://example.test/movie/u/p/1.mp4', title: 'T', resumeMs: 0, tracks: {}, headers: { referrer: 'http://ref.test/' } };
    pb.playVod(vod, 5000);
    expect(f.supervisor.play).toHaveBeenLastCalledWith(vod.url, undefined, { sourceKey: 'src-1', vod: true, startMs: 5000, headers: { referrer: 'http://ref.test/' } });
    pb.playChannel(ch('2'));
    expect(f.supervisor.play).toHaveBeenLastCalledWith(ch('2').url, ch('2').alternateUrl, { sourceKey: 'src-1', channel: 'Channel' });
  });

  it('passes the active source id as the live-delay key', () => {
    const f = fakes();
    const pb = createPlaybackController(f.player, f.supervisor, undefined, 'HTML5', () => 'src-1');
    pb.playChannel(ch('1'));
    expect(f.supervisor.play).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), { sourceKey: 'src-1', channel: 'Channel' });
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

  describe('refusal cooldown', () => {
    const guarded = (blocked: { on: boolean }) => {
      const f = fakes();
      const calls: string[] = [];
      const pb = createPlaybackController(f.player, f.supervisor, undefined, 'HTML5', () => 'src-1', {
        blocked: () => blocked.on,
        refused: (k, url) => calls.push(`refused:${k}:${url}`),
        answered: (k, url) => calls.push(`answered:${k}:${url}`),
      });
      return { f, pb, calls };
    };

    /**
     * A gate whose `current` runs App's cooldown effect synchronously, as Solid does when the stream key signal
     * changes: hold when the shown cooldown turns blocked, resumeHeld when it turns clear.
     */
    const appLike = (blockedKeys: ReadonlySet<string>) => {
      const f = fakes();
      let shown: 'clear' | 'waiting' | undefined;
      const isBlocked = (s: CooldownStream) => s.cooldownKey !== undefined && blockedKeys.has(s.cooldownKey);
      const ref: { pb?: PlaybackController } = {};
      const pb = createPlaybackController(f.player, f.supervisor, undefined, 'HTML5', () => 'src-1', {
        blocked: isBlocked,
        refused: () => undefined,
        answered: () => undefined,
        current: (s) => {
          const prev = shown;
          shown = s && isBlocked(s) ? 'waiting' : 'clear';
          if (shown !== 'clear') ref.pb?.holdForCooldown();
          else if (prev !== undefined && prev !== 'clear') ref.pb?.resumeHeld();
        },
      });
      ref.pb = pb;
      return { f, pb };
    };
    const movie = (id: string, cooldownKey: string): VodPlayable =>
      ({ kind: 'movie', itemId: id, url: `http://example.test/movie/u/p/${id}.mp4`, title: 'T', resumeMs: 0, tracks: {}, cooldownKey });

    it('switching from a blocked host to a clear one opens exactly once (live)', () => {
      const { f, pb } = appLike(new Set(['src-1@a.test']));
      expect(pb.playChannel({ ...ch('1'), cooldownKey: 'src-1@a.test' })).toBe(false);
      expect(pb.playChannel({ ...ch('2'), cooldownKey: 'src-1@b.test' })).toBe(true);
      expect(f.supervisor.play).toHaveBeenCalledTimes(1);
      expect(f.supervisor.play.mock.calls[0]![0]).toBe('http://example.test/live/u/p/2.ts');
      expect(pb.current()?.id).toBe('2');
    });

    it('switching from a blocked host to a clear one opens exactly once (VOD, and live to VOD)', () => {
      const vod = appLike(new Set(['src-1@a.test']));
      vod.pb.playVod(movie('m1', 'src-1@a.test'), 0);
      vod.pb.playVod(movie('m2', 'src-1@b.test'), 5_000);
      expect(vod.f.supervisor.play).toHaveBeenCalledTimes(1);
      expect(vod.f.supervisor.play.mock.calls[0]![0]).toBe('http://example.test/movie/u/p/m2.mp4');

      const mixed = appLike(new Set(['src-1@a.test']));
      mixed.pb.playChannel({ ...ch('1'), cooldownKey: 'src-1@a.test' });
      mixed.pb.playVod(movie('m2', 'src-1@b.test'), 0);
      expect(mixed.f.supervisor.play).toHaveBeenCalledTimes(1);
      expect(mixed.f.supervisor.play.mock.calls[0]![2]).toMatchObject({ vod: true });
    });

    it('switching from a clear host to a blocked one holds without opening', () => {
      const { f, pb } = appLike(new Set(['src-1@a.test']));
      pb.playChannel({ ...ch('2'), cooldownKey: 'src-1@b.test' });
      expect(pb.playChannel({ ...ch('1'), cooldownKey: 'src-1@a.test' })).toBe(false);
      expect(f.supervisor.play).toHaveBeenCalledTimes(1);
      expect(f.supervisor.stop).toHaveBeenCalled();
      expect(pb.current()?.id).toBe('1');
    });

    it("asks the gate about the stream's own host, and tells it which stream is current", () => {
      const f = fakes();
      const asked: Array<string | undefined> = [];
      const current: Array<string | undefined> = [];
      const pb = createPlaybackController(f.player, f.supervisor, undefined, 'HTML5', () => 'src-1', {
        blocked: (s) => { asked.push(s.cooldownKey); return s.cooldownKey === 'src-1@a.test'; },
        refused: () => undefined,
        answered: () => undefined,
        current: (s) => current.push(s?.cooldownKey),
      });
      const seed = { state: 'waiting', until: 9, reason: 'refused' } as const;
      expect(pb.playChannel({ ...ch('1'), cooldownKey: 'src-1@a.test', cooldown: seed })).toBe(false);
      expect(pb.playChannel({ ...ch('2'), cooldownKey: 'src-1@b.test' })).toBe(true);
      pb.playVod({ kind: 'movie', itemId: 'm1', url: 'http://a.test/m.mp4', title: 'T', resumeMs: 0, tracks: {}, cooldownKey: 'src-1@a.test' }, 0);
      pb.stop();
      expect(asked).toEqual(['src-1@a.test', 'src-1@b.test', 'src-1@a.test']);
      expect(current).toEqual(['src-1@a.test', 'src-1@b.test', 'src-1@a.test', undefined]);
      expect(f.supervisor.play).toHaveBeenCalledTimes(1);
    });

    it('opens nothing while the source is blocked, and plays the held channel once it is not', () => {
      const blocked = { on: true };
      const { f, pb } = guarded(blocked);
      expect(pb.playChannel(ch('1'))).toBe(false);
      expect(f.supervisor.play).not.toHaveBeenCalled();
      expect(pb.current()?.id).toBe('1');
      blocked.on = false;
      expect(pb.playChannel(ch('1'))).toBe(true); // same channel, but it never opened
      expect(f.supervisor.play).toHaveBeenCalledTimes(1);
    });

    it('reports the first frame once per play, and a refusal at any time', () => {
      const { f, pb, calls } = guarded({ on: false });
      pb.playChannel(ch('1'));
      f.emit({ kind: 'playing' });
      f.emit({ kind: 'playing' });
      f.emit({ kind: 'failed', reason: 'refused' }); // refused on a reconnect, after it played
      pb.playChannel(ch('2'));
      f.emit({ kind: 'failed', reason: 'refused' });
      f.emit({ kind: 'failed', reason: 'unavailable' });
      const url = (id: string) => `http://example.test/live/u/p/${id}.ts`;
      expect(calls).toEqual([`answered:src-1:${url('1')}`, `refused:src-1:${url('1')}`, `refused:src-1:${url('2')}`]);
    });

    it("a refusal passes the probe's Retry-After to the gate", () => {
      const f = fakes();
      const seen: Array<[string, string, number | undefined]> = [];
      const pb = createPlaybackController(f.player, f.supervisor, undefined, 'HTML5', () => 'src-1', {
        blocked: () => false,
        refused: (k, url, retryAfterMs) => { seen.push([k, url, retryAfterMs]); },
        answered: () => undefined,
      });
      pb.playChannel(ch('1'));
      f.emit({ kind: 'failed', reason: 'refused', httpStatus: 429, retryAfterMs: 90_000 });
      pb.playChannel(ch('2'));
      f.emit({ kind: 'failed', reason: 'refused', httpStatus: 403 });
      expect(seen).toEqual([['src-1', ch('1').url, 90_000], ['src-1', ch('2').url, undefined]]);
    });

    it('a stream that failed unavailable or gone reports nothing (streams never count toward the unreachable breaker)', () => {
      const { f, pb, calls } = guarded({ on: false });
      pb.playChannel(ch('1'));
      f.emit({ kind: 'failed', reason: 'unavailable' });
      pb.playChannel(ch('2'));
      f.emit({ kind: 'failed', reason: 'gone', httpStatus: 404 });
      expect(calls).toEqual([]);
    });

    it('resumeHeld opens the held channel once, and nothing when none is held', () => {
      const blocked = { on: true };
      const { f, pb } = guarded(blocked);
      pb.resumeHeld();
      pb.playChannel(ch('1'));
      blocked.on = false;
      pb.resumeHeld();
      pb.resumeHeld();
      expect(f.supervisor.play).toHaveBeenCalledTimes(1);
    });

    it('holdForCooldown stops a stream that is still loading or reconnecting, not one that plays', () => {
      const blocked = { on: false };
      const { f, pb } = guarded(blocked);
      pb.playChannel(ch('1'));
      f.emit({ kind: 'playing' });
      blocked.on = true;
      pb.holdForCooldown();
      expect(f.supervisor.stop).not.toHaveBeenCalled();
      f.emit({ kind: 'reconnecting', attempt: 1 } as SupervisorStatus);
      pb.holdForCooldown();
      expect(f.supervisor.stop).toHaveBeenCalledTimes(1);
      expect(pb.current()?.id).toBe('1');
      expect(pb.status()).toBeUndefined();
      blocked.on = false;
      expect(pb.playChannel(ch('1'))).toBe(true);
    });

    it('a stream the source refused is held, so the end of the cooldown reopens it', () => {
      const blocked = { on: false };
      const { f, pb } = guarded(blocked);
      pb.playChannel(ch('1'));
      f.emit({ kind: 'failed', reason: 'refused' });
      blocked.on = true;
      pb.holdForCooldown();
      blocked.on = false;
      pb.resumeHeld();
      expect(f.supervisor.play).toHaveBeenCalledTimes(2);
    });
  });

  describe('VOD', () => {
    const vod = { kind: 'movie', itemId: 'm1', url: 'http://example.test/movie/u/p/1.mp4', title: 'T', resumeMs: 0, tracks: {} } as VodPlayable;

    it('playVod sets the stand-in channel and plays with vod options', () => {
      const f = fakes();
      const pb = createPlaybackController(f.player, f.supervisor, undefined, 'HTML5', () => 'src-1');
      pb.playVod(vod, 12_000);
      expect(pb.current()).toEqual({ id: 'vod:m1', number: 0, name: '', group: '', favourite: false, url: vod.url });
      expect(f.supervisor.play).toHaveBeenCalledWith(vod.url, undefined, { sourceKey: 'src-1', vod: true, startMs: 12_000 });
    });

    it('delegates transport, position and subtitle cues to the supervisor', () => {
      const f = fakes();
      const pb = createPlaybackController(f.player, f.supervisor);
      pb.playVod(vod, 0);
      pb.pause(); pb.resume(); pb.seek(5000);
      expect(f.supervisor.pause).toHaveBeenCalled();
      expect(f.supervisor.resume).toHaveBeenCalled();
      expect(f.supervisor.seek).toHaveBeenCalledWith(5000);
      expect(pb.positionMs()).toBe(42_000);
      expect(pb.durationMs()).toBe(600_000);
      expect(pb.paused()).toBe(true);
      const fn = () => undefined;
      pb.onSubtitle(fn);
      expect(f.supervisor.onSubtitle).toHaveBeenCalledWith(fn);
    });

    it('exposes audio and text tracks through the player', () => {
      const f = fakes();
      const pb = createPlaybackController(f.player, f.supervisor);
      expect(pb.audioTracks()).toHaveLength(1);
      pb.selectAudioTrack('a1');
      expect(f.player.selectAudioTrack).toHaveBeenCalledWith('a1');
      expect(pb.textTracks()).toHaveLength(1);
      pb.selectTextTrack(null);
      expect(f.player.selectTextTrack).toHaveBeenCalledWith(null);
    });

    it('playVod does not play while the source is cooling down (held)', () => {
      const f = fakes();
      const pb = createPlaybackController(f.player, f.supervisor, undefined, 'HTML5', undefined, { blocked: () => true, refused: () => undefined, answered: () => undefined });
      pb.playVod(vod, 0);
      expect(f.supervisor.play).not.toHaveBeenCalled();
    });

    it('a VOD held by the cooldown gate resumes as VOD with its start and source key', () => {
      const f = fakes();
      let blocked = true;
      const pb = createPlaybackController(f.player, f.supervisor, undefined, 'HTML5', () => 'src-1', { blocked: () => blocked, refused: () => undefined, answered: () => undefined });
      f.supervisor.positionMs.mockReturnValue(undefined);
      pb.playVod(vod, 7000);
      blocked = false;
      pb.resumeHeld();
      expect(f.supervisor.play).toHaveBeenCalledTimes(1);
      expect(f.supervisor.play).toHaveBeenCalledWith(vod.url, undefined, { sourceKey: 'src-1', vod: true, startMs: 7000 });
    });

    it('holdForCooldown during VOD loading resumes as VOD at the later known position', () => {
      const f = fakes();
      const pb = createPlaybackController(f.player, f.supervisor);
      pb.playVod(vod, 7000);
      f.emit({ kind: 'loading' } as SupervisorStatus);
      f.supervisor.positionMs.mockReturnValue(9000);
      pb.holdForCooldown();
      expect(f.supervisor.stop).toHaveBeenCalled();
      f.supervisor.positionMs.mockReturnValue(undefined);
      pb.resumeHeld();
      expect(f.supervisor.play).toHaveBeenLastCalledWith(vod.url, undefined, { sourceKey: undefined, vod: true, startMs: 9000 });
    });

    it('playChannel after a held VOD plays live and drops the VOD; stop drops it too', () => {
      const f = fakes();
      let blocked = true;
      const pb = createPlaybackController(f.player, f.supervisor, undefined, 'HTML5', undefined, { blocked: () => blocked, refused: () => undefined, answered: () => undefined });
      pb.playVod(vod, 7000);
      pb.playChannel(ch('1'));
      blocked = false;
      pb.resumeHeld();
      expect(f.supervisor.play).toHaveBeenLastCalledWith(ch('1').url, ch('1').alternateUrl, { sourceKey: undefined, channel: 'Channel' });
      blocked = true;
      pb.playVod(vod, 1);
      pb.stop();
      blocked = false;
      pb.resumeHeld();
      expect(f.supervisor.play).toHaveBeenCalledTimes(1);
      expect(pb.current()).toBeUndefined();
    });

    it('playVod supersedes a stale live begin() token', () => {
      const f = fakes();
      const pb = createPlaybackController(f.player, f.supervisor);
      const t = pb.begin();
      pb.playVod(vod, 0);
      expect(pb.isLatest(t)).toBe(false);
    });

    it('a blocked VOD that never opened ignores the previous title position', () => {
      const f = fakes(); // positionMs defaults to 42_000: the previous title's leftover
      let blocked = true;
      const pb = createPlaybackController(f.player, f.supervisor, undefined, 'HTML5', undefined, { blocked: () => blocked, refused: () => undefined, answered: () => undefined });
      pb.playVod(vod, 0);
      blocked = false;
      pb.resumeHeld();
      expect(f.supervisor.play).toHaveBeenCalledWith(vod.url, undefined, { sourceKey: undefined, vod: true, startMs: 0 });
    });

    it('holdForCooldown leaves an ended or failed VOD alone (its next-episode or error card stays)', () => {
      for (const s of [{ kind: 'ended' }, { kind: 'failed', reason: 'unavailable' }] as SupervisorStatus[]) {
        const f = fakes();
        const pb = createPlaybackController(f.player, f.supervisor);
        pb.playVod(vod, 0);
        f.emit(s);
        pb.holdForCooldown();
        expect(f.supervisor.stop).not.toHaveBeenCalled();
        expect(pb.status()).toEqual(s);
        pb.resumeHeld();
        expect(f.supervisor.play).toHaveBeenCalledTimes(1);
      }
    });

    it('startedAttempts comes from the supervisor', () => {
      const f = fakes();
      const pb = createPlaybackController(f.player, f.supervisor);
      expect(pb.startedAttempts()).toBe(3);
    });

    it('position and duration are undefined unless the current VOD was opened', () => {
      const f = fakes(); // the supervisor still reports 42_000 / 600_000: the previous title's leftovers
      let blocked = true;
      const pb = createPlaybackController(f.player, f.supervisor, undefined, 'HTML5', undefined, { blocked: () => blocked, refused: () => undefined, answered: () => undefined });
      expect(pb.positionMs()).toBeUndefined();
      pb.playVod(vod, 0);
      expect(pb.positionMs()).toBeUndefined();
      expect(pb.durationMs()).toBeUndefined();
      blocked = false;
      pb.resumeHeld();
      expect(pb.positionMs()).toBe(42_000);
      expect(pb.durationMs()).toBe(600_000);
      pb.stop();
      expect(pb.positionMs()).toBeUndefined();
      expect(pb.durationMs()).toBeUndefined();
    });
  });
});
