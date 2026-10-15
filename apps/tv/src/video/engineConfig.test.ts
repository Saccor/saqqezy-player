import { describe, expect, it } from 'vitest';
import { START_CUSHION_S, avplayBuffering, hlsConfig, isTvPlatform, mpegtsConfig } from './engineConfig.ts';

const loadPolicy = (ttfb: number, load: number, errRetries: number) => ({
  default: {
    maxTimeToFirstByteMs: ttfb, maxLoadTimeMs: load,
    timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
    errorRetry: { maxNumRetry: errRetries, retryDelayMs: 500, maxRetryDelayMs: 4000, shouldRetry: expect.any(Function) },
  },
});

describe('engineConfig', () => {
  it('TV platforms', () => {
    expect(['tizen', 'webos', 'browser'].map(isTvPlatform)).toEqual([true, true, false]);
  });

  it('hls.js: start offset and seek line per preset; no rate catch-up on TVs', () => {
    expect(hlsConfig('balanced', true)).toEqual({
      lowLatencyMode: true, liveSyncMode: 'buffered', liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 5,
      maxLiveSyncPlaybackRate: 1, backBufferLength: 10, maxBufferSize: 30_000_000, maxBufferHole: 0.5,
      liveMaxUnchangedPlaylistRefresh: 5, fragLoadPolicy: loadPolicy(6000, 20000, 4), playlistLoadPolicy: loadPolicy(4000, 8000, 3),
    });
    expect(hlsConfig('low', false)).toMatchObject({
      liveSyncDurationCount: 1.5, liveMaxLatencyDurationCount: 4, maxLiveSyncPlaybackRate: 1.1, backBufferLength: 30,
      maxBufferSize: 60_000_000,
    });
    expect(hlsConfig('stable', false)).toMatchObject({ liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 8, maxLiveSyncPlaybackRate: 1.05 });
  });

  it('hls.js never retries a request the source refused (401/403/410, and the limit statuses)', () => {
    const cfg = hlsConfig('balanced', false);
    for (const policy of [cfg.fragLoadPolicy, cfg.playlistLoadPolicy]) {
      const retry = policy!.default.errorRetry!;
      const should = (code: number | undefined, wouldRetry = true) =>
        retry.shouldRetry!(retry, 0, false, code === undefined ? undefined : { url: '', code }, wouldRetry);
      expect([401, 403, 410, 429, 458, 503, 509].map((c) => should(c))).toEqual(Array(7).fill(false));
      expect([404, 500, undefined].map((c) => should(c))).toEqual([true, true, true]);
      expect(should(500, false)).toBe(false); // hls.js's own decision still applies
    }
  });

  it('mpegts.js on TV: seek chaser with wide thresholds, no rate sync, worker off, small back buffer', () => {
    const common = {
      isLive: true, lazyLoad: false, autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 30,
      autoCleanupMinBackwardDuration: 15, reuseRedirectedURL: true, fixAudioTimestampGap: true,
      liveBufferLatencyChasingOnPaused: false, statisticsInfoReportInterval: 500, enableWorker: false, liveSync: false,
      liveBufferLatencyChasing: true,
    };
    expect(mpegtsConfig('low', true)).toEqual({ ...common, enableStashBuffer: false, liveBufferLatencyMaxLatency: 2.5, liveBufferLatencyMinRemain: 1 });
    expect(mpegtsConfig('balanced', true)).toEqual({ ...common, enableStashBuffer: true, stashInitialSize: 384 * 1024, liveBufferLatencyMaxLatency: 6, liveBufferLatencyMinRemain: 3 });
    expect(mpegtsConfig('stable', true)).toEqual({ ...common, enableStashBuffer: true, stashInitialSize: 384 * 1024, liveBufferLatencyMaxLatency: 8, liveBufferLatencyMinRemain: 4 });
  });

  it('mpegts.js on desktop: gentle rate sync, chaser only as a far backstop', () => {
    expect(mpegtsConfig('balanced', false)).toMatchObject({
      enableWorker: true, autoCleanupMaxBackwardDuration: 60, autoCleanupMinBackwardDuration: 30,
      liveSync: true, liveSyncMaxLatency: 5, liveSyncTargetLatency: 3, liveSyncPlaybackRate: 1.05,
      liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 20, liveBufferLatencyMinRemain: 6,
    });
    expect(mpegtsConfig('low', false)).toMatchObject({ liveSyncMaxLatency: 2, liveSyncTargetLatency: 1.2, liveSyncPlaybackRate: 1.1 });
    expect(mpegtsConfig('stable', false)).toMatchObject({ liveSyncMaxLatency: 8, liveSyncTargetLatency: 5, liveSyncPlaybackRate: 1.05 });
  });

  it('start cushion and AVPlay buffering per preset', () => {
    expect(START_CUSHION_S).toEqual({ low: 0, balanced: 1.5, stable: 3 });
    expect(avplayBuffering('low')).toEqual({ play: 4, resume: 5, timeout: 5 });
    expect(avplayBuffering('balanced')).toEqual({ play: 4, resume: 6, timeout: 6 });
    expect(avplayBuffering('stable')).toEqual({ play: 6, resume: 10, timeout: 10 });
  });
});
