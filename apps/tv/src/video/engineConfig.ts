import type { HlsConfig } from 'hls.js';
import type Mpegts from 'mpegts.js';
import { REFUSAL_STATUSES } from '@iptv/core';
import type { LivePreset } from '@iptv/player';

/**
 * Live delay presets mapped to engine options.
 * Pure data, no engine imports at runtime, so every value is pinned by a unit test.
 */

/** TVs (Tizen, webOS) mute or ignore playbackRate changes, so they correct drift by seeking only. */
export function isTvPlatform(platform: string): boolean {
  return platform === 'tizen' || platform === 'webos';
}

const MB = 1_000_000;
const SYNC_COUNT: Record<LivePreset, number> = { low: 1.5, balanced: 2, stable: 3 };
const MAX_LATENCY_COUNT: Record<LivePreset, number> = { low: 4, balanced: 5, stable: 8 };

/**
 * HTTP statuses hls.js must not retry: core's REFUSAL_STATUSES (the source refuses us; retrying only hammers it and
 * can extend a block), plus 410 (an expired stream: retrying cannot bring it back). 410 is not a refusal: the player
 * reports it as NETWORK with its status, never as AUTH, so it starts no cooldown.
 */
const REFUSED_STATUSES = new Set([...REFUSAL_STATUSES, 410]);

const loadPolicy = (ttfb: number, load: number, errRetries: number) => ({
  default: {
    maxTimeToFirstByteMs: ttfb,
    maxLoadTimeMs: load,
    // A timed-out load waits 1 s, then 4 s (exponential), before giving up: never a burst of instant retries.
    timeoutRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 4000, backoff: 'exponential' as const },
    errorRetry: {
      maxNumRetry: errRetries, retryDelayMs: 500, maxRetryDelayMs: 4000,
      shouldRetry: (_cfg: unknown, _count: number, _timeout: boolean, res: { code?: number } | undefined, retry: boolean) =>
        retry && !(res?.code !== undefined && REFUSED_STATUSES.has(res.code)),
    },
  },
});

export function hlsConfig(preset: LivePreset, isTv: boolean): Partial<HlsConfig> {
  return {
    // Harmless on non-LL streams; required for LL parts and for hls.js's own rate catch-up.
    lowLatencyMode: true,
    liveSyncMode: 'buffered',
    liveSyncDurationCount: SYNC_COUNT[preset],
    liveMaxLatencyDurationCount: MAX_LATENCY_COUNT[preset],
    maxLiveSyncPlaybackRate: isTv ? 1 : preset === 'low' ? 1.1 : 1.05,
    backBufferLength: isTv ? 10 : 30,
    maxBufferSize: (isTv ? 30 : 60) * MB,
    maxBufferHole: 0.5,
    liveMaxUnchangedPlaylistRefresh: 5,
    fragLoadPolicy: loadPolicy(6000, 20000, 4),
    playlistLoadPolicy: loadPolicy(4000, 8000, 3),
    // hls.js's own manifest defaults (no first-byte cap, 20 s, one error retry), with the spaced timeout retry and the
    // refusal guard of the other loaders.
    manifestLoadPolicy: loadPolicy(Infinity, 20000, 1),
  };
}

const TV_CHASE: Record<LivePreset, Mpegts.Config> = {
  low: { enableStashBuffer: false, liveBufferLatencyMaxLatency: 2.5, liveBufferLatencyMinRemain: 1 },
  balanced: { enableStashBuffer: true, stashInitialSize: 384 * 1024, liveBufferLatencyMaxLatency: 6, liveBufferLatencyMinRemain: 3 },
  stable: { enableStashBuffer: true, stashInitialSize: 384 * 1024, liveBufferLatencyMaxLatency: 8, liveBufferLatencyMinRemain: 4 },
};

const DESKTOP_SYNC: Record<LivePreset, Mpegts.Config> = {
  low: { enableStashBuffer: false, liveSyncMaxLatency: 2, liveSyncTargetLatency: 1.2, liveSyncPlaybackRate: 1.1 },
  balanced: { enableStashBuffer: true, stashInitialSize: 384 * 1024, liveSyncMaxLatency: 5, liveSyncTargetLatency: 3, liveSyncPlaybackRate: 1.05 },
  stable: { enableStashBuffer: true, stashInitialSize: 384 * 1024, liveSyncMaxLatency: 8, liveSyncTargetLatency: 5, liveSyncPlaybackRate: 1.05 },
};

export function mpegtsConfig(preset: LivePreset, isTv: boolean): Mpegts.Config {
  const common: Mpegts.Config = {
    isLive: true,
    lazyLoad: false,
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: isTv ? 30 : 60,
    autoCleanupMinBackwardDuration: isTv ? 15 : 30,
    reuseRedirectedURL: true,
    fixAudioTimestampGap: true,
    liveBufferLatencyChasingOnPaused: false,
    statisticsInfoReportInterval: 500,
    // Off the UI thread on desktop; on TVs only after the Tizen 6 / webOS 6 device test (research §10.4).
    enableWorker: !isTv,
  };
  if (isTv) return { ...common, liveSync: false, liveBufferLatencyChasing: true, ...TV_CHASE[preset] };
  // Desktop: rate-based sync; the seek chaser only catches a huge backlog.
  return {
    ...common, liveSync: true, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 20, liveBufferLatencyMinRemain: 6,
    ...DESKTOP_SYNC[preset],
  };
}

/** Raw TS: seconds to buffer before `play()`, so a Wi-Fi hiccup of that size never shows. */
export const START_CUSHION_S: Record<LivePreset, number> = { low: 0, balanced: 1.5, stable: 3 };
export const CUSHION_MAX_WAIT_MS = 3000;

/** Seconds for AVPlay `setBufferingParam` (FOR_PLAY minimum is 4, documented) and `setTimeoutForBuffering`. */
export function avplayBuffering(preset: LivePreset): { play: number; resume: number; timeout: number } {
  if (preset === 'low') return { play: 4, resume: 5, timeout: 5 };
  if (preset === 'stable') return { play: 6, resume: 10, timeout: 10 };
  return { play: 4, resume: 6, timeout: 6 };
}
