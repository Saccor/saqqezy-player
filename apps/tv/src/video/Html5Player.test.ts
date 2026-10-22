import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

type Handler = (...a: unknown[]) => void;
const created = vi.hoisted(() => ({
  hls: [] as { calls: string[]; config: unknown; handlers: Record<string, Handler>; playingDate: Date | null; latency: number; liveSyncPosition: number | null }[],
  mpegts: [] as { calls: string[]; src: unknown; config: unknown; handlers: Record<string, Handler>; error?: (type: string, detail: string, info?: unknown) => void }[],
}));

vi.mock('hls.js', () => {
  class FakeHls {
    static isSupported = () => true;
    static Events = { ERROR: 'hlsError', LEVEL_LOADED: 'hlsLevelLoaded' };
    calls: string[] = [];
    handlers: Record<string, Handler> = {};
    audioTracks = [];
    subtitleTracks: { name: string; lang?: string }[] = [];
    subtitleTrack = -1;
    levels = [];
    playingDate: Date | null = null;
    latency = 0;
    liveSyncPosition: number | null = null;
    constructor(public config: unknown) { created.hls.push(this); }
    on(e: string, fn: Handler): void { this.calls.push('on'); this.handlers[e] = fn; }
    loadSource(): void { this.calls.push('loadSource'); }
    attachMedia(): void { this.calls.push('attachMedia'); }
    detachMedia(): void { this.calls.push('detachMedia'); }
    destroy(): void { this.calls.push('destroy'); }
    startLoad(): void { this.calls.push('startLoad'); }
    recoverMediaError(): void { this.calls.push('recoverMediaError'); }
    swapAudioCodec(): void { this.calls.push('swapAudioCodec'); }
  }
  return {
    default: FakeHls,
    ErrorDetails: {
      MANIFEST_INCOMPATIBLE_CODECS_ERROR: 'a', BUFFER_ADD_CODEC_ERROR: 'b', BUFFER_INCOMPATIBLE_CODECS_ERROR: 'c',
      MANIFEST_PARSING_ERROR: 'd', MANIFEST_LOAD_ERROR: 'manifestLoadError', LEVEL_LOAD_ERROR: 'levelLoadError',
    },
    ErrorTypes: { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' },
  };
});

vi.mock('mpegts.js', () => ({
  default: {
    isSupported: () => true,
    Events: { ERROR: 'error', LOADING_COMPLETE: 'loading_complete', STATISTICS_INFO: 'statistics_info' },
    ErrorTypes: { NETWORK_ERROR: 'NetworkError', MEDIA_ERROR: 'MediaError' },
    ErrorDetails: {
      MEDIA_FORMAT_ERROR: 'FormatError', MEDIA_FORMAT_UNSUPPORTED: 'FormatUnsupported',
      MEDIA_CODEC_UNSUPPORTED: 'CodecUnsupported', MEDIA_MSE_ERROR: 'MediaMSEError',
    },
    createPlayer: (src: unknown, config: unknown) => {
      const p = {
        calls: [] as string[],
        src,
        config,
        handlers: {} as Record<string, Handler>,
        error: undefined as ((type: string, detail: string, info?: unknown) => void) | undefined,
        on(e: string, fn: Handler) { p.handlers[e] = fn; if (e === 'error') p.error = fn as typeof p.error; },
        attachMediaElement() { p.calls.push('attach'); },
        load() { p.calls.push('load'); },
        pause() { p.calls.push('pause'); },
        unload() { p.calls.push('unload'); },
        detachMediaElement() { p.calls.push('detach'); },
        destroy() { p.calls.push('destroy'); },
      };
      created.mpegts.push(p);
      return p;
    },
  },
}));

const { Html5Player } = await import('./Html5Player.ts');

const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
beforeAll(() => {
  for (const k of ['self', 'location', 'navigator']) saved[k] = g[k];
  const location = { href: 'http://app.test/', origin: 'http://app.test' };
  Object.defineProperty(globalThis, 'location', { value: location, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
});
afterAll(() => {
  for (const k of Object.keys(saved)) Object.defineProperty(globalThis, k, { value: saved[k], configurable: true, writable: true });
});

function ranges(list: [number, number][]) {
  return { length: list.length, start: (i: number) => list[i]![0], end: (i: number) => list[i]![1] };
}

function fakeVideo() {
  const listeners: Record<string, (() => void)[]> = {};
  const v = {
    readyState: 0,
    error: null,
    muted: false,
    volume: 1,
    currentTime: 0,
    duration: Number.NaN as number,
    playbackRate: 1,
    buffered: ranges([]),
    seekable: ranges([]),
    videoWidth: 0,
    videoHeight: 0,
    style: {} as Record<string, string>,
    parentElement: null as unknown,
    playCalls: 0,
    paused: true,
    textTracks: undefined as unknown,
    quality: undefined as { totalVideoFrames: number; droppedVideoFrames: number } | undefined,
    getVideoPlaybackQuality() { return v.quality ?? { totalVideoFrames: 0, droppedVideoFrames: 0 }; },
    addEventListener(t: string, fn: () => void) { (listeners[t] ??= []).push(fn); },
    removeEventListener(t: string, fn: () => void) { listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn); },
    fire(t: string) { for (const fn of listeners[t] ?? []) fn(); },
    canPlayType: () => '',
    play: (): Promise<void> => { v.playCalls++; v.paused = false; return Promise.resolve(); },
    pause() { v.paused = true; },
    load() {},
    removeAttribute() {},
  };
  return v;
}

function makePlayer(opts: { isTv?: boolean } = {}) {
  const video = fakeVideo();
  const layer = { video, setRect() {}, setAspect() {}, relayout() {}, destroy() {} };
  const player = new Html5Player(layer as unknown as ConstructorParameters<typeof Html5Player>[0], opts);
  const events: [string, Record<string, unknown> | undefined][] = [];
  player.onState((s, d) => events.push([s, d as Record<string, unknown> | undefined]));
  return { video, player, events };
}

describe('Html5Player – volume', () => {
  test('setVolume sets the element volume (clamped) and never touches its mute', () => {
    const { video, player } = makePlayer();
    player.setVolume(0.35);
    expect(video.volume).toBe(0.35);
    player.setVolume(0);
    expect(video.volume).toBe(0);
    expect(video.muted).toBe(false);
    player.setVolume(3);
    expect(video.volume).toBe(1);
  });
});

describe('Html5Player – mpegts.js to HLS retry', () => {
  test('the engine switch runs after the mpegts.js ERROR callback has returned, not inside it', async () => {
    const video = fakeVideo();
    const layer = { video, setRect() {}, setAspect() {}, relayout() {}, destroy() {} };
    const player = new Html5Player(layer as unknown as ConstructorParameters<typeof Html5Player>[0]);
    const states: string[] = [];
    player.onState((s) => states.push(s));
    await player.open('http://example.test/live/u/p/1');
    const ts = created.mpegts.at(-1)!;
    expect(created.hls).toHaveLength(0);

    ts.error!('MediaError', 'FormatError');
    // Still inside (or right after) the callback: nothing torn down or started yet.
    expect(ts.calls).not.toContain('destroy');
    expect(created.hls).toHaveLength(0);
    expect(states).not.toContain('error');
    // A second error from the same, now abandoned, instance is ignored.
    ts.error!('MediaError', 'FormatError');

    await new Promise((r) => setTimeout(r, 0));
    expect(ts.calls).toContain('destroy');
    expect(created.hls).toHaveLength(1);
    expect(created.hls[0]!.calls).toEqual(expect.arrayContaining(['loadSource', 'attachMedia']));
    expect(states).not.toContain('error');
    player.destroy();
  });

  test('a stop before the deferred switch still tears the mpegts.js instance down and starts nothing', async () => {
    const video = fakeVideo();
    const layer = { video, setRect() {}, setAspect() {}, relayout() {}, destroy() {} };
    const player = new Html5Player(layer as unknown as ConstructorParameters<typeof Html5Player>[0]);
    await player.open('http://example.test/live/u/p/2');
    const ts = created.mpegts.at(-1)!;
    const hlsBefore = created.hls.length;
    ts.error!('MediaError', 'FormatError');
    player.stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(ts.calls).toContain('destroy');
    expect(created.hls).toHaveLength(hlsBefore);
  });
});

describe('Html5Player – live delay and recovery signals', () => {
  test('creates engines with the preset configs (TV)', async () => {
    const { player } = makePlayer({ isTv: true });
    player.setLiveProfile({ preset: 'stable', targetS: 6, allowRate: false });
    await player.open('http://example.test/a.ts');
    expect(created.mpegts.at(-1)!.config).toMatchObject({ liveBufferLatencyMaxLatency: 8, enableWorker: false });
    await player.open('http://example.test/a.m3u8');
    expect(created.hls.at(-1)!.config).toMatchObject({ liveSyncDurationCount: 3, maxLiveSyncPlaybackRate: 1 });
    player.destroy();
  });

  test('mpegts LOADING_COMPLETE and the element ended event report EOS', async () => {
    const { player, video, events } = makePlayer();
    await player.open('http://example.test/a.ts');
    created.mpegts.at(-1)!.handlers.loading_complete!();
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'EOS' })]);
    await player.open('http://example.test/b.ts');
    video.fire('ended');
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'EOS' })]);
    player.destroy();
  });

  test('health() names the engine; errors carry the engine error id', async () => {
    const { player, video, events } = makePlayer();
    await player.open('http://example.test/a.ts');
    expect(player.health().engine).toBe('mpegts.js');
    created.mpegts.at(-1)!.error!('NetworkError', 'NetworkUnrecoverableEarlyEof');
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'NETWORK', detail: 'NetworkUnrecoverableEarlyEof' })]);

    await player.open('http://example.test/b.ts');
    (video as { error: unknown }).error = { code: 3 };
    video.fire('error');
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'DECODE', detail: 'MEDIA_ERR_DECODE' })]);
    (video as { error: unknown }).error = null;

    await player.open('http://example.test/a.m3u8');
    expect(player.health().engine).toBe('hls.js');
    created.hls.at(-1)!.handlers.hlsError!('hlsError', { fatal: true, type: 'mediaError', details: 'b' });
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'UNSUPPORTED', detail: 'b' })]);
    player.destroy();
  });

  test('HTTP 401/403 report AUTH with the status', async () => {
    const { player, events } = makePlayer();
    await player.open('http://example.test/a.ts');
    created.mpegts.at(-1)!.error!('NetworkError', 'HttpStatusCodeInvalid', { code: 403 });
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'AUTH', httpStatus: 403 })]);
    await player.open('http://example.test/a.m3u8');
    created.hls.at(-1)!.handlers.hlsError!('hlsError', { fatal: true, type: 'networkError', details: 'x', response: { code: 401 } });
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'AUTH', httpStatus: 401 })]);
    player.destroy();
  });

  test('HTTP 410 is gone, not a refusal: NETWORK with the status on both engines', async () => {
    const { player, events } = makePlayer();
    await player.open('http://example.test/a.ts');
    created.mpegts.at(-1)!.error!('NetworkError', 'HttpStatusCodeInvalid', { code: 410 });
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'NETWORK', httpStatus: 410 })]);
    await player.open('http://example.test/a.m3u8');
    const hls = created.hls.at(-1)!;
    hls.handlers.hlsError!('hlsError', { fatal: true, type: 'networkError', details: 'manifestLoadError', response: { code: 410 } });
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'NETWORK', httpStatus: 410 })]);
    // A fragment 410 still tries one in-place reload first; what surfaces after it is NETWORK with the status, never AUTH.
    await player.open('http://example.test/b.m3u8');
    const frag = created.hls.at(-1)!;
    const before = events.length;
    frag.handlers.hlsError!('hlsError', { fatal: true, type: 'networkError', details: 'fragLoadError', response: { code: 410 } });
    expect(frag.calls).toContain('startLoad');
    expect(events.length).toBe(before);
    frag.handlers.hlsError!('hlsError', { fatal: true, type: 'networkError', details: 'fragLoadError', response: { code: 410 } });
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'NETWORK', httpStatus: 410 })]);
    player.destroy();
  });

  test('a manifest or playlist load answered 400/404/410/5xx reports NETWORK with the status at once (no in-place reload)', async () => {
    const { player, events } = makePlayer();
    for (const [details, code] of [['manifestLoadError', 404], ['levelLoadError', 404], ['manifestLoadError', 400], ['levelLoadError', 500], ['manifestLoadError', 502]] as const) {
      await player.open('http://example.test/archive.m3u8');
      const hls = created.hls.at(-1)!;
      hls.handlers.hlsError!('hlsError', { fatal: true, type: 'networkError', details, response: { code } });
      expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'NETWORK', httpStatus: code, detail: details })]);
      expect(hls.calls).not.toContain('startLoad');
    }
    // 503 stays a refusal (AUTH); a manifest error without a status keeps the in-place reload.
    await player.open('http://example.test/archive.m3u8');
    created.hls.at(-1)!.handlers.hlsError!('hlsError', { fatal: true, type: 'networkError', details: 'manifestLoadError', response: { code: 503 } });
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'AUTH', httpStatus: 503 })]);
    await player.open('http://example.test/archive.m3u8');
    const timeout = created.hls.at(-1)!;
    timeout.handlers.hlsError!('hlsError', { fatal: true, type: 'networkError', details: 'manifestLoadError', response: { code: 0 } });
    expect(timeout.calls).toContain('startLoad');
    player.destroy();
  });

  test('mpegts.js 404 carries the status as NETWORK', async () => {
    const { player, events } = makePlayer();
    await player.open('http://example.test/archive.ts');
    created.mpegts.at(-1)!.error!('NetworkError', 'HttpStatusCodeInvalid', { code: 404 });
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'NETWORK', httpStatus: 404 })]);
    player.destroy();
  });

  test('limit statuses (429/503) are refusals too, so the supervisor stops and the cooldown starts', async () => {
    const { player, events } = makePlayer();
    await player.open('http://example.test/a.ts');
    created.mpegts.at(-1)!.error!('NetworkError', 'HttpStatusCodeInvalid', { code: 429 });
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'AUTH', httpStatus: 429 })]);
    await player.open('http://example.test/a.m3u8');
    created.hls.at(-1)!.handlers.hlsError!('hlsError', { fatal: true, type: 'networkError', details: 'x', response: { code: 503 } });
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'AUTH', httpStatus: 503 })]);
    player.destroy();
  });

  test('health(): buffer, ranges, frames and bytes for mpegts.js', async () => {
    const { player, video } = makePlayer();
    await player.open('http://example.test/a.ts');
    expect(player.health()).toMatchObject({ tracksBytes: true, behindLiveSource: 'buffer' });
    expect(player.health().lastByteAt).toBeUndefined();
    created.mpegts.at(-1)!.handlers.statistics_info!({ speed: 512 });
    expect(player.health().lastByteAt).toBeTypeOf('number');
    video.currentTime = 10;
    video.buffered = ranges([[5, 13], [14, 20]]);
    video.quality = { totalVideoFrames: 500, droppedVideoFrames: 20 };
    expect(player.health()).toMatchObject({ positionMs: 10_000, bufferAheadS: 3, rangeCount: 2, framesPresented: 480 });
    video.quality = { totalVideoFrames: 0, droppedVideoFrames: 0 };
    expect(player.health().framesPresented).toBeUndefined();
    player.destroy();
  });

  test('health(): hls.js reports a sane stream clock for display and the target duration', async () => {
    const { player } = makePlayer();
    await player.open('http://example.test/a.m3u8');
    const hls = created.hls.at(-1)!;
    hls.handlers.hlsLevelLoaded!('hlsLevelLoaded', { details: { live: true, targetduration: 2 } });
    hls.playingDate = new Date(Date.now() - 8000);
    expect(player.health()).toMatchObject({ targetDurationS: 2 });
    expect(player.health().streamClockBehindS).toBeCloseTo(8, 0);
    expect(player.health()).not.toHaveProperty('behindLiveS'); // no edge latency yet: nothing to steer by
    expect(player.health().tracksBytes).toBeUndefined();
    hls.playingDate = new Date(Date.now() - 3_600_000); // a broken clock: an hour off
    hls.latency = 7;
    expect(player.health()).toMatchObject({ behindLiveS: 7, behindLiveSource: 'edge' });
    expect(player.health()).not.toHaveProperty('streamClockBehindS');
    player.destroy();
  });

  test('setPlaybackRate sets the element rate; open() resets it to 1', async () => {
    const { player, video } = makePlayer();
    await player.open('http://example.test/a.m3u8');
    player.setPlaybackRate(1.05);
    expect(video.playbackRate).toBe(1.05);
    await player.open('http://example.test/b.m3u8');
    expect(video.playbackRate).toBe(1);
    player.destroy();
  });

  test('raw TS waits for the start cushion (balanced 1.5 s, at most 3 s) before play()', async () => {
    vi.useFakeTimers();
    try {
      const { player, video } = makePlayer();
      player.setLiveProfile({ preset: 'balanced', targetS: 3, allowRate: false });
      await player.open('http://example.test/a.ts');
      expect(video.playCalls).toBe(0);
      video.buffered = ranges([[0, 1.6]]);
      vi.advanceTimersByTime(100);
      expect(video.playCalls).toBe(1);

      player.setLiveProfile({ preset: 'stable', targetS: 6, allowRate: false });
      await player.open('http://example.test/b.ts');
      video.buffered = ranges([]);
      vi.advanceTimersByTime(2900);
      expect(video.playCalls).toBe(1);
      vi.advanceTimersByTime(100);
      expect(video.playCalls).toBe(2);

      player.setLiveProfile({ preset: 'low', targetS: 1.5, allowRate: false });
      await player.open('http://example.test/c.ts');
      expect(video.playCalls).toBe(3); // no cushion on low
      player.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Html5Player – in-place recovery', () => {
  test('fatal hls.js network error: startLoad once (no state of its own); a second within 10 s is reported', async () => {
    const { player, events } = makePlayer();
    await player.open('http://example.test/a.m3u8');
    const hls = created.hls.at(-1)!;
    const err = { fatal: true, type: 'networkError', details: 'fragLoadError' };
    hls.handlers.hlsError!('hlsError', err);
    expect(hls.calls).toContain('startLoad');
    expect(events.at(-1)?.[0]).toBe('loading');
    hls.handlers.hlsError!('hlsError', err);
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'NETWORK' })]);
    player.destroy();
  });

  test('fatal hls.js media errors: recover, then swap codec and recover, then report', async () => {
    const { player, events } = makePlayer();
    await player.open('http://example.test/a.m3u8');
    const hls = created.hls.at(-1)!;
    const err = { fatal: true, type: 'mediaError', details: 'bufferStalledError' };
    hls.handlers.hlsError!('hlsError', err);
    expect(hls.calls.filter((c) => c === 'recoverMediaError')).toHaveLength(1);
    hls.handlers.hlsError!('hlsError', err);
    expect(hls.calls).toContain('swapAudioCodec');
    expect(hls.calls.filter((c) => c === 'recoverMediaError')).toHaveLength(2);
    expect(events.some(([s]) => s === 'error')).toBe(false);
    hls.handlers.hlsError!('hlsError', err);
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'MEDIA' })]);
    expect(hls.calls).not.toContain('destroy');
    player.destroy();
  });

  test('gap jump: nudges inside a range, jumps to the next range from a range end', async () => {
    const { player, video } = makePlayer();
    await player.open('http://example.test/a.ts');
    video.buffered = ranges([[0, 10], [12, 20]]);
    video.currentTime = 5;
    expect(player.recover('gapJump')).toBe(true);
    expect(video.currentTime).toBeCloseTo(5.1);
    video.currentTime = 10;
    expect(player.recover('gapJump')).toBe(true);
    expect(video.currentTime).toBeCloseTo(12.05);
    video.buffered = ranges([]);
    expect(player.recover('gapJump')).toBe(false);
    expect(player.recover('softReload')).toBe(false); // mpegts.js: no in-place reload
    player.destroy();
  });

  test('seekToLive per engine', async () => {
    const { player, video } = makePlayer();
    await player.open('http://example.test/a.m3u8');
    const hls = created.hls.at(-1)!;
    hls.liveSyncPosition = 95;
    expect(player.seekToLive(6)).toBe(true);
    expect(video.currentTime).toBe(95);
    hls.liveSyncPosition = null;
    expect(player.seekToLive(6)).toBe(false);

    await player.open('http://example.test/a.ts');
    video.currentTime = 10;
    video.buffered = ranges([[0, 20]]);
    expect(player.seekToLive(3)).toBe(true);
    expect(video.currentTime).toBe(17);
    expect(player.seekToLive(3)).toBe(true); // already there: no-op
    expect(video.currentTime).toBe(17);
    video.buffered = ranges([]);
    expect(player.seekToLive(3)).toBe(false);
    player.destroy();
  });

  test('holdLastFrame draws the frame into an overlay that the next playing removes', async () => {
    const appended: { removed: boolean }[] = [];
    const g = globalThis as Record<string, unknown>;
    const savedDoc = g.document;
    g.document = {
      createElement: () => {
        const c = { width: 0, height: 0, className: '', style: {}, removed: false,
          getContext: () => ({ drawImage() {} }), remove() { c.removed = true; } };
        return c;
      },
    };
    try {
      const { player, video } = makePlayer();
      video.parentElement = { appendChild: (c: { removed: boolean }) => { appended.push(c); } };
      video.videoWidth = 1280;
      video.videoHeight = 720;
      await player.open('http://example.test/a.ts');
      player.holdLastFrame();
      player.holdLastFrame(); // only one overlay
      expect(appended).toHaveLength(1);
      await player.open('http://example.test/b.ts');
      expect(appended[0]!.removed).toBe(false); // survives the reconnect
      video.fire('playing');
      expect(appended[0]!.removed).toBe(true);
      player.holdLastFrame();
      player.releaseLastFrame();
      expect(appended[1]!.removed).toBe(true);
      player.destroy();
    } finally {
      g.document = savedDoc;
    }
  });
});

describe('Html5Player – final fixes', () => {
  test('1a: isLive per engine (hls.js LEVEL_LOADED, native duration, mpegts.js always live)', async () => {
    const { player, video } = makePlayer();
    await player.open('http://example.test/a.m3u8');
    const hls = created.hls.at(-1)!;
    expect(player.health().isLive).toBeUndefined();
    hls.handlers.hlsLevelLoaded!('hlsLevelLoaded', { details: { live: false, targetduration: 6 } });
    expect(player.health().isLive).toBe(false);
    hls.handlers.hlsLevelLoaded!('hlsLevelLoaded', { details: { live: true, targetduration: 6 } });
    expect(player.health().isLive).toBe(true);

    await player.open('http://example.test/movie.mp4');
    video.duration = Number.NaN;
    expect(player.health().isLive).toBeUndefined();
    video.duration = 600;
    expect(player.health().isLive).toBe(false);
    video.duration = Number.POSITIVE_INFINITY;
    expect(player.health().isLive).toBe(true);

    await player.open('http://example.test/a.ts');
    expect(player.health().isLive).toBe(true);
    player.destroy();
  });

  test('1d: the element ended event is EOS only on a live stream; a file just ends', async () => {
    const { player, video, events } = makePlayer();
    await player.open('http://example.test/movie.mp4');
    video.duration = 600;
    video.fire('ended');
    expect(events.at(-1)?.[0]).toBe('idle');
    expect(events.some(([s]) => s === 'error')).toBe(false);

    await player.open('http://example.test/live.mp4');
    video.duration = Number.POSITIVE_INFINITY;
    video.fire('ended');
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'EOS' })]);

    await player.open('http://example.test/vod.m3u8');
    created.hls.at(-1)!.handlers.hlsLevelLoaded!('hlsLevelLoaded', { details: { live: false, targetduration: 6 } });
    video.fire('ended');
    expect(events.at(-1)?.[0]).toBe('idle');
    player.destroy();
  });

  test('1e: mpegts.js LOADING_COMPLETE reports EOS only once the buffer ahead has drained', async () => {
    vi.useFakeTimers();
    try {
      const { player, video, events } = makePlayer();
      player.setLiveProfile({ preset: 'low', targetS: 1.5, allowRate: false });
      await player.open('http://example.test/a.ts');
      video.currentTime = 10;
      video.buffered = ranges([[0, 40]]);
      created.mpegts.at(-1)!.handlers.loading_complete!();
      vi.advanceTimersByTime(5000);
      expect(events.some(([s]) => s === 'error')).toBe(false);
      video.currentTime = 39.6;
      vi.advanceTimersByTime(500);
      expect(events.filter(([s]) => s === 'error')).toEqual([['error', expect.objectContaining({ code: 'EOS' })]]);
      vi.advanceTimersByTime(5000);
      expect(events.filter(([s]) => s === 'error')).toHaveLength(1);
      player.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  test('sticky liveness: hls.js live then ENDLIST (live:false) then ended is still EOS', async () => {
    const { player, video, events } = makePlayer();
    await player.open('http://example.test/live.m3u8');
    const hls = created.hls.at(-1)!;
    hls.handlers.hlsLevelLoaded!('hlsLevelLoaded', { details: { live: true, targetduration: 6 } });
    hls.handlers.hlsLevelLoaded!('hlsLevelLoaded', { details: { live: false, targetduration: 6 } });
    expect(player.health().isLive).toBe(true);
    video.fire('ended');
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'EOS' })]);
    player.destroy();
  });

  test('sticky liveness: native Infinity observed, then finite duration, then ended is EOS', async () => {
    const { player, video, events } = makePlayer();
    await player.open('http://example.test/live.mp4');
    video.duration = Number.POSITIVE_INFINITY;
    expect(player.health().isLive).toBe(true);
    video.duration = 600;
    expect(player.health().isLive).toBe(true);
    video.fire('ended');
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'EOS' })]);
    player.destroy();
  });

  test('sticky liveness: native Infinity seen only by the durationchange event still latches', async () => {
    const { player, video, events } = makePlayer();
    await player.open('http://example.test/live2.mp4');
    video.duration = Number.POSITIVE_INFINITY;
    video.fire('durationchange');
    video.duration = 600;
    video.fire('ended');
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'EOS' })]);
    player.destroy();
  });

  test('sticky liveness does not leak into the next session', async () => {
    const { player, video, events } = makePlayer();
    await player.open('http://example.test/live3.mp4');
    video.duration = Number.POSITIVE_INFINITY;
    expect(player.health().isLive).toBe(true);
    await player.open('http://example.test/movie2.mp4');
    video.duration = 600;
    video.fire('ended');
    expect(events.at(-1)?.[0]).toBe('idle');
    player.destroy();
  });

  test('1g: seekToLive is a no-op (true) on a non-live stream', async () => {
    const { player, video } = makePlayer();
    await player.open('http://example.test/movie.mp4');
    video.duration = 600;
    video.seekable = ranges([[0, 600]]);
    video.currentTime = 10;
    expect(player.seekToLive(6)).toBe(true);
    expect(video.currentTime).toBe(10);

    await player.open('http://example.test/vod.m3u8');
    const hls = created.hls.at(-1)!;
    hls.handlers.hlsLevelLoaded!('hlsLevelLoaded', { details: { live: false, targetduration: 6 } });
    hls.liveSyncPosition = 590;
    video.currentTime = 10;
    expect(player.seekToLive(6)).toBe(true);
    expect(video.currentTime).toBe(10);
    player.destroy();
  });

  test('1a/2: native VOD reports no edge distance; native live reports it as edge', async () => {
    const { player, video } = makePlayer();
    await player.open('http://example.test/movie.mp4');
    video.duration = 600;
    video.seekable = ranges([[0, 600]]);
    expect(player.health()).not.toHaveProperty('behindLiveS');
    video.duration = Number.POSITIVE_INFINITY;
    video.seekable = ranges([[100, 160]]);
    video.currentTime = 150;
    expect(player.health()).toMatchObject({ behindLiveS: 10, behindLiveSource: 'edge', isLive: true });
    player.destroy();
  });

  test('2: hls.js steers by the edge latency; the stream clock is reported separately for display', async () => {
    const { player } = makePlayer();
    await player.open('http://example.test/a.m3u8');
    const hls = created.hls.at(-1)!;
    hls.handlers.hlsLevelLoaded!('hlsLevelLoaded', { details: { live: true, targetduration: 2 } });
    hls.playingDate = new Date(Date.now() - 8000);
    hls.latency = 5;
    const h = player.health();
    expect(h).toMatchObject({ behindLiveS: 5, behindLiveSource: 'edge', targetDurationS: 2, isLive: true });
    expect(h.streamClockBehindS).toBeCloseTo(8, 0);
    hls.playingDate = new Date(Date.now() - 3_600_000); // a broken clock: an hour off
    expect(player.health()).not.toHaveProperty('streamClockBehindS');
    expect(player.health()).toMatchObject({ behindLiveS: 5, behindLiveSource: 'edge' });
    player.destroy();
  });

  test('3: in-place hls.js network recovery emits no synthetic buffering', async () => {
    const { player, events } = makePlayer();
    await player.open('http://example.test/a.m3u8');
    const hls = created.hls.at(-1)!;
    const before = events.length;
    hls.handlers.hlsError!('hlsError', { fatal: true, type: 'networkError', details: 'fragLoadError' });
    expect(hls.calls).toContain('startLoad');
    expect(events.slice(before)).toEqual([]);
    player.destroy();
  });

  test('6: seekToLive never lands in a gap: clamped to the start of the last range', async () => {
    const { player, video } = makePlayer();
    await player.open('http://example.test/a.ts');
    video.currentTime = 5;
    video.buffered = ranges([[0, 10], [18, 20]]);
    expect(player.seekToLive(3)).toBe(true);
    expect(video.currentTime).toBe(18);
    player.destroy();
  });
});

describe('Html5Player – mpegts.js audio the browser cannot decode', () => {
  const ec3 = { code: 9, msg: "Failed to execute 'addSourceBuffer' on 'MediaSource': The type provided ('audio/mp4;codecs=ec-3') is unsupported." };

  test('an unsupported audio codec (Dolby in desktop Chrome) keeps the video playing instead of failing', async () => {
    const { player, events } = makePlayer();
    await player.open('http://example.test/live/u/p/1.ts');
    const ts = created.mpegts.at(-1)!;
    (ts as unknown as { mediaInfo: unknown }).mediaInfo = { videoCodec: 'hvc1.1.1.L150.B0', audioCodec: 'ec-3' };

    ts.error!('MediaError', 'MediaMSEError', ec3);

    expect(events.filter(([s]) => s === 'error')).toEqual([]);
    expect(ts.calls).not.toContain('destroy');
    expect(player.streamInfo().audioCodec).toBe('ec-3 (not supported here)');
  });

  test('soundUndecodable: the refused audio codec counts, on TVs too', async () => {
    const { player } = makePlayer({ isTv: true });
    await player.open('http://example.test/live/u/p/1.ts');
    expect(player.soundUndecodable()).toBe(false);
    created.mpegts.at(-1)!.error!('MediaError', 'MediaMSEError', ec3);
    expect(player.soundUndecodable()).toBe(true);
  });

  test('an MSE error that is not about audio still fails the stream', async () => {
    const { player, events } = makePlayer();
    await player.open('http://example.test/live/u/p/1.ts');
    const ts = created.mpegts.at(-1)!;

    ts.error!('MediaError', 'MediaMSEError', { code: 9, msg: "The type provided ('video/mp4;codecs=hvc1.1.1.L150.B0') is unsupported." });

    expect(events.filter(([s]) => s === 'error').map(([, d]) => d?.code)).toEqual(['MEDIA']);
  });
});

describe('Html5Player – sound the element plays without (a file with audio the browser cannot decode)', () => {
  // Desktop Chrome plays a file with AC-3 / E-AC-3 sound as a silent picture with no error: only its decoded-byte
  // counters show it. Measured with synthetic .mkv files: AAC decodes, AC-3 and E-AC-3 stay at 0 audio bytes.
  const setDecoded = (video: ReturnType<typeof fakeVideo>, audio: number | undefined, videoBytes: number, playedS: number) => {
    Object.assign(video, { webkitAudioDecodedByteCount: audio, webkitVideoDecodedByteCount: videoBytes, played: ranges(playedS > 0 ? [[100, 100 + playedS]] : []) });
  };

  test('no audio decoded after 3 s of picture: undecodable', async () => {
    const { player, video } = makePlayer();
    await player.open('http://example.test/movie/u/p/1.mkv', 1, { live: false });
    setDecoded(video, 0, 900_000, 3.5);
    expect(player.soundUndecodable()).toBe(true);
  });

  test('not before 3 s have played, not with decoded audio, not without the counters', async () => {
    const { player, video } = makePlayer();
    await player.open('http://example.test/movie/u/p/1.mkv', 1, { live: false });
    setDecoded(video, 0, 900_000, 2);
    expect(player.soundUndecodable()).toBe(false);
    setDecoded(video, 50_000, 900_000, 10);
    expect(player.soundUndecodable()).toBe(false);
    setDecoded(video, undefined, 900_000, 10);
    expect(player.soundUndecodable()).toBe(false);
    setDecoded(video, 0, 0, 10);
    expect(player.soundUndecodable()).toBe(false);
  });

  test('never from the counters on a TV (hardware decoders may not count) or with no session', async () => {
    const { player, video } = makePlayer({ isTv: true });
    setDecoded(video, 0, 900_000, 10);
    expect(player.soundUndecodable()).toBe(false);
    await player.open('http://example.test/movie/u/p/1.mkv', 1, { live: false });
    expect(player.soundUndecodable()).toBe(false);
  });
});

describe('Html5Player – VOD', () => {
  test('a VOD open configures mpegts.js for a finite stream', async () => {
    const { player } = makePlayer();
    await player.open('http://example.test/movie/u/p/1.ts', 1, { live: false });
    const ts = created.mpegts.at(-1)!;
    expect(ts.src).toMatchObject({ type: 'mpegts', isLive: false });
    expect(ts.config).toMatchObject({ isLive: false, liveSync: false, liveBufferLatencyChasing: false });
    player.destroy();
  });

  test('a live open is unchanged: mpegts.js stays live, hls.js keeps its live tuning', async () => {
    const { player } = makePlayer();
    await player.open('http://example.test/a.ts');
    expect(created.mpegts.at(-1)!.src).toMatchObject({ isLive: true });
    expect(created.mpegts.at(-1)!.config).toMatchObject({ isLive: true });
    await player.open('http://example.test/a.m3u8');
    expect(created.hls.at(-1)!.config).toHaveProperty('liveSyncDurationCount');
    expect(created.hls.at(-1)!.config).not.toHaveProperty('startPosition');
    player.destroy();
  });

  test('a VOD open gives hls.js the start position and no live-sync tuning', async () => {
    const { player } = makePlayer();
    await player.open('http://example.test/movie/1.m3u8', 1, { live: false, startMs: 754_000 });
    const cfg = created.hls.at(-1)!.config as Record<string, unknown>;
    expect(cfg).toMatchObject({ startPosition: 754 });
    for (const k of ['liveSyncMode', 'liveSyncDurationCount', 'liveMaxLatencyDurationCount', 'maxLiveSyncPlaybackRate']) {
      expect(cfg).not.toHaveProperty(k);
    }
    await player.open('http://example.test/movie/2.m3u8', 2, { live: false });
    expect(created.hls.at(-1)!.config).not.toHaveProperty('startPosition');
    player.destroy();
  });

  test('the native element seeks to the start position once, on loadedmetadata', async () => {
    const { player, video } = makePlayer();
    await player.open('http://example.test/movie/1.mp4', 1, { live: false, startMs: 90_000 });
    expect(video.currentTime).toBe(0);
    video.duration = 600;
    video.fire('loadedmetadata');
    expect(video.currentTime).toBe(90);
    video.currentTime = 200;
    video.fire('loadedmetadata');
    expect(video.currentTime).toBe(200);
    player.destroy();
  });

  test('the start position is clamped to the duration', async () => {
    const { player, video } = makePlayer();
    await player.open('http://example.test/movie/1.mp4', 1, { live: false, startMs: 900_000 });
    video.duration = 600;
    video.fire('loadedmetadata');
    expect(video.currentTime).toBe(599);
    player.destroy();
  });

  test('pause, play, paused, duration and a clamped seek drive the element', async () => {
    const { player, video } = makePlayer();
    expect(player.duration()).toBeUndefined();
    expect(player.seek(5000)).toBe(false); // nothing open
    await player.open('http://example.test/movie/1.mp4', 1, { live: false });
    expect(player.duration()).toBeUndefined(); // not known yet
    expect(player.seek(5000)).toBe(false);
    video.duration = 600;
    expect(player.duration()).toBe(600_000);
    expect(player.paused()).toBe(false);
    player.pause();
    expect(player.paused()).toBe(true);
    const calls = video.playCalls;
    player.play();
    expect(video.playCalls).toBe(calls + 1);
    expect(player.paused()).toBe(false);
    expect(player.seek(120_000)).toBe(true);
    expect(video.currentTime).toBe(120);
    expect(player.seek(-5000)).toBe(true);
    expect(video.currentTime).toBe(0);
    expect(player.seek(10_000_000)).toBe(true);
    expect(video.currentTime).toBe(599);
    player.destroy();
  });

  test('play() swallows an autoplay rejection', async () => {
    const { player, video } = makePlayer();
    await player.open('http://example.test/movie/1.mp4', 1, { live: false });
    video.play = () => Promise.reject(new Error('blocked'));
    expect(() => player.play()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    player.destroy();
  });

  test('a live stream has no duration', async () => {
    const { player, video } = makePlayer();
    await player.open('http://example.test/live.mp4');
    video.duration = Number.POSITIVE_INFINITY;
    expect(player.duration()).toBeUndefined();
    player.destroy();
  });

  test('a VOD session never reports isLive true', async () => {
    const { player, video, events } = makePlayer();
    await player.open('http://example.test/movie/1.ts', 1, { live: false });
    expect(player.health().isLive).toBeUndefined();
    expect(player.health()).not.toHaveProperty('behindLiveSource');
    video.duration = 600;
    expect(player.health().isLive).toBe(false);
    // The download finishing is not the end of the film: no EOS; the element's ended reports idle.
    created.mpegts.at(-1)!.handlers.loading_complete!();
    expect(events.some(([s]) => s === 'error')).toBe(false);
    video.fire('ended');
    expect(events.at(-1)?.[0]).toBe('idle');

    await player.open('http://example.test/movie/2.m3u8', 2, { live: false });
    const hls = created.hls.at(-1)!;
    hls.handlers.hlsLevelLoaded!('hlsLevelLoaded', { details: { live: true, targetduration: 6 } });
    hls.latency = 7;
    expect(player.health().isLive).toBe(false);
    expect(player.health()).not.toHaveProperty('behindLiveS');
    video.duration = Number.NaN;
    expect(player.health().isLive).toBeUndefined();

    await player.open('http://example.test/movie/3.mp4', 3, { live: false });
    video.duration = Number.POSITIVE_INFINITY;
    video.fire('durationchange');
    expect(player.health().isLive).toBeUndefined();
    video.duration = 600;
    video.fire('ended');
    expect(events.at(-1)?.[0]).toBe('idle');
    player.destroy();
  });

  test('audio tracks with hls.js carry the codec family where the rendition names one', async () => {
    const { player } = makePlayer();
    await player.open('http://example.test/movie/1.m3u8', 1, { live: false });
    const hls = created.hls.at(-1)! as unknown as { audioTracks: { name: string; lang?: string; audioCodec?: string }[]; audioTrack: number };
    hls.audioTracks = [
      { name: 'English', lang: 'en', audioCodec: 'mp4a.40.2' },
      { name: 'Svenska', lang: 'sv', audioCodec: 'ac-3' },
      { name: '', lang: 'de', audioCodec: 'something-else' },
      { name: 'Commentary' },
    ];
    hls.audioTrack = 0;
    expect(player.audioTracks()).toEqual([
      { id: '0', label: 'English', language: 'en', active: true, codec: 'AAC' },
      { id: '1', label: 'Svenska', language: 'sv', active: false, codec: 'AC-3' },
      { id: '2', label: 'de', language: 'de', active: false },
      { id: '3', label: 'Commentary', active: false },
    ]);
    player.destroy();
  });

  test('text tracks with hls.js: list, select and off', async () => {
    const { player } = makePlayer();
    await player.open('http://example.test/movie/1.m3u8', 1, { live: false });
    const hls = created.hls.at(-1)! as unknown as { subtitleTracks: { name: string; lang?: string }[]; subtitleTrack: number };
    hls.subtitleTracks = [{ name: 'English', lang: 'en' }, { name: '', lang: 'sv' }];
    expect(player.textTracks()).toEqual([
      { id: '0', label: 'English', language: 'en', active: false },
      { id: '1', label: 'sv', language: 'sv', active: false },
    ]);
    player.selectTextTrack('1');
    expect(hls.subtitleTrack).toBe(1);
    expect(player.textTracks()[1]!.active).toBe(true);
    player.selectTextTrack(null);
    expect(hls.subtitleTrack).toBe(-1);
    player.selectTextTrack('7'); // out of range: ignored
    expect(hls.subtitleTrack).toBe(-1);
    player.destroy();
  });

  test('native text tracks: subtitles and captions only; select shows one and disables the rest', async () => {
    const { player, video } = makePlayer();
    await player.open('http://example.test/movie/1.mp4', 1, { live: false });
    const list = [
      { kind: 'subtitles', label: 'English', language: 'en', mode: 'disabled' },
      { kind: 'metadata', label: 'meta', language: '', mode: 'hidden' },
      { kind: 'captions', label: '', language: 'sv', mode: 'showing' },
    ];
    video.textTracks = list;
    expect(player.textTracks()).toEqual([
      { id: '0', label: 'English', language: 'en', active: false },
      { id: '2', label: 'sv', language: 'sv', active: true },
    ]);
    player.selectTextTrack('0');
    // Hidden, not showing: the app draws the cue (onSubtitle), clear of its overlay.
    expect(list.map((t) => t.mode)).toEqual(['hidden', 'hidden', 'disabled']);
    expect(player.textTracks()[0]!.active).toBe(true);
    player.selectTextTrack(null);
    expect(list.map((t) => t.mode)).toEqual(['disabled', 'hidden', 'disabled']);
    expect(player.textTracks().some((t) => t.active)).toBe(false);
    player.destroy();
  });

  test('VOD HLS uses hls.js where native HLS cannot switch audio tracks; live and track-capable elements stay native', async () => {
    const { player, video } = makePlayer();
    (video as { canPlayType: (m: string) => string }).canPlayType = (m) => (m.includes('mpegurl') ? 'maybe' : '');
    const before = created.hls.length;
    await player.open('http://example.test/movie/1.m3u8', 1, { live: false });
    expect(created.hls.length).toBe(before + 1);
    await player.open('http://example.test/live/1.m3u8', 2);
    expect(created.hls.length).toBe(before + 1);
    (video as Record<string, unknown>).audioTracks = { length: 0 };
    await player.open('http://example.test/movie/2.m3u8', 3, { live: false });
    expect(created.hls.length).toBe(before + 1);
    player.destroy();
  });

  test('hls.js leaves subtitle drawing to the app', async () => {
    const { player } = makePlayer();
    await player.open('http://example.test/movie/1.m3u8', 1, { live: false });
    expect((created.hls.at(-1)! as unknown as { subtitleDisplay?: boolean }).subtitleDisplay).toBe(false);
    player.destroy();
  });

  test('onSubtitle reports the selected track\'s active cue text, and null when it clears', async () => {
    vi.useFakeTimers();
    try {
      const { player, video } = makePlayer();
      await player.open('http://example.test/movie/1.mp4', 1, { live: false });
      const track = { kind: 'subtitles', label: 'English', language: 'en', mode: 'showing', activeCues: [{ text: '<i>Hello</i>' }] as { text: string }[] };
      video.textTracks = [{ kind: 'metadata', label: '', language: '', mode: 'hidden', activeCues: [{ text: 'not a subtitle' }] }, track];
      const seen: (string | null)[] = [];
      const off = player.onSubtitle((t) => seen.push(t));
      vi.advanceTimersByTime(300);
      expect(seen).toEqual(['Hello']);
      expect(track.mode).toBe('hidden'); // a track the element showed by itself is drawn by the app instead
      vi.advanceTimersByTime(1000);
      expect(seen).toEqual(['Hello']); // unchanged text is not repeated
      track.activeCues = [];
      vi.advanceTimersByTime(300);
      expect(seen).toEqual(['Hello', null]);
      off();
      track.activeCues = [{ text: 'After' }];
      vi.advanceTimersByTime(1000);
      expect(seen).toEqual(['Hello', null]);
      player.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  test('with hls.js only its selected subtitle track is read: embedded captions never show, Off shows nothing', async () => {
    vi.useFakeTimers();
    try {
      const { player, video } = makePlayer();
      await player.open('http://example.test/movie/1.m3u8', 1, { live: false });
      const hls = created.hls.at(-1)! as unknown as { subtitleTracks: { name: string; lang?: string }[]; subtitleTrack: number };
      hls.subtitleTracks = [{ name: 'English', lang: 'en' }, { name: 'Svenska', lang: 'sv' }];
      video.textTracks = [
        { kind: 'captions', label: 'English', language: 'en', mode: 'hidden', activeCues: [{ text: 'CC1 caption' }] },
        { kind: 'subtitles', label: 'English', language: 'en', mode: 'disabled', activeCues: [{ text: 'English cue' }] },
        { kind: 'subtitles', label: 'Svenska', language: 'sv', mode: 'hidden', activeCues: [{ text: 'Svensk cue' }] },
      ];
      const seen: (string | null)[] = [];
      player.onSubtitle((t) => seen.push(t));
      hls.subtitleTrack = -1;
      vi.advanceTimersByTime(300);
      expect(seen).toEqual([]); // nothing to show (no cue was shown before either)
      hls.subtitleTrack = 1;
      vi.advanceTimersByTime(300);
      expect(seen).toEqual(['Svensk cue']);
      hls.subtitleTrack = -1;
      vi.advanceTimersByTime(300);
      expect(seen).toEqual(['Svensk cue', null]);
      player.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  test('live hls.js keeps drawing its own subtitles (only VOD hands them to the app)', async () => {
    const { player } = makePlayer();
    await player.open('http://example.test/live/1.m3u8', 1);
    expect((created.hls.at(-1)! as unknown as { subtitleDisplay?: boolean }).subtitleDisplay).toBeUndefined();
    player.destroy();
  });

  test('a stop clears a shown cue', async () => {
    vi.useFakeTimers();
    try {
      const { player, video } = makePlayer();
      await player.open('http://example.test/movie/1.mp4', 1, { live: false });
      video.textTracks = [{ kind: 'subtitles', label: 'A', language: 'en', mode: 'hidden', activeCues: [{ text: 'Cue' }] }];
      const seen: (string | null)[] = [];
      player.onSubtitle((t) => seen.push(t));
      vi.advanceTimersByTime(300);
      player.stop();
      expect(seen).toEqual(['Cue', null]);
      player.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a start seek that cannot land yet (duration unknown) is retried on durationchange and lands once', async () => {
    const { player, video } = makePlayer();
    await player.open('http://example.test/movie/1.mp4', 1, { live: false, startMs: 90_000 });
    video.duration = Number.NaN;
    video.fire('loadedmetadata');
    expect(video.currentTime).toBe(0);
    video.duration = Number.POSITIVE_INFINITY;
    video.fire('durationchange');
    expect(video.currentTime).toBe(0);
    video.duration = 600;
    video.fire('durationchange');
    expect(video.currentTime).toBe(90);
    video.currentTime = 200;
    video.fire('durationchange');
    video.fire('loadedmetadata');
    expect(video.currentTime).toBe(200);
    player.destroy();
  });

  test('paused() is false without a session, an empty text track id is ignored, VOD hls keeps a 60 s back buffer', async () => {
    const { player, video } = makePlayer();
    video.paused = true;
    expect(player.paused()).toBe(false);
    await player.open('http://example.test/movie/1.mp4', 1, { live: false });
    const list = [
      { kind: 'subtitles', label: 'A', language: 'en', mode: 'disabled' },
      { kind: 'subtitles', label: 'B', language: 'sv', mode: 'disabled' },
    ];
    video.textTracks = list;
    player.selectTextTrack('');
    expect(list.map((x) => x.mode)).toEqual(['disabled', 'disabled']);
    await player.open('http://example.test/movie/2.m3u8', 2, { live: false });
    expect(created.hls.at(-1)!.config).toMatchObject({ backBufferLength: 60 });
    await player.open('http://example.test/a.m3u8');
    expect(created.hls.at(-1)!.config).not.toMatchObject({ backBufferLength: 60 });
    player.destroy();
  });
});

describe('Html5Player – close before open and status awareness', () => {
  test('closed() resolves on the next tick after stop() tore hls.js down', async () => {
    vi.useFakeTimers();
    try {
      const { player } = makePlayer();
      await player.open('http://example.test/live/u/p/1.m3u8');
      const hls = created.hls.at(-1)!;
      player.stop();
      expect(hls.calls).toContain('destroy');
      let done = false;
      void player.closed().then(() => { done = true; });
      await Promise.resolve();
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('closed() after stop() on mpegts.js: unload, detach and destroy already ran', async () => {
    const { player } = makePlayer();
    await player.open('http://example.test/live/u/p/1.ts');
    const ts = created.mpegts.at(-1)!;
    player.stop();
    await player.closed();
    expect(ts.calls).toEqual(expect.arrayContaining(['unload', 'detach', 'destroy']));
    expect(ts.calls.indexOf('unload')).toBeLessThan(ts.calls.indexOf('destroy'));
  });

  test('closed() after stop() on the native element: src removed and load() called', async () => {
    const { video, player } = makePlayer();
    const calls: string[] = [];
    video.canPlayType = ((t: string) => (t === 'application/vnd.apple.mpegurl' ? 'maybe' : '')) as typeof video.canPlayType;
    video.removeAttribute = ((a: string) => { calls.push(`remove:${a}`); }) as typeof video.removeAttribute;
    video.load = () => { calls.push('load'); };
    await player.open('http://example.test/live/u/p/1.m3u8');
    calls.length = 0;
    player.stop();
    await player.closed();
    expect(calls).toEqual(['remove:src', 'load']);
  });

  test('closed() also waits for a deferred mpegts.js teardown (switch to HLS) that a stop() overtook', async () => {
    const { player } = makePlayer();
    await player.open('http://example.test/live/u/p/1');
    const ts = created.mpegts.at(-1)!;
    ts.error!('MediaError', 'FormatError');
    player.stop();
    await player.closed();
    expect(ts.calls).toContain('destroy');
  });

  test('supportsStatus(): true on hls.js and mpegts.js, false on the native element and without a session', async () => {
    const { video, player } = makePlayer();
    expect(player.supportsStatus()).toBe(false);
    await player.open('http://example.test/live/u/p/1.m3u8');
    expect(player.supportsStatus()).toBe(true);
    await player.open('http://example.test/live/u/p/1.ts');
    expect(player.supportsStatus()).toBe(true);
    video.canPlayType = ((t: string) => (t === 'application/vnd.apple.mpegurl' ? 'maybe' : '')) as typeof video.canPlayType;
    await player.open('http://example.test/live/u/p/2.m3u8');
    expect(player.supportsStatus()).toBe(false);
    player.stop();
    expect(player.supportsStatus()).toBe(false);
  });
});

describe('Html5Player – source headers (dev proxy route)', () => {
  test('a play with headers goes through the route with ua/ref; one without keeps today\'s URL', async () => {
    const { player } = makePlayer();
    await player.open('http://cdn.example.test/live/1.ts', 1, { headers: { userAgent: 'SyntheticAgent/1.0', referrer: 'http://ref.example.test/' } });
    const withH = (created.mpegts.at(-1)!.src as { url: string }).url;
    expect(withH).toContain(`u=${encodeURIComponent('http://cdn.example.test/live/1.ts')}`);
    expect(withH).toContain('&ua=SyntheticAgent%2F1.0&ref=http%3A%2F%2Fref.example.test%2F');
    await player.open('http://cdn.example.test/live/1.ts', 2);
    const plain = (created.mpegts.at(-1)!.src as { url: string }).url;
    expect(plain).not.toContain('&ua=');
    expect(plain).not.toContain('&ref=');
  });

  test('the fake provider is proxied only when the play has headers', async () => {
    const { player } = makePlayer();
    await player.open('http://127.0.0.1:8899/live/u/p/1.ts', 1);
    expect((created.mpegts.at(-1)!.src as { url: string }).url).toBe('http://127.0.0.1:8899/live/u/p/1.ts');
    await player.open('http://127.0.0.1:8899/live/u/p/1.ts', 2, { headers: { userAgent: 'SyntheticAgent/1.0' } });
    expect((created.mpegts.at(-1)!.src as { url: string }).url).toMatch(/^\/__proxy\/hls\/1\.ts\?u=.*&ua=SyntheticAgent%2F1\.0$/);
  });
});

describe('Html5Player – multiview window', () => {
  test('setMuted mutes the element, and the autoplay unmute never undoes it', () => {
    const { video, player } = makePlayer();
    video.muted = false;
    player.setMuted(true);
    expect(video.muted).toBe(true);
    player.unmuteIfAutoMuted();
    expect(video.muted).toBe(true);
    player.setMuted(false);
    expect(video.muted).toBe(false);
  });

  test('engine overrides lie over the live preset config; cleared, the plain config returns; VOD ignores them', async () => {
    const { player } = makePlayer();
    player.setEngineOverrides({ hls: { capLevelToPlayerSize: true, maxBufferSize: 20_000_000 }, mpegts: { stashInitialSize: 131072 } });
    await player.open('http://example.test/a.m3u8');
    expect(created.hls.at(-1)!.config).toMatchObject({ capLevelToPlayerSize: true, maxBufferSize: 20_000_000 });
    await player.open('http://example.test/a.ts');
    expect(created.mpegts.at(-1)!.config).toMatchObject({ stashInitialSize: 131072 });
    await player.open('http://example.test/movie/2.m3u8', 2, { live: false });
    expect(created.hls.at(-1)!.config).not.toMatchObject({ maxBufferSize: 20_000_000 });
    player.setEngineOverrides(undefined);
    await player.open('http://example.test/b.m3u8');
    expect(created.hls.at(-1)!.config).not.toMatchObject({ capLevelToPlayerSize: true });
    player.destroy();
  });
});
