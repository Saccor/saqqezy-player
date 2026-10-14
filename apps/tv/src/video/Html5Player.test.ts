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

  test('health(): hls.js prefers a sane wall clock, else the edge latency; reports the target duration', async () => {
    const { player } = makePlayer();
    await player.open('http://example.test/a.m3u8');
    const hls = created.hls.at(-1)!;
    hls.handlers.hlsLevelLoaded!('hlsLevelLoaded', { details: { live: true, targetduration: 2 } });
    hls.playingDate = new Date(Date.now() - 8000);
    expect(player.health()).toMatchObject({ behindLiveSource: 'pdt', targetDurationS: 2 });
    expect(player.health().behindLiveS).toBeCloseTo(8, 0);
    expect(player.health().tracksBytes).toBeUndefined();
    hls.playingDate = new Date(Date.now() - 3_600_000); // a broken clock: an hour off
    hls.latency = 7;
    expect(player.health()).toMatchObject({ behindLiveS: 7, behindLiveSource: 'edge' });
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
