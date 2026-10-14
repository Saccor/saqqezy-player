import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

type Handler = (...a: unknown[]) => void;
const created = vi.hoisted(() => ({
  hls: [] as { calls: string[]; config: unknown; handlers: Record<string, Handler>; playingDate: Date | null; latency: number; liveSyncPosition: number | null }[],
  mpegts: [] as { calls: string[]; config: unknown; handlers: Record<string, Handler>; error?: (type: string, detail: string, info?: unknown) => void }[],
}));

vi.mock('hls.js', () => {
  class FakeHls {
    static isSupported = () => true;
    static Events = { ERROR: 'hlsError', LEVEL_LOADED: 'hlsLevelLoaded' };
    calls: string[] = [];
    handlers: Record<string, Handler> = {};
    audioTracks = [];
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
      MANIFEST_PARSING_ERROR: 'd',
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
      MEDIA_CODEC_UNSUPPORTED: 'CodecUnsupported',
    },
    createPlayer: (_src: unknown, config: unknown) => {
      const p = {
        calls: [] as string[],
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
    quality: undefined as { totalVideoFrames: number; droppedVideoFrames: number } | undefined,
    getVideoPlaybackQuality() { return v.quality ?? { totalVideoFrames: 0, droppedVideoFrames: 0 }; },
    addEventListener(t: string, fn: () => void) { (listeners[t] ??= []).push(fn); },
    removeEventListener(t: string, fn: () => void) { listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn); },
    fire(t: string) { for (const fn of listeners[t] ?? []) fn(); },
    canPlayType: () => '',
    play: () => { v.playCalls++; return Promise.resolve(); },
    pause() {},
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

  test('HTTP 401/403/410 report AUTH with the status', async () => {
    const { player, events } = makePlayer();
    await player.open('http://example.test/a.ts');
    created.mpegts.at(-1)!.error!('NetworkError', 'HttpStatusCodeInvalid', { code: 403 });
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'AUTH', httpStatus: 403 })]);
    await player.open('http://example.test/a.m3u8');
    created.hls.at(-1)!.handlers.hlsError!('hlsError', { fatal: true, type: 'networkError', details: 'x', response: { code: 401 } });
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'AUTH', httpStatus: 401 })]);
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
