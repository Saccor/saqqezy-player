# R1: Latency behind live in the web engines (research, 2026-10-14)

Scope: how far behind live our player sits, which part of that a client controls, and how to tune hls.js, mpegts.js, and (briefly) dash.js and Shaka to stay close to live without stalls. This builds on `docs/research/playback-and-legal-sources-2026-10.md` section A, which covers zapping and start time, and does not repeat it. Everything here is client-only (guardrail 6). No provider, league or broadcaster is named.

**Labels.** `[doc]` = vendor or spec documentation read during this research. `[source]` = I read the library source on GitHub (master, cross-checked against the pinned tag where noted). `[forum]` = community or issue-tracker report. `[inference]` = my reasoning or arithmetic. `[memory]` = my own knowledge, not re-verified here.

**Versions in the repo:** `apps/tv/package.json` pins `hls.js 1.7.3` and `mpegts.js 1.8.2`. The brief said hls.js ~1.6.x; 1.7.3 is the latest release and is what we ship. I checked option defaults against the `v1.7.3` tag. dash.js latest is v5.2.1 and Shaka Player latest is v5.2.13 (GitHub releases API).

---

## 0. Findings that matter for the current code (read this first)

`apps/tv/src/video/Html5Player.ts` currently does:

```ts
new Hls({ lowLatencyMode: false, backBufferLength: 30 });
mpegts.createPlayer({ type: 'mpegts', isLive: true, url: src },
  { enableWorker: false, lazyLoad: false, liveBufferLatencyChasing: true });
```

1. **`lowLatencyMode: false` silently disables hls.js playbackRate catch-up.** The latency controller returns early unless `lowLatencyMode` is true (`if (!lowLatencyMode || maxLiveSyncPlaybackRate === 1 || !levelDetails.live) return;`). `[source]` https://github.com/video-dev/hls.js/blob/master/src/controller/latency-controller.ts. The 1.0 release notes describe the flag as disabling "part loading and target latency playback rate adjustment". `[doc]` https://newreleases.io/project/yarn/hls.js/release/1.0.0-rc.5. This does not matter on TVs (where we should not use rate catch-up at all, see section 5), but it matters on desktop/browser. Setting `lowLatencyMode: true` on a non-LL stream is harmless: with no `EXT-X-PART` tags there are no parts to load, and the target latency falls back to `HOLD-BACK` or `liveSyncDurationCount × TARGETDURATION`. `[source]`
2. **hls.js `lowLatencyMode` defaults to `true`** in 1.7.3 (`[source]` config.ts), so our explicit `false` is a deliberate opt-out. The earlier research note (A6) says to keep it off for non-LL streams. I disagree for desktop: turning it on gives catch-up and changes nothing else for non-LL streams. On TVs, leave catch-up off with `maxLiveSyncPlaybackRate: 1` (the default) whatever the flag says.
3. **mpegts.js `liveBufferLatencyChasing: true` with the defaults (`MaxLatency 1.5 s`, `MinRemain 0.5 s`) is the most aggressive setting possible.** Every time the buffer goes over 1.5 s, it **seeks** to 0.5 s from the buffer end. `[source]` live-latency-chaser.ts. Two consequences: (a) a hard visual and audio skip every time the buffer builds up, and (b) the buffer never holds more than 1.5 s, so any Wi-Fi hiccup longer than about 1 s stalls. That is the "lowest latency, most stalls" corner. It suits a wired HDHomeRun on a LAN, not Wi-Fi. See section 3 for presets.
4. **mpegts.js keeps 2-3 minutes of back buffer by default** unless you set `autoCleanupSourceBuffer: true` (defaults `autoCleanupMaxBackwardDuration 180`, `MinBackwardDuration 120`). `[doc]` https://github.com/xqq/mpegts.js/blob/master/docs/api.md. At 8 Mbit/s, 180 s is about 180 MB of SourceBuffer, far too much for a 1 GB TV. The Samsung forum has reports of MSE memory growth until the app crashes. `[forum]` https://forum.developer.samsung.com/t/memory-leak-when-playing-video-via-mse/8704. Set `autoCleanupSourceBuffer: true` with 30/15 s.
5. **On TVs, playbackRate catch-up is unsafe.** Tizen web apps lose audio at 1.25x and above, a known issue across model years from Tizen 4 to Tizen 9. The suspected cause is that the engine mutes at any rate other than 1.0, and the media element has no `preservesPitch`. `[forum]` https://github.com/jellyfin/jellyfin-tizen/issues/117. On webOS packaged apps, `playbackRate` is ignored. LG staff said that on the native player, sound is not supported at other rates. `[forum]` https://forum.webostv.developer.lge.com/t/mediaelement-playbackrate-not-working/564. **Use seek-based correction on TVs; reserve rate-based catch-up for desktop Chromium/Tauri.**

---

## 1. Glass-to-glass latency: where it goes and what a client controls

### 1.1 Breakdown (HLS, typical OTT-style source)

| Stage | 6 s segments | 2 s segments | Client controls? |
|---|---|---|---|
| Capture + encode (lookahead, B-frames, GOP) | 0.5-3 s | 0.5-3 s | No |
| Packager: a segment can only be published once it is complete | +6 s (one full segment) | +2 s | No |
| Origin/CDN propagation, playlist cache TTL | 0.2-2 s | 0.2-2 s | No |
| Playlist discovery: client polls about once per target duration, so on average it learns of a new segment TD/2 late | ~3 s | ~1 s | Slightly (reload timing is engine-internal) |
| **Player hold-back / start offset**: hls.js default `liveSyncDurationCount = 3`, so it starts at N-3 segments | **18 s** | **6 s** | **Yes** |
| Segment download time + decoder pipeline | 0.3-2 s | 0.2-1 s | A little (lower start level) |
| **Total (estimate)** | **~25-30 s** | **~9-12 s** | |

- The 3×TD hold-back is a protocol norm, not an hls.js quirk. HLS `HOLD-BACK` "MUST be at least three times the Target Duration". `[doc]` https://datatracker.ietf.org/doc/html/draft-pantos-hls-rfc8216bis §4.4.3.8. RFC 8216 §6.3.3 tells clients not to start within three target durations of the end. `[memory]` https://www.rfc-editor.org/rfc/rfc8216#section-6.3.3
- The vendor figure for standard HLS is 18-30 s. `[doc via search snippet]` https://docs.aws.amazon.com/mediapackage/latest/userguide/hls-overview.md. My estimates above are `[inference]` built from that and the stage list.

### 1.2 Typical totals by delivery type

| Delivery | Typical glass-to-glass | Client share | Notes |
|---|---|---|---|
| HLS, 6 s segments, default player | 18-30 s `[doc]` | ~18-21 s hold-back | Most "provider" HLS looks like this |
| HLS, 2 s segments, default player | ~8-12 s `[inference]` | ~6-7 s | |
| LL-HLS (parts ~0.2-1 s, blocking reload) | 2-5 s `[doc/vendor]` https://www.forasoft.com/learn/ott/articles-ott/low-latency-delivery-ll-hls-ll-dash | `PART-HOLD-BACK` ≥ 3 × PART-TARGET `[doc]` | Needs server support; hls.js handles it with `lowLatencyMode: true` |
| LL-DASH / CMAF chunked | 2-4 s `[doc/vendor]` | `liveDelay` / ServiceDescription | dash.js LL mode needs fetch + chunked transfer `[doc]` https://dashif.org/dash.js/pages/usage/low-latency.html |
| Raw MPEG-TS over HTTP from a LAN tuner (HDHomeRun/TVHeadend style) | broadcast chain + **0.3-3 s** on our side `[inference]` | all of the client part is buffer | No segments, no playlist; the server pushes in real time |
| Raw MPEG-TS restreamed from a remote HLS source | unknown; whatever the upstream does plus our buffer | | We cannot see the upstream delay |

Vendor numbers disagree with each other (one CDN blog puts LL-HLS at 1-3 s and CMAF at 3-5 s). Treat them as ranges. `[doc/vendor]` https://blog.blazingcdn.com/en-us/cmaf-and-low-latency-hls-cutting-live-stream-delay

### 1.3 What a client can actually win

- **6 s HLS:** from hold-back 18 s down to about 9-12 s (1.5-2 × TD), so **6-9 s saved**. Going below 1.5×TD makes the buffer drop to almost nothing right before each new segment appears, and stalls follow. `[inference]` (arithmetic in section 7)
- **2 s HLS:** from 6 s to about 4-6 s, so **0-2 s saved**. The default is already close to the safe floor. A floor in seconds (not segments) matters more here.
- **Raw TS:** the only client latency is our buffer, 0.3-3 s. There is little to win, so the real decision is "how much buffer do we keep for Wi-Fi".
- **LL-HLS / LL-DASH:** a few seconds, but only if the user's source already provides it. We cannot create it (no proxy, guardrail 6).
- **What a client cannot fix:** encoder delay, segment duration, CDN. Copy must never promise "real-time"; say "as close to live as your source allows".

---

## 2. hls.js 1.7.3: live-sync options (exact names and defaults)

All defaults from `src/config.ts` at tag v1.7.3 `[source]` https://github.com/video-dev/hls.js/blob/v1.7.3/src/config.ts, descriptions from `docs/API.md` `[doc]` https://github.com/video-dev/hls.js/blob/master/docs/API.md.

| Option | Default | What it does |
|---|---|---|
| `liveSyncDurationCount` | `3` | Start/sync point = edge - N × `EXT-X-TARGETDURATION`. Docs: "decreasing this value is likely to cause playback stalls". |
| `liveSyncDuration` | `undefined` | Same in seconds; takes precedence. **Cannot be combined** with `liveSyncDurationCount` / `liveMaxLatencyDurationCount`. Docs warn that below about 3 segment durations stalls become likely. |
| `liveMaxLatencyDurationCount` | `Infinity` | If the playhead falls more than N × TD behind the edge, **seek** to `liveSyncPosition`. Must be > `liveSyncDurationCount`. |
| `liveMaxLatencyDuration` | `undefined` | Same in seconds; must be > `liveSyncDuration`. |
| `liveSyncMode` | `'edge'` | New in 1.7. `'edge'` = jump straight to `liveSyncPosition`; `'buffered'` = seek there only if it is buffered, otherwise to the start of the next buffered range (fewer refetches). |
| `maxLiveSyncPlaybackRate` | `1` (range 1-2) | >1 enables rate catch-up toward `targetLatency`. **Only active when `lowLatencyMode` is true.** |
| `liveSyncOnStallIncrease` | `1` (s) | `targetLatency` grows by this much per stall, capped at one target duration. Setting `hls.targetLatency` resets the stall count. |
| `liveMaxUnchangedPlaylistRefresh` | `Infinity` | After N unchanged live playlist reloads, raise `PLAYLIST_UNCHANGED_ERROR` (tries another level, else fatal). Useful as a "frozen source" detector. Minimum 2. |
| `liveDurationInfinity` | `false` | Sets MSE duration to Infinity for native live UI. Leave off (we draw our own UI). |
| `lowLatencyMode` | **`true`** | LL-HLS parts, start at `PART-HOLD-BACK`, and enables rate catch-up. |
| `backBufferLength` | `Infinity` | Played media kept. We set 30; 10-20 is enough for live on TVs. |
| `liveBackBufferLength` | `null` | Deprecated alias; use `backBufferLength`. |
| `frontBufferFlushThreshold` | `Infinity` | Evict non-contiguous forward ranges. |
| `maxBufferLength` | `30` s | Forward-buffer target. For live it is capped by the edge anyway. |
| `maxMaxBufferLength` | `600` s | Upper cap. |
| `maxBufferSize` | `60 MB` | Byte cap. Lower it on TVs (about 30 MB). |
| `maxBufferHole` | `0.1` s | Gap tolerance. |
| `detectStallWithCurrentTimeMs` | `1250` ms | Stall detection when no `waiting` event fires. |
| `highBufferWatchdogPeriod` | `2` s in source (`API.md` says 3 s, so the docs are stale) | Nudge or skip a gap when `currentTime` is stuck with data buffered. |
| `nudgeOffset` / `nudgeMaxRetry` / `nudgeOnVideoHole` | `0.1` / `3` / `true` | Nudge step, retries before fatal `BUFFER_STALLED_ERROR`, flush on a video hole. |
| `startFragPrefetch` | `false` | Fetch the first segment before media is attached. |
| `fragLoadPolicy.default` | `maxTimeToFirstByteMs 10000`, `maxLoadTimeMs 120000`, `timeoutRetry {maxNumRetry 4, retryDelayMs 0}`, `errorRetry {maxNumRetry 6, retryDelayMs 1000, maxRetryDelayMs 8000}` | For live, a 120 s fragment timeout is far too long: a segment that is not loaded within about 2 × TD is useless. |

**Runtime properties** `[doc]`: `hls.latency` (estimated seconds behind the live edge = `edge + playlistAge - currentTime`), `hls.targetLatency` (get/set), `hls.maxLatency`, `hls.liveSyncPosition`, `hls.drift` (rate at which the playlist edge advances; 1 = nominal), `hls.playingDate` (a `Date` for `currentTime`, from PROGRAM-DATE-TIME).

### 2.1 How the catch-up works `[source]`

On every `timeupdate`, hls.js does the following:

```
distance = latency - targetLatency
if lowLatencyMode && maxLiveSyncPlaybackRate > 1 && live
   && distance > 0.05
   && distance < min(maxLatency, targetLatency + targetduration)   // "in live range", not DVR
   && forwardBuffer > 1 s:
     rate = round20( 2 / (1 + exp(-0.75 * distance - edgeStalled)) )  // logistic, steps of 0.05
     playbackRate = clamp(rate, 1, min(2, maxLiveSyncPlaybackRate))
else playbackRate = 1
```

- At 0.1 s behind target the curve gives 1.05x; at 1 s it gives 1.35x; it approaches 2x. In practice **the cap you set is the rate you get** for any meaningful drift. `[inference from the formula]`
- Being far behind (more than target + 1 TD) is treated as DVR, so there is no speed-up. That case is covered only by the **seek** path (`liveMaxLatencyDuration*`, in `stream-controller.synchronizeToLiveEdge`). Rate catch-up and seek are complementary.
- `targetLatency` silently grows by 1 s per stall (`liveSyncOnStallIncrease`) up to +1 TD. That is the built-in "stalls → back off" behaviour, and it never shrinks back on its own unless you set `hls.targetLatency`.

**Audibility.** On desktop Chromium, `preservesPitch` defaults to true (time-stretching), so 1.05-1.1x is hard to notice in speech and crowd noise, while 1.25x+ is clearly audible. `[memory]` On TVs see section 5: do not use it.

### 2.2 Recommended hls.js presets (TypeScript)

The latency is set in **seconds** with a floor, because "N segments" is wrong for both 1 s and 10 s segments. Since `liveSyncDuration` cannot be mixed with the `*Count` options, compute both from the target duration after the manifest is parsed, or pick conservative constants up front and adjust `hls.targetLatency` on `LEVEL_LOADED`.

```ts
import Hls, { type HlsConfig } from 'hls.js';

export type LatencyMode = 'low' | 'stable';

const isTv = /Tizen|Web0S|webOS|VIDAA/i.test(navigator.userAgent);

const liveLoadPolicy = {
  default: {
    maxTimeToFirstByteMs: 6000,
    maxLoadTimeMs: 20000,           // live segment older than ~2-3 TD is useless
    timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
    errorRetry: { maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 4000 },
  },
};

export function hlsLiveConfig(mode: LatencyMode): Partial<HlsConfig> {
  const common: Partial<HlsConfig> = {
    lowLatencyMode: true,           // harmless on non-LL; needed for parts and rate catch-up
    backBufferLength: isTv ? 10 : 30,
    maxBufferSize: isTv ? 30 * 1000 * 1000 : 60 * 1000 * 1000,
    maxBufferLength: 30,
    liveSyncMode: 'buffered',       // prefer seeking inside the buffer (no refetch)
    liveMaxUnchangedPlaylistRefresh: 6, // frozen-source detector
    fragLoadPolicy: liveLoadPolicy,
    startFragPrefetch: true,
  };
  if (mode === 'low') {
    return {
      ...common,
      liveSyncDuration: 6,           // initial; refined to max(1.5*TD, 4) on LEVEL_LOADED
      liveMaxLatencyDuration: 14,    // seek back if > ~8 s late
      maxLiveSyncPlaybackRate: isTv ? 1 : 1.1, // rate catch-up desktop only
      liveSyncOnStallIncrease: 1,
    };
  }
  return {
    ...common,
    liveSyncDuration: 12,            // initial; refined to max(3*TD, 10)
    liveMaxLatencyDuration: 30,
    maxLiveSyncPlaybackRate: isTv ? 1 : 1.05,
    liveSyncOnStallIncrease: 2,
  };
}

/** Refine target latency once the real TARGETDURATION is known. */
export function attachTargetLatencyTuner(hls: Hls, mode: LatencyMode): void {
  hls.once(Hls.Events.LEVEL_LOADED, (_e, { details }) => {
    if (!details.live) return;
    const td = details.targetduration;
    const holdBack = details.holdBack || 3 * td;
    const target = mode === 'low'
      ? Math.max(1.5 * td, 4)
      : Math.max(holdBack, 10);
    // LL-HLS: if the source signals PART-HOLD-BACK, trust it
    hls.targetLatency = details.partHoldBack && mode === 'low'
      ? details.partHoldBack
      : target;
  });
}
```

Notes:
- `liveMaxLatencyDuration` is read from config at each sync check `[source]`, so it can also be changed at runtime (`hls.config.liveMaxLatencyDuration = ...`). Keep it at least target + 2 TD so you do not seek in a loop.
- "Low" on a 6 s source ends up at about 9 s target, which is the 1.5×TD floor from section 7. On 2 s segments it ends up at the 4 s floor.

---

## 3. mpegts.js 1.8.2: options (read from docs and source)

Docs `[doc]` https://github.com/xqq/mpegts.js/blob/master/docs/api.md; defaults `[source]` https://github.com/xqq/mpegts.js/blob/master/src/config.js.

| Option | Default | Real behaviour (source) |
|---|---|---|
| `isLive` | `false` | Must be true; it disables `lazyLoad` and switches the stash sizing to the live rule. |
| `enableStashBuffer` | `true` | IO stash collects bytes before handing them to the demuxer. Docs: set false "if you need realtime (minimal latency)", but "may stalled if there's network jittering". |
| `stashInitialSize` | docs say 384 KB; **source uses 64 KB** when unset | For live the stash is resized to about 1/8 of the measured normalized speed (KB) and capped at 8 MB, so roughly 125 ms of data at the stream bitrate. Latency cost: about 0.1-0.8 s. `[source]` io-controller.js |
| `liveBufferLatencyChasing` | `false` | **Seek-based.** On every buffered-range update: if `buffered.end - currentTime > MaxLatency`, then seek `currentTime = buffered.end - MinRemain`. Source comment: "(not recommended)". |
| `liveBufferLatencyChasingOnPaused` | `false` | Also chase while paused. Leave off. Pause should keep its position, and we jump to live on resume ourselves. |
| `liveBufferLatencyMaxLatency` | `1.5` s | Trigger. |
| `liveBufferLatencyMinRemain` | `0.5` s | Buffer kept after the jump. |
| `liveSync` | `false` | **Rate-based.** On `timeupdate`: latency > `liveSyncMaxLatency` → `playbackRate = clamp(liveSyncPlaybackRate,1,2)`; between target and max → keep the current rate; ≤ target → back to 1. |
| `liveSyncMaxLatency` | `1.2` s | |
| `liveSyncTargetLatency` | `0.8` s | |
| `liveSyncPlaybackRate` | `1.2` | 1.2x is audible on desktop and mutes audio on Tizen. |
| `autoCleanupSourceBuffer` | `false` | Must be true for long live sessions. |
| `autoCleanupMaxBackwardDuration` / `MinBackwardDuration` | `180` / `120` s | Use 30 / 15 on TVs. |
| `lazyLoad` / `lazyLoadMaxDuration` / `lazyLoadRecoverDuration` | `true` / 180 / 30 | **Ignored when `isLive`** (`if (this._config.isLive \|\| !this._config.lazyLoad) return;`). Our explicit `lazyLoad: false` is harmless but has no effect. |
| `enableWorker` / `enableWorkerForMSE` | `false` / `false` | Transmux in a Worker; MSE in a worker (needs MSE-in-Workers, which old TV Chromium lacks). |
| `deferLoadAfterSourceOpen` | `true` | Keep. |
| `fixAudioTimestampGap` | `true` | Inserts silence on audio PTS gaps. Keep (reduces A/V drift after discontinuities). |
| `reuseRedirectedURL` | `false` | Set true so reconnects skip the redirect hop. |

**Important semantic point:** mpegts.js "latency" is **only the buffer inside the media element** (`buffered.end - currentTime`) `[source]`. It knows nothing about the upstream delay. For a raw TS stream the server pushes in real time, so the buffer comes from two things: the initial burst (if the server bursts at all; a LAN tuner usually does not) and **every stall** (the server keeps sending while we are frozen, so after a stall the buffer, and the latency, are larger by the stall's length). This is the main way latency "drifts" on TS. `[inference]`

Also from source: `StartupStallJumper` seeks to `buffered.start(0)` when playback is stuck before the first buffered range at startup. It is always on, which is good.

### 3.1 Recommended mpegts.js presets

TVs cannot use `liveSync` (rate), so they use the chaser (seek) with wider thresholds, which means few, larger jumps instead of constant 1 s skips. Desktop can use `liveSync` at a gentle rate.

```ts
import mpegts from 'mpegts.js';

export function mpegtsLiveConfig(mode: LatencyMode, isTv: boolean): mpegts.Config {
  const common: mpegts.Config = {
    isLive: true,
    enableWorker: !isTv,                 // test on Tizen 6 / webOS 6 before enabling on TV
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: isTv ? 30 : 60,
    autoCleanupMinBackwardDuration: isTv ? 15 : 30,
    reuseRedirectedURL: true,
    fixAudioTimestampGap: true,
    liveBufferLatencyChasingOnPaused: false,
  };
  if (mode === 'low') {
    return {
      ...common,
      enableStashBuffer: false,          // ~0.1-0.8 s less, more jitter-sensitive
      ...(isTv
        ? { liveBufferLatencyChasing: true,
            liveBufferLatencyMaxLatency: 2.5,   // jump only when > 2.5 s buffered
            liveBufferLatencyMinRemain: 1.0 }
        : { liveSync: true,
            liveSyncMaxLatency: 2.0,
            liveSyncTargetLatency: 1.2,
            liveSyncPlaybackRate: 1.1 }),
    };
  }
  // stable (default for Wi-Fi)
  return {
    ...common,
    enableStashBuffer: true,
    stashInitialSize: 384 * 1024,        // match documented default; faster first frame
    ...(isTv
      ? { liveBufferLatencyChasing: true,
          liveBufferLatencyMaxLatency: 6,     // only correct real drift (after stalls)
          liveBufferLatencyMinRemain: 3 }
      : { liveSync: true,
          liveSyncMaxLatency: 5,
          liveSyncTargetLatency: 3,
          liveSyncPlaybackRate: 1.05 }),
  };
}
```

**Building a startup cushion on TS.** A real-time TS source gives no buffer unless you wait for it. mpegts.js has no "min start buffer" option. For the stable preset, hold `video.play()` until `buffered.end - currentTime ≥ 1.5-2 s` (or 3 s timeout), then play. This costs exactly that much latency once and absorbs Wi-Fi jitter of the same size. `[inference]` Do not combine a start cushion bigger than `liveBufferLatencyMaxLatency`, or the chaser removes it at once.

Use `player.applyConfig()`? Not for these options: the chaser and synchronizer are created once in the engine constructor based on config `[source]` player-engine-main-thread.ts. **Switching preset needs `unload()` + new player**, or simply apply it on the next zap.

---

## 4. dash.js and Shaka Player: worth adding?

**dash.js 5.2.1** `[source]` https://github.com/Dash-Industry-Forum/dash.js/blob/development/src/core/Settings.js
- `streaming.delay.liveDelay` (s, `NaN`), `liveDelayFragmentCount` (`NaN`), `useSuggestedPresentationDelay` (`true`).
- `streaming.liveCatchup`: `maxDrift` (`NaN`; deviation beyond which it **seeks**; -1 disables seek), `playbackRate {min, max}` (`NaN`; min -0.5..0, max 0..1 as fractions), `playbackBufferMin 0.5`, `liveThreshold -1`, `enabled: null` (catch-up is automatic only for low-latency streams; set `true` for normal ones), `mode`: `liveCatchupModeDefault` | `liveCatchupModeLOLP` | `liveCatchupModeStep`.
- A ServiceDescription in the MPD can carry target latency and playback rate (example 4000 ms, 0.96-1.04). `[doc]` https://github.com/Dash-Industry-Forum/dash.js/wiki/Low-Latency-streaming

**Shaka Player 5.2** `[source]` https://github.com/shaka-project/shaka-player/blob/main/lib/util/player_configuration.js
- `streaming.lowLatencyMode: true`, `streaming.liveSync: { enabled: false, targetLatency: 0.5, targetLatencyTolerance: 0.5, maxPlaybackRate: 1.1, minPlaybackRate: 0.95, panicMode: false, panicThreshold: 60, dynamicTargetLatency: { enabled: false, stabilityThreshold: 60, rebufferIncrement: 0.5, maxAttempts: 10, maxLatency: 4, minLatency: 1 } }`.
- `bufferingGoal 10`, `rebufferingGoal 0`, `bufferBehind 30`, `stallEnabled true`, `stallThreshold 1`, `stallSkip 0.1`.
- `dynamicTargetLatency` is the most complete "back off after rebuffers, creep back after stability" logic among the web players. It is worth copying as an idea even if we never ship Shaka.

**Recommendation** `[inference]`: **do not add either now.** DASH is rare in user M3U/Xtream sources; Tizen AVPlay and webOS native already play DASH, and Media3 and libmpv cover it on the other platforms. If a DASH-over-MSE fallback is ever needed, choose **Shaka** (one engine for HLS+DASH, best live-sync logic, actively released) over dash.js. Both need playbackRate disabled on TVs (`maxPlaybackRate: 1`, `minPlaybackRate: 1`), the same as hls.js.

---

## 5. Live edge, drift, "jump to live" UX, and playbackRate on TVs

### 5.1 Why latency drifts upward

1. **Stalls.** Every rebuffer pauses the playhead while the edge moves on. hls.js partly re-syncs (seek if past `maxLatency`), but it also raises `targetLatency` by 1 s per stall. On raw TS, a stall adds its full length to latency permanently. `[source]`/`[inference]`
2. **Clock skew.** The encoder's 27 MHz/90 kHz clock and the TV's audio clock differ by tens of ppm. 50 ppm is 0.18 s per hour, which is negligible for HLS (the playlist gives the edge) but accumulates on 24/7 TS sessions. `[inference]`
3. **Pause / background / screen saver.** Resuming from a pause continues from the old position.
4. **Playlist edge stalls.** If the source stops updating, hls.js `edgeStalled` adds the excess playlist age; `hls.drift` reports a slower edge rate.

### 5.2 Detection: one engine-neutral signal

```ts
export interface LatencySample { behindLiveSec: number | null; bufferAheadSec: number; source: 'pdt' | 'edge' | 'buffer'; }

export function sampleLatency(video: HTMLVideoElement, hls?: Hls): LatencySample {
  const b = video.buffered;
  const bufferAheadSec = b.length ? b.end(b.length - 1) - video.currentTime : 0;
  if (hls) {
    const d = hls.playingDate;                 // from EXT-X-PROGRAM-DATE-TIME
    if (d) {
      const s = (Date.now() - d.getTime()) / 1000;
      if (s > -5 && s < 600) return { behindLiveSec: Math.max(0, s), bufferAheadSec, source: 'pdt' };
    }
    return { behindLiveSec: hls.latency || null, bufferAheadSec, source: 'edge' };
  }
  // native <video> HLS (webOS) or mpegts: seekable end is the best edge we have
  if (video.seekable.length) {
    const edge = video.seekable.end(video.seekable.length - 1);
    if (Number.isFinite(edge)) return { behindLiveSec: edge - video.currentTime, bufferAheadSec, source: 'edge' };
  }
  return { behindLiveSec: null, bufferAheadSec, source: 'buffer' };   // raw TS: only buffer is known
}
```

For Tizen AVPlay: `getStreamingProperty('GET_LIVE_DURATION')` returns the live window (`start|end`, ms) and `getCurrentTime()` gives the playhead. Behind-live = end - current. `[doc]` (from A3) `[inference]` for using it this way; verify on a device.

### 5.3 Correction policy: seek on TV, rate only on desktop

```ts
/** Drift controller: one decision per ~2 s, hysteresis, never during user seek/pause. */
export class DriftController {
  private over = 0;
  constructor(private video: HTMLVideoElement, private targetSec: number,
              private allowRate: boolean, private jumpToLive: () => void) {}

  tick(s: LatencySample): void {
    if (s.behindLiveSec == null || this.video.paused) return;
    const excess = s.behindLiveSec - this.targetSec;
    if (excess > Math.max(4, this.targetSec)) {      // far off: one seek
      if (++this.over >= 2) { this.over = 0; this.jumpToLive(); }
      return;
    }
    this.over = 0;
    if (!this.allowRate) return;                     // TVs: tolerate small drift
    const rate = excess > 1.0 && s.bufferAheadSec > 2 ? 1.05 : 1;
    if (this.video.playbackRate !== rate) this.video.playbackRate = rate;
  }
}
```

- **Seek** (TV default): a single visible skip of a few seconds, preferably inside the buffer (no refetch). Trigger after two consecutive samples over the threshold to avoid flapping. On hls.js prefer setting `liveMaxLatencyDuration` and let hls.js do it (`liveSyncMode: 'buffered'`).
- **Rate** (desktop only): 1.05x with `preservesPitch` is hard to notice. hls.js gives 1.05 by its formula once over target if capped at 1.05-1.1.
- **TV playbackRate status:**
  - Tizen web (`<video>`/MSE): audio drops at ≥1.25x, reported from Tizen 4 to Tizen 9 (one report says a Tizen 8 update fixed it, contradicted by a Tizen 9 duplicate in Apr 2026). Rates of 1.05-1.2 are **untested in public reports**. `[forum]` https://github.com/jellyfin/jellyfin-tizen/issues/117 , https://forum.jellyfin.org/t-jellyfin-on-tizen-samsung-tv-stop-playing-audio-when-playback-speed-is-increased
  - webOS packaged apps: `playbackRate` changes are ignored; LG staff say the native player does not support sound at other rates. `[forum]` https://forum.webostv.developer.lge.com/t/mediaelement-playbackrate-not-working/564 , https://forum.webostv.developer.lge.com/t/lg-webos-tv-playback-speed-problem/3150
  - Tizen AVPlay `setSpeed` is for trick play (not live catch-up). `[memory]`
  - **Device test to add to the Real-TV checklist:** set `video.playbackRate = 1.05` on an MSE live stream on each TV; check whether speed changes and whether audio continues. If both pass on a given model year, allow rate catch-up there behind a capability flag.
- Media3 (`LiveConfiguration` min/max speed) and libmpv (`speed` + `audio-pitch-correction`, default on via scaletempo2 `[memory]`) are the platforms where gentle rate catch-up is safe.

### 5.4 "Jump to live" UX (remote-first)

- **Indicator:** in the player OSD, a "LIVE" pill. It is solid when within target + 1 TD (or within 3 s on TS) and changes to "−X s" plus a "Go live" focus target when further behind. `[inference]`
- **Action per engine:** hls.js `video.currentTime = hls.liveSyncPosition ?? end`; mpegts.js `video.currentTime = buffered.end - minRemain`; webOS native `seekable.end - target`; AVPlay: reconnect (stop + open + prepare), which lands at the default live point, because AVPlay live seek is limited (A3).
- **Automatic jump to live** on resume after pause > 30 s, after the app returns from background, and after a reconnect. This matches TiviMate-style "live TV is live" behaviour. When timeshift exists later, pause must instead keep its position and the pill becomes "−X s".
- OK on the pill = jump. Avoid putting it on a D-pad direction that also zaps.

---

## 6. Showing "X s behind live" with PROGRAM-DATE-TIME

- `EXT-X-PROGRAM-DATE-TIME` "associates the first sample of a Media Segment with an absolute date and/or time". It SHOULD carry a time zone; without one, treat it as UTC. `[doc]` rfc8216bis §4.4.4.6. hls.js exposes `hls.playingDate` for the current position. `[doc]`
- `behind = Date.now() - hls.playingDate`. This is close to **true glass-to-glass** if the packager stamps wall-clock at encode time, unlike `hls.latency`, which only measures distance to the playlist edge (it leaves out encoder + segment + CDN delay). `[inference]`
- **Caveats:** (a) the TV clock must be NTP-synced, which it usually is to within about 1 s `[inference]`; (b) some packagers stamp the time they *published*, not captured, and some send wrong time zones or local time without an offset, which shows up as hours of offset; (c) PDT may jump at discontinuities. **Sanity rule:** accept only −5 s < value < 600 s, otherwise fall back to `hls.latency` and label it "behind stream edge".
- **webOS native does not support `EXT-X-PROGRAM-DATE-TIME`** (A4, `[doc]`), so only edge-based latency is available there. Raw TS has no wall clock in the container (PCR is relative); the TDT/TOT tables in DVB TS carry UTC with 1 s resolution `[memory]`, but mpegts.js does not expose them. Show buffer seconds only.
- **Rounding for display:** whole seconds, and smooth it (EMA over about 5 s) so it does not flicker. Show it in the Diagnostics page always and in the OSD only when > target + 3 s.

---

## 7. Trade-off math: buffer versus stalls

**Segment saw-tooth (HLS).** With target latency L and segment duration S, the newest available segment appears every S seconds, so the forward buffer oscillates between about L - S - t_dl and L - t_dl (t_dl = download time). `[inference]`
- L = 1×S: the minimum buffer is about 0, so any late segment stalls.
- L = 1.5×S: minimum about 0.5×S - t_dl (6 s segments: about 2-3 s; 2 s segments: under 1 s).
- L = 2×S: minimum about S - t_dl (6 s: about 5 s; 2 s: about 1.5 s).
- L = 3×S (default): minimum about 2×S.

So **a seconds floor (about 4 s) matters more than a segment count** for short segments, and for long segments 1.5-2 × S is the sensible "low" setting.

**Wi-Fi.** No primary QoE source I found gives a specific "buffer for Wi-Fi" number. Rule of thumb `[inference]`: home Wi-Fi throughput dips (microwave, neighbour channel, roaming, a TV on 2.4 GHz) typically last from hundreds of ms to a few seconds; a 2.5-4 s minimum buffer covers most of them, while 1 s does not. The stable preset therefore keeps ≥ 3 s minimum buffer (about 10-12 s target on 6 s HLS, about 3 s cushion on TS). The low preset accepts a 1-2 s minimum and should be recommended for wired/LAN sources.

**Why stalls matter more than seconds.** A 1% increase in buffering ratio cut viewing of a 90-minute live event by more than 3 minutes, and live content was the most sensitive. `[doc]` Dobrian et al., SIGCOMM 2011, https://cs.uwaterloo.ca/~brecht/courses/854-http-video-2012/readings/Understanding-the-Impact-of-Video-Quality-on-User-Engagement-SIGCOMM-2011.pdf. A viewer whose rebuffering equals 1% of duration watched about 5% less, and every second of start delay beyond 2 s added about 5.8% abandonment. `[doc]` Krishnan & Sitaraman, IMC 2012, https://groups.cs.umass.edu/ramesh/wp-content/uploads/sites/3/2019/12/Video-stream-quality-impacts-viewer-behavior-inferring-causality-using-quasi-experimental-designs.pdf. Neither paper measured latency-behind-live preference. My inference: **"stable" must be the default**, and "low latency" is an opt-in per source or a global toggle.

**Adaptive back-off (copy the Shaka idea).** Start at the preset target. After each stall, raise the target by 0.5-1 s (hls.js does +1 s per stall up to +1 TD). After 60 s with no stall, step back toward the preset by 0.5 s, never below the floor. Persist the learned target **per source** in local storage (guardrail 7: local only), so the next session starts where this one settled. `[inference]`

---

## 8. Proposed product shape (for a spec)

- **Setting (one, not sprawl):** "Live latency: Stable (default) / Low". Per-source override in the source's edit screen. Copy: "Low keeps you closer to live but may pause more often on Wi-Fi." No sports wording (guardrail 3).
- **Engine mapping:**

| Engine | Stable | Low |
|---|---|---|
| hls.js | target max(3×TD, 10 s), seek past +18 s, rate 1 on TV / 1.05 desktop | target max(1.5×TD, 4 s), seek past +8 s, rate 1 on TV / 1.1 desktop |
| mpegts.js | stash on, start cushion 2 s, chase at 6→3 s (TV) / liveSync 5→3 @1.05 (desktop) | stash off, no cushion, chase 2.5→1 s (TV) / liveSync 2→1.2 @1.1 (desktop) |
| webOS native | default; our DriftController seeks when > target + 4 s | same, tighter threshold |
| AVPlay | `setBufferingParam` FOR_PLAY 4 s (floor), FOR_RESUME 8 s | FOR_PLAY 4 s, FOR_RESUME 5 s; reconnect-to-live on large drift |
| Media3 (later) | `LiveConfiguration` target 3×TD, speeds 1.0 | target 1.5×TD, speeds 0.97-1.03 |
| libmpv (later) | cache 3-5 s | cache 1-2 s, gentle `speed` correction |

- **Telemetry (local Diagnostics only):** behind-live (with its source: pdt/edge/buffer), buffer ahead, stall count and total stall time, current target, preset. Without these numbers neither preset can be tuned on real TVs.

## 9. Open questions for device testing

1. Does `playbackRate = 1.05` keep audio on Tizen 6-10 and webOS 6-25 MSE? (Decides whether TVs get rate catch-up.)
2. Does `enableWorker: true` in mpegts.js work on Tizen 6 (M76) and webOS 6 (M79)? It moves transmuxing off the UI thread, which helps the under-100 ms zap UI.
3. Do LAN tuners burst on connect (a free startup cushion), or send strictly in real time?
4. AVPlay `GET_LIVE_DURATION` format and update rate on live HLS.
5. What fraction of user HLS sources carry a usable PDT? (Log `hls.playingDate != null` in Diagnostics.)

## Sources

- hls.js API docs: https://github.com/video-dev/hls.js/blob/master/docs/API.md
- hls.js config v1.7.3: https://github.com/video-dev/hls.js/blob/v1.7.3/src/config.ts
- hls.js latency controller: https://github.com/video-dev/hls.js/blob/master/src/controller/latency-controller.ts
- hls.js stream controller (synchronizeToLiveEdge): https://github.com/video-dev/hls.js/blob/master/src/controller/stream-controller.ts
- hls.js 1.0.0-rc.5 notes: https://newreleases.io/project/yarn/hls.js/release/1.0.0-rc.5
- mpegts.js API: https://github.com/xqq/mpegts.js/blob/master/docs/api.md
- mpegts.js source: https://github.com/xqq/mpegts.js/tree/master/src (config.js, player/live-latency-chaser.ts, player/live-latency-synchronizer.ts, player/startup-stall-jumper.ts, player/loading-controller.ts, io/io-controller.js)
- dash.js Settings: https://github.com/Dash-Industry-Forum/dash.js/blob/development/src/core/Settings.js ; LL guide https://dashif.org/dash.js/pages/usage/low-latency.html
- Shaka config: https://github.com/shaka-project/shaka-player/blob/main/lib/util/player_configuration.js
- HLS spec draft (rfc8216bis): https://datatracker.ietf.org/doc/html/draft-pantos-hls-rfc8216bis ; RFC 8216: https://www.rfc-editor.org/rfc/rfc8216
- AWS MediaPackage HLS overview: https://docs.aws.amazon.com/mediapackage/latest/userguide/hls-overview.md
- LL latency ranges (vendor): https://www.forasoft.com/learn/ott/articles-ott/low-latency-delivery-ll-hls-ll-dash ; https://blog.blazingcdn.com/en-us/cmaf-and-low-latency-hls-cutting-live-stream-delay
- Tizen playbackRate audio: https://github.com/jellyfin/jellyfin-tizen/issues/117 ; https://forum.jellyfin.org/t-jellyfin-on-tizen-samsung-tv-stop-playing-audio-when-playback-speed-is-increased
- webOS playbackRate: https://forum.webostv.developer.lge.com/t/mediaelement-playbackrate-not-working/564 ; https://forum.webostv.developer.lge.com/t/lg-webos-tv-playback-speed-problem/3150
- Samsung MSE memory: https://forum.developer.samsung.com/t/memory-leak-when-playing-video-via-mse/8704
- QoE: Dobrian et al. SIGCOMM 2011 (link above); Krishnan & Sitaraman IMC 2012 (link above)
