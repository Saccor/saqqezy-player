# R5: Live freezes, stalls, A/V glitches and recovery

Date: 2026-10-14. Scope: client-only recovery engineering for live playback (raw MPEG-TS over HTTP and HLS) on the TV web app (AVPlay, HTML5 + hls.js 1.7.3 + mpegts.js 1.8.2). Later sections cover Media3 and libmpv. No provider, league or broadcaster names appear here (CLAUDE.md rules 2-3), and nothing below needs a server-side proxy (rule 6).

Evidence tags: `[doc]` official docs or spec; `[source]` read in the library source installed in this repo (`node_modules/.pnpm/...`); `[forum]` user or community reports; `[inference]` my engineering judgement; `[memory]` recalled but not re-verified in this session.

---

## 0. TL;DR

1. **Three likely root causes of long freezes are already in our own code:**
   - **mpegts.js is configured to keep almost no buffer.** `liveBufferLatencyChasing: true` with the library defaults (`liveBufferLatencyMaxLatency` 1.5 s, `liveBufferLatencyMinRemain` 0.5 s) seeks forward whenever more than 1.5 s is buffered, leaving 0.5 s. Each chase is a visible skip and audio click, and any network hiccup longer than about 1 s becomes a stall. `[source]`
   - **A clean server close of a TS connection is not handled.** mpegts.js emits `LOADING_COMPLETE` and calls `endOfStream()`. `Html5Player` listens to neither that event nor `ended`, so the supervisor only notices after its 8 s stall watchdog, then waits another 1 s backoff. `[source]`
   - **mpegts.js's fetch loader has no timeout.** `CONNECTING_TIMEOUT` is declared but never raised, so a half-open TCP connection (common on Wi-Fi) hangs silently until our 8 s watchdog fires. `[source]`
2. **The supervisor's escalation is too slow and too coarse for live sports.**
   - The worst-case visible interruption for a dead connection is about 8 s (stall) + up to 1 s (poll granularity) + 1 s (backoff) + reconnect time + time to first frame, so roughly 11-14 s of black or frozen picture.
   - Best practice detects in 1-1.5 s, nudges the playhead at about 1.5 s, reconnects at once (0 ms) when bytes have stopped arriving, and keeps the last frame on screen.
3. **The reconnect budget never decays.** `totalReconnects` is capped at 10 per `play()`, so a three-hour match with 11 recovered hiccups ends in a permanent "unavailable". Replace the cap with a rolling window (a leaky bucket). `[source]` (already in `docs/backlog.md`).
4. **Frozen video with running audio is not detected.** `currentTime` follows the audio clock, so a stuck video decoder looks healthy. Add a frame-progress signal (`getVideoPlaybackQuality().totalVideoFrames` or `requestVideoFrameCallback`). `[doc]`/`[inference]`
5. **Recover inside the engine first, and tear down only as a last resort.**
   - hls.js: `startLoad()` after a fatal network error; `recoverMediaError()` (then `swapAudioCodec()`) after a media error.
   - Media3: `seekToDefaultPosition()` + `prepare()` on BEHIND_LIVE_WINDOW.
   - libmpv: `reconnect_streamed`/`reconnect_at_eof`.
   - Today every fatal error tears down the element and the picture goes black.
6. **Byte flow is the most useful signal we ignore.** mpegts.js's `STATISTICS_INFO.speed`, hls.js `FRAG_LOADING` progress and a TTFB timer separate "the network is dead, reconnect now" from "the network is slow, wait, and switch quality down if this is HLS". The right action differs, so the signals must differ.

---

## 1. Current implementation review

Files read: `packages/player/src/supervisor.ts`, `packages/player/src/types.ts`, `apps/tv/src/video/{Html5Player,AvplayPlayer,engineChoice}.ts`, `apps/tv/src/playback/{controller,playback}.ts`, and the mpegts.js 1.8.2 and hls.js 1.7.3 sources.

### 1.1 Supervisor parameters versus best practice

| Parameter | Now | Best practice / reference | Verdict |
|---|---|---|---|
| Poll interval | 1000 ms | 250 ms (hls.js gap-controller ticks at 100 ms; Shaka's stall detector reacts within 1 s) `[source]`/`[doc]` | Too coarse: adds up to 1 s to every detection |
| Stall threshold | 8000 ms, one level | Tiered: about 1.25 s to call it a stall (hls.js `detectStallWithCurrentTimeMs` = 1250 `[source]`; Shaka `stallThreshold` 1 s `[doc]` https://developer.quickplay.com/docs/products/player/web/advanced-player-configuration), nudge at about 2 s (hls.js `highBufferWatchdogPeriod` = 2 s `[source]`), reconnect at 3-6 s depending on byte flow | Far too slow for a dead socket; about right only as a last-resort backstop |
| First retry delay | 1000 ms | 0 ms for the first reconnect after a mid-play failure (hls.js's `timeoutRetry` uses `retryDelayMs: 0` for fragments and playlists `[source]`); back off only on repeated failure | Wastes 1 s every time |
| Backoff | 1-2-4 s, 3 per URL | 0, 0.5, 1, 2, 4, then a 5 s cap with ±20% jitter; per-URL budget restored after 30 s of stable play (keep) | Reasonable shape; the 0 ms first step is missing |
| Start timeout | 10 s for any start | Split it: **TTFB/no-bytes timeout 4 s**, and a **first-frame timeout of 12-15 s while bytes are arriving** (on-demand origins can take 10-20 s to spin up a channel `[forum]` https://qna.habr.com/user/Alex-rsk/tag_answers?tag=ffmpeg) | 10 s is both too long for a dead host and too short for a slow cold start |
| Total reconnect cap | 10 per `play()`, never decays | Rolling window, e.g. at most 6 reconnects per 60 s and at most 20 per 10 min | Bug for long sessions |
| Recovery action | Always `stop()` + `open()` (black frame on HTML5) | An engine-level soft recover first; keep the last frame during a reconnect | Missing ladder levels |

### 1.2 Bugs and defects found

1. **The mpegts.js latency chaser starves the buffer.** `Html5Player.startEngine` passes `liveBufferLatencyChasing: true` and leaves `liveBufferLatencyMaxLatency` (1.5) and `liveBufferLatencyMinRemain` (0.5) at their defaults.
   - In `live-latency-chaser.ts`, whenever `buffered_end - currentTime > 1.5` it calls a direct seek to `buffered_end - 0.5`. `[source]`
   - A Chinese engineering write-up on the same code family reports that enabling chasing "fixes latency but makes the picture choppier". `[forum]` https://juejin.cn/post/7299037876636663847
   - A forum report of an mpegts.js WebView player that "freezes after 5-10 s because buffered data is exhausted" fits this pattern. `[forum]` https://community.kodular.io/t/need-a-help-for-completing-my-extension-mpeg-ts-player/327258
   - **Fix:** turn chasing off. Use `liveSync` (playback-rate based, no seeks) with a much larger window: `liveSyncMaxLatency` 8, `liveSyncTargetLatency` 5, `liveSyncPlaybackRate` 1.05. Keep `liveBufferLatencyChasing` only as a far backstop: `liveBufferLatencyMaxLatency` 20, `liveBufferLatencyMinRemain` 6 (so if latency grows past 20 s we jump once, leaving 6 s). `[inference]`
2. **Server-side clean close goes unhandled.** For a live stream, mpegts.js turns `EARLY_EOF` into `UNRECOVERABLE_EARLY_EOF` and emits an error, which is handled. A *clean* end of the HTTP body instead goes to `_onLoaderComplete`, which leads to `TransmuxingEvents.LOADING_COMPLETE`, then `mse_controller.endOfStream()`, then `PlayerEvents.LOADING_COMPLETE`. `[source]`
   - The element then plays out its buffer and fires `ended`. Neither is observed, so the supervisor sees "playing" until the watchdog fires 8 s after the position stops.
   - Many origins drop long-lived TS connections on a timer or on a load-balancer idle limit. This is a very common "freeze every N minutes" pattern. `[inference]`
   - **Fix:** in `Html5Player`, for live mpegts, map `mpegts.Events.LOADING_COMPLETE` to `error {code:'NETWORK', message:'EOS'}` immediately, and map element `ended` to the same. Data is still buffered at that moment, so a reconnect started immediately can overlap the remaining buffer. See section 3.4.
3. **There is no loader timeout in mpegts.js.** `LoaderErrors.CONNECTING_TIMEOUT` exists, but `fetch-stream-loader.js` never raises it, and it uses no `AbortSignal.timeout`. A half-open TCP connection (Wi-Fi roam, NAT timeout) makes `reader.read()` wait forever. `[source]`
   - **Fix:** watch byte flow from `STATISTICS_INFO` (`speed` in KB/s, reported every `statisticsInfoReportInterval` = 600 ms `[source]`) or from a `customLoader`. Treat no bytes for 3 s as a dead connection and reconnect at once.
4. **`totalReconnects` never decays.** It is only reset by `play()` or a switch to the alternate URL. `[source]` A long session with sporadic, successfully recovered hiccups therefore becomes `failed: unavailable`.
5. **Every first retry waits 1 s.** `backoffMs[0]` = 1000. After a real disconnect, the fastest reconnect is the best one.
6. **Frozen-video-with-audio is invisible.** `position()` is `video.currentTime`, which is driven by the audio clock when audio is present. A stuck video decoder (common after a codec reconfiguration at a discontinuity on TV MSE stacks `[inference]`) never trips the watchdog.
7. **Any movement counts as progress.** `pos !== lastPos` resets the stall clock. A 0.1 s nudge (hls.js) or a latency-chaser seek resets it, so a "stutter loop" (tiny moves, never real play) can hold off escalation indefinitely. **Fix:** require at least 0.5 s of *forward* media progress within the window, and treat backward jumps separately as a discontinuity signal.
8. **Fatal hls.js errors always cause a full teardown.**
   - For a `NETWORK_ERROR` that is fatal only because the retry policy ran out, `hls.startLoad()` keeps the MediaSource and the last frame.
   - For a `MEDIA_ERROR`, the documented sequence is `recoverMediaError()`, then `swapAudioCodec()` + `recoverMediaError()` if it recurs quickly. `[doc]` https://hlsjs.video-dev.org/api-docs/hls.js.hls.recovermediaerror
   - Today all of these produce `stop()`, `v.removeAttribute('src')`, `v.load()` and a black frame.
9. **The AVPlay buffering parameters are untouched.** The Samsung docs give the default as "32MB or 10 seconds of playable data, and 20 seconds time-out". `setTimeoutForBuffering` "3 to 10 seconds is recommended"; `setBufferingParam` must be called in IDLE with "at least 4 seconds"; `PLAYER_BUFFER_FOR_RESUME` sets how much must be buffered after a rebuffer before play resumes. `[doc]` https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/avplay-api.html
   - On a real-time live TS stream, arrival runs at roughly 1x, so a 10 s resume buffer can mean about 10 s of frozen picture after each rebuffer, unless the origin bursts. `[inference]`
   - **Test on a TV:** `setBufferingParam('PLAYER_BUFFER_FOR_PLAY','PLAYER_BUFFER_SIZE_IN_SECOND',4)`, the same for `RESUME` with 4-5, and `setTimeoutForBuffering(6)`. Measure rebuffer duration and stall frequency.
10. **A synchronous `UNSUPPORTED` throw from `player.open` loses its code** (`catch { this.fail(); }`). This is already in the backlog. With the alternate-URL logic it means an unsupported stream is retried three times before the alternate is tried.

---

## 2. Taxonomy of live freezes: detection signal and best recovery

| # | Cause | What the user sees | Detection signal (client-side) | Best recovery |
|---|---|---|---|---|
| 1 | **Throughput dip** (Wi-Fi contention, ISP congestion) | Rebuffer spinner; HLS may also lose resolution | Bytes still arrive but `speed` < media bitrate; buffer ahead shrinking; hls.js `FRAG_LOAD_EMERGENCY_ABORTED` | HLS: switch down quickly (hls.js does it at `maxStarvationDelay` 4 s `[source]`); raw TS: wait, *do not reconnect* (a reconnect costs more than it saves); with a larger buffer it never shows. `[inference]` |
| 2 | **TCP stall / half-open connection** (Wi-Fi roam, NAT expiry, AP power save) | Picture freezes, no error, ever | **Zero bytes for ≥ 2-3 s** while the buffer drains; `waiting` fires when the buffer runs out | **Immediate reconnect (0 ms)**, ideally *before* the buffer runs out (make-before-break, §3.4). For TS, a new connection *is* the fix. `[inference]` |
| 3 | **Server closes the long-lived TS connection** (idle or max-duration limits, origin restart) | Freeze at a regular interval (e.g. every 10/30/60 min) | mpegts `LOADING_COMPLETE` (clean) or `UNRECOVERABLE_EARLY_EOF` (dirty); element `ended`; AVPlay `onstreamcompleted` (already mapped) | Immediate reconnect while the remaining buffer plays. libmpv: `reconnect_at_eof=1`, `reconnect_streamed=1` `[doc]` (FFmpeg http options, https://ffmpeg.org/pipermail/ffmpeg-cvslog/2024-April/142794.html) |
| 4 | **Segment 404 at the live edge** (the playlist advertises a segment before the origin or CDN has it) | Brief stall, or hls.js skips | hls.js `FRAG_LOAD_ERROR` with 404 on the newest fragment | Do not start closer than 3 target durations from the end (RFC 8216 §6.3.3 `[doc]` https://www.rfc-editor.org/rfc/rfc8216#section-6.3.3; hls.js `liveSyncDurationCount` = 3 `[source]`); retry the fragment after 0.5 × targetDuration; after 1-2 tries jump to the next fragment rather than stall |
| 5 | **Playlist not updating** (stale media playlist) | Plays the buffer out, then a long stall | Two or more unchanged reloads (RFC: "if unchanged, wait one-half the target duration before retrying" `[doc]`); hls.js `liveMaxUnchangedPlaylistRefresh` (default `Infinity`, min clamp 2 `[source]`) | Set `liveMaxUnchangedPlaylistRefresh: 4` so hls.js raises an error, then fail over to a redundant variant or the alternate URL, then reload the manifest |
| 6 | **Behind the live window** (paused or buffering too long, so the playhead's segments have rolled out of the playlist) | Error or endless spinner | Media3 `ERROR_CODE_BEHIND_LIVE_WINDOW` `[doc]`; hls.js: playhead < first segment start, `LEVEL_UPDATED` sliding past | Media3: `seekToDefaultPosition(); prepare()` `[doc]` https://developer.android.com/media/media3/exoplayer/live-streaming. hls.js: `media.currentTime = hls.liveSyncPosition`. AVPlay: re-open (no reliable live seek; `seekTo` must be within the DVR range `[doc]`) |
| 7 | **TS continuity-counter errors / packet loss** | Macroblocking, short glitches, sometimes audio pops | mpegts.js logs the CC discontinuity (not exposed); `droppedVideoFrames` jumps; decode errors | Usually ignore (the decoder conceals it). Reconnect only if a decode error is fatal or the frame counter stops. `[inference]` |
| 8 | **PCR/PTS jumps and discontinuities** (encoder restart, splice, 33-bit PTS wrap every ~26.5 h) | Freeze at a splice, audio dropout, A/V offset | `currentTime` jumps backward or forward by more than 1 s; buffered ranges split into two or more; hls.js `EXT-X-DISCONTINUITY` | HLS: hls.js re-bases timestamps per discontinuity `[doc]`. Raw TS: if the playhead sits in a gap, jump to the next `buffered.start(i)` (mpegts.js only does this at *startup*, via `StartupStallJumper` `[source]`); if timestamps go backward (MSE can't append behind), do a soft reconnect. `[inference]` |
| 9 | **Encoder clock drift vs. player clock** | Either periodic stalls every N minutes (encoder slower, buffer drains) or growing delay (encoder faster) | Trend of `buffered.end - currentTime` over 1-5 min: a steady negative slope with no network loss means drift. MPEG allows ±30 ppm on the 27 MHz clock; drift beyond it slowly fills or empties decoder buffers `[source]` https://www.forasoft.com/learn/audio-for-video/articles-audio/pcr-mpeg-ts-program-clock-reference | Small playback-rate control (0.97-1.03 or tighter, e.g. 0.98-1.02) to hold the buffer target. Media3 does this natively for live (`DefaultLivePlaybackSpeedControl`) `[doc]`; mpegts `liveSync` only speeds up `[source]`, so add our own slow-down. Threshold-based drop/insert causes periodic disturbances `[forum]` https://gitlab.freedesktop.org/gstreamer/gstreamer/-/issues/2681 |
| 10 | **Audio/video buffer imbalance** (one SourceBuffer runs dry first) | Stall although "buffered" looks fine | `sourceBuffers[i].buffered` differ by > 1 s at the playhead; the hls.js gap controller logs it | hls.js nudging; alternate-audio playlists not refreshing is a known stall source `[forum]` https://github.com/video-dev/hls.js/issues/5756. For TS, mpegts `fixAudioTimestampGap: true` (default) fills audio gaps with silence `[source]` |
| 11 | **Decoder error** | Error or a black frame | `MediaError` 3 (DECODE); hls.js `BUFFER_APPEND_ERROR`; AVPlay `PLAYER_ERROR_*` | hls.js `recoverMediaError()` → `swapAudioCodec()` → teardown `[doc]`; HTML5 TS: one reconnect, then switch engine (native ↔ mpegts.js) |
| 12 | **MSE `QuotaExceededError`** (low-RAM TVs) | Stall after minutes | `appendBuffer` throws (code 22) | Evict back buffer: hls.js `backBufferLength` (we set 30) and it lowers `maxMaxBufferLength` on quota errors `[memory]`; mpegts `autoCleanupSourceBuffer` (auto true for live), handles code 22 `[source]`. On 1 GB TVs set `autoCleanupMaxBackwardDuration` 30 s / `Min` 15 s instead of 180/120 s `[inference]` |
| 13 | **Gaps in buffered ranges** | Freeze with "lots buffered" | `buffered.length > 1` and the playhead is at the end of a range | Jump to the next `buffered.start(i) + 0.05` if the gap is < 2-3 s (hls.js `maxBufferHole` 0.1 s, `nudgeOffset` 0.1, `nudgeMaxRetry` 3 `[source]`; Shaka uses `stallSkip` 0.1, or 0 = pause/play on TV `[doc]`) |
| 14 | **Token expiry / signed URL** | Works for N minutes, then 401/403/410 on reconnect | HTTP status on manifest or TS GET | Re-run the full resolve from the stored user URL (A7). Never retry a stale redirect target more than once. Show "Your source refused the stream" |
| 15 | **DNS hiccup** | Reconnect fails quickly (`TypeError` in fetch) | Connect-phase failure with no TTFB | Retry 0 ms, then 500 ms. The browser caches per record TTL `[source]` https://chromium.googlesource.com/chromium/src/+/main/net/dns/host_cache.h. Do not build our own DNS cache in the web app; on Media3/libmpv the OS resolver applies |
| 16 | **Source overload / cold-start origin** | Long black screen on zap; may need 10-20 s | Bytes arrive late or slowly; TTFB long | Give the first frame longer while bytes flow (12-15 s); show progress ("Connecting… / Buffering 40%") |

---

## 3. Minimising the visible interruption

### 3.1 Principles

1. **Detect in about 1 s and act in proportion.** Most hiccups are under 2 s and need either nothing (enough buffer) or a nudge.
2. **Separate "no bytes" from "no progress".** If bytes flow but the playhead does not move, it is a media or gap problem: nudge or skip. If no bytes flow, it is a network problem: reconnect now. If bytes flow slowly, it is a throughput problem: switch quality down (HLS) or wait.
3. **Never show black when you can show the last frame.** A frozen picture with a small spinner feels like a hiccup; black feels like a crash.
4. **Make-before-break.** Start the new connection *while* the old buffer is still playing.
5. **First retry immediately, then back off with jitter.** Cap the rate, not the lifetime.
6. **Stay at the live edge only as far as stability allows.** For sports, 6-10 s behind live with a smooth picture beats 2 s behind with stalls. `[inference]`

### 3.2 Gap-jumping and soft recover

- hls.js already does this through its GapController. `[source]`
  - Stall detection after `detectStallWithCurrentTimeMs` 1250 ms.
  - Skip holes ≤ `maxBufferHole`.
  - Nudge by `nudgeOffset × retry` after `highBufferWatchdogPeriod` 2 s.
  - Fatal `BUFFER_STALLED_ERROR` after `nudgeMaxRetry` 3.
  - Emits `STALL_RESOLVED` (1.7) with a duration; log it for telemetry.
- Recommended hls.js overrides for TVs: `maxBufferHole: 0.5` (TV MSE often leaves small holes at discontinuities `[inference]`), `nudgeMaxRetry: 5`, `highBufferWatchdogPeriod: 1`.
- mpegts.js only jumps at startup (`StartupStallJumper`). **Add our own `GapJumper` for the mpegts and native paths** (§5.2).
- AVPlay: no gap API; rely on its pipeline. Recovery is re-open only.

### 3.3 Retry timing

- hls.js's own design treats timeouts with immediate retry (`retryDelayMs: 0`) and errors with backoff starting at 1 s. `[source]`
- FFmpeg/libmpv's HTTP reconnect doubles the delay starting at 1 s; mpv set `reconnect_delay_max` 7 (about 4 attempts, 11 s total). `[forum]` (mpv commit, quoted via search, unverified against current master)
- Recommendation for the supervisor (mid-play failure): `[0, 500, 1000, 2000, 4000, 5000…]` ms with ±20% jitter, and a per-URL counter that resets after 30 s of stable play.
- For initial-start failures: `[0, 1000, 2000]`, then the alternate URL.
- A *dead* source (4xx) gets no fast loop: one re-resolve, then fail.

### 3.4 Keep the last frame on screen during a reconnect

| Engine | Technique | Notes |
|---|---|---|
| hls.js | `hls.stopLoad(); hls.startLoad(-1)` or `recoverMediaError()`; never `detachMedia` for a network error | The element and its last frame stay. For live, `startLoad(-1)` resumes at the live sync position `[doc]` |
| mpegts.js | **Option A (cheap):** paint the current frame into a 2D `<canvas>` overlay in `videoLayer` (`ctx.drawImage(video,…)`) before `stop()`, and remove it on `playing`. A cross-origin frame taints the canvas but still *displays*; it only blocks pixel readback `[doc]`/`[inference]`. **Option B (best):** two `<video>` elements, A and B. Open the new session on B, swap visibility on B `playing`, then tear down A. Needs two hardware decoders: most 2019+ desktop browsers have them; many TVs allow only one MSE video decoder `[inference]`, so feature-detect and fall back to A | Option A adds about 1 frame of work, cheap even on low-end TVs |
| native `<video src>` | Same canvas snapshot (the element goes black on `removeAttribute('src'); load()`) | |
| AVPlay | `stop()`/`close()` blanks the plane `[inference]`. Overlay: draw a scrim with "Reconnecting…"; on Tizen 6+ multi-instance AVPlay (`webapis.avplaystore`) `[memory]` could support A/B make-before-break; verify on device | |
| Media3 | `prepare()` on the same player keeps the last frame on the SurfaceView until new frames arrive (`keepContentOnPlayerReset` in `PlayerView`) `[memory]` | |
| libmpv | Built-in reconnect inside libavformat keeps the demuxer alive; the last frame stays | |

**Make-before-break for raw TS.** When the byte flow stops but the element still has, say, 3 s of buffer, open a *second* HTTP GET to the same URL in parallel. Splicing two independently timed TS connections into one MSE timeline is fragile (PTS continuity, duplicate data). A pragmatic version is to reconnect early: trigger the reconnect at "zero bytes for 2 s", not at "buffer empty". With a 4-6 s buffer the new stream is often ready (cold TTFB plus first keyframe, about 1-2 s) before the old buffer runs out, and the snapshot overlay covers the swap. `[inference]`

### 3.5 Hedged requests (HLS only)

- The Dean & Barroso "tail at scale" pattern: send a duplicate request if the first exceeds the p95 latency, and use whichever returns first. `[source]` https://blog.acolyer.org/2015/01/15/the-tail-at-scale/
- For HLS fragments: if TTFB > max(1 s, p95 of recent fragment TTFBs) and the buffer is < 2 × targetDuration, issue a second GET for the same fragment (fresh connection) and abort the loser.
- Cost: at most 1 extra request in about 5%. hls.js has no built-in hedging, so it would mean a custom `fLoader` `[inference]`.
- Not applicable to raw TS (that is make-before-break, §3.4).
- Worth it only after the basics; mark it as v2.

### 3.6 Redundant streams and backup URLs

- HLS redundant variants (several `EXT-X-STREAM-INF` with the same attributes and different URIs) and Content Steering pathways are supported by hls.js. Its error controller does "Pathway switch or Redundant failover if possible for fastest recovery" (`SendAlternateToPenaltyBox`). `[source]`
- No app code is needed; just don't disable it.
- User-provided alternates: we already have `alternateUrl` (TS ↔ m3u8). Generalise it to `alternates: string[]` (e.g. the user's own backup source for the same channel, matched by `tvg-id`). Try the next alternate after 2 consecutive failures on the current one, or straight away on `UNSUPPORTED`/4xx. This stays neutral: alternates come only from the user's own playlists (rules 1-2).

### 3.7 Proposed escalation ladder (concrete timings)

The ladder runs on a 250 ms tick. "Progress" means at least 0.5 s of forward media time (and, when available, video frames advancing).

| Level | Trigger | Action | Visible UI |
|---|---|---|---|
| L0 | Engine-internal | hls.js fragment retries and nudges; Media3 / libmpv internal reconnect | None |
| L1 Gap jump | No progress ≥ 1.0 s **and** buffer ahead ≥ 0.5 s (or `buffered.length > 1` with the playhead at a range end) | Seek to `next buffered.start + 0.05`, or `currentTime + 0.1`; max 3 per 30 s | None |
| L2 Edge seek | No progress ≥ 2.0 s with buffer ahead ≥ 1 s after L1, **or** latency > maxLatency | Seek to `buffered.end - targetLatency` (`hls.liveSyncPosition` for hls.js) | Spinner after 1 s of no progress (debounced, so sub-second blips show nothing) |
| L3 Engine soft recover | hls.js fatal NETWORK → `startLoad(-1)`; fatal MEDIA → `recoverMediaError()`, then within 3 s `swapAudioCodec()` + `recoverMediaError()`; Media3 BEHIND_LIVE_WINDOW → `seekToDefaultPosition(); prepare()` | Element kept, last frame kept | Spinner |
| L4 Fast reconnect | **Zero bytes ≥ 2.5 s** (TS) or TTFB > 4 s; **or** EOS/`ended`/`onstreamcompleted` on live; **or** no progress ≥ 4 s with empty buffer; **or** video frames frozen ≥ 3 s while audio plays | Snapshot the frame, re-open the same URL with **0 ms** delay; the next attempts use 0.5/1/2/4 s with jitter | "Reconnecting…" over the frozen frame |
| L5 Alternate / engine switch | 2 consecutive L4 failures on this URL (each failing within the start timeout), or immediately on 401/403/410/`UNSUPPORTED` | Re-resolve from the stored URL (tokens); then the next `alternates[]`; then switch engine (mpegts.js ↔ native ↔ hls.js) | "Trying another stream format…" |
| L6 Give up (soft) | Reconnect budget exhausted (more than 6 L4 in 60 s, or 45 s of continuous failure) | Show the error with **Retry** focused, and keep a slow background retry every 15 s for 5 min while the player screen is open (live sports: the stream often comes back) | Error card; the frozen frame stays dimmed behind it |

The start of each attempt uses its own two timers: **noBytesTimeoutMs 4000** (TTFB) and **firstFrameTimeoutMs 15000** (only while bytes are flowing).

---

## 4. ABR for live stability (HLS only; raw TS has no ABR)

hls.js defaults `[source]`: `abrEwmaFastLive` 3 s, `abrEwmaSlowLive` 9 s (half-lives; the estimate is the *min* of the fast and slow EWMAs, which makes it conservative), `abrEwmaDefaultEstimate` 500 kbps, `abrBandWidthFactor` 0.95 (stay), `abrBandWidthUpFactor` 0.7 (switch up only if bitrate < 0.7 × estimate), `maxStarvationDelay` 4, `maxLoadingDelay` 4, `testBandwidth` true, `startLevel` undefined.

Recommendations `[inference]` unless tagged:

- **Start low, then go up.**
  - Set `abrEwmaDefaultEstimate` from the last measured throughput for this source (persist it per source host in local storage). That gives a fast, sensible first level and avoids a 500 kbps-start-then-climb on a fast LAN.
  - On a cold start with no history, use `startLevel: -1` with `testBandwidth: true` (the default).
- **Avoid oscillation.**
  - Keep the min(fast, slow) EWMA and `abrBandWidthUpFactor` ≤ 0.7.
  - Add a **minimum dwell after a down-switch** (e.g. no up-switch for 20-30 s), using `abrSwitchInterval` (hls.js 1.6+ has this config; default 0 `[source]`) or a custom `abrController`.
  - Up-switch at most one level at a time.
- **Cap the level.** Use `capLevelToPlayerSize: true` in the mini-player; in full screen, cap at "Max quality" (A7). Use `capLevelOnFPSDrop: true` on weak TVs with a dropped-frame threshold.
- **BOLA / buffer-based ABR.**
  - BOLA chooses by buffer level and needs no throughput prediction. `[doc]` https://www.arxiv.org/pdf/1601.06748
  - With live buffers of 6-10 s the buffer signal is thin and noisy; BOLA tends toward lower bitrates and needs the BOLA-U/O variants to stay stable with small buffers. `[doc]` https://par.nsf.gov/servlets/purl/10172494
  - A BBC R&D evaluation of dash.js under latency targets found the hybrid "Dynamic" (throughput at low buffer, BOLA at high buffer) gave the best overall QoE, while other algorithms traded higher quality for more stalls. `[doc]` https://arxiv.org/pdf/2304.13551
  - **Conclusion:** do not implement BOLA. Use throughput EWMA plus a buffer-level guard: never up-switch when the buffer is < 1.5 × targetDuration; switch down early when the buffer is < 1 × targetDuration and falling.
- **Native players (AVPlay/webOS):** only the start bitrate and caps are controllable (`ADAPTIVE_INFO STARTBITRATE=LOWEST|AVERAGE|HIGHEST` `[doc]`). Use `AVERAGE` (or our persisted estimate mapped to `BITRATES=` caps).
- **Media3:** `DefaultBandwidthMeter` + `AdaptiveTrackSelection`. Raise `minDurationForQualityIncreaseMs` for live (e.g. 15 s), keep `bandwidthFraction` 0.7, and seed the initial estimate with `setInitialBitrateEstimate` from history `[memory]`.

---

## 5. Network level

- **Keep-alive and connection reuse.** Browsers and TV web engines reuse HTTP/1.1 connections automatically. Chromium allows 6 connections per host `[source]` https://codereview.chromium.org/164232/patch/1/3. Raw TS uses one long-lived connection; HLS uses manifest + fragment requests on a small pool. Do not add `Connection: close` or cache-busting query strings to fragments (that defeats reuse and the CDN cache). `[inference]`
- **HTTP/2 vs 1.1.** We do not control this (the origin and engine negotiate). HTTP/2's single TCP connection suffers head-of-line blocking on lossy Wi-Fi: one lost packet stalls the manifest *and* the fragment. HTTP/1.1 with 2 connections is often more robust on bad Wi-Fi. Nothing to do client-side in the web app; on Media3, OkHttp/Cronet chooses `[inference]`.
- **DNS.** Rely on the platform cache. On reconnect, a DNS failure surfaces as a connect error: retry it fast (0/500 ms). No custom DNS (and no DoH to third parties: privacy). `[inference]`
- **Request timeouts (HLS fragments).** Set hls.js `fragLoadPolicy.default`:
  - `maxTimeToFirstByteMs` = clamp(2 × targetDuration, 2000, 6000) instead of 10000.
  - `maxLoadTimeMs` = clamp(1.5 × targetDuration × 1000 + 2000, 6000, 20000) instead of 120000.
  - `timeoutRetry {maxNumRetry: 3, retryDelayMs: 0}`; `errorRetry {maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 4000}`.
  - Playlists: `maxTimeToFirstByteMs` 4000, `maxLoadTimeMs` 8000.
  - Rationale: a fragment that takes longer than 1.5 segment durations to arrive cannot keep up anyway. Abort and retry on a fresh connection (often a different CDN node) rather than wait 120 s. `[inference]`
  - Caveat: too-tight timeouts on a slow-but-alive link throw away partial downloads. hls.js's emergency down-switch (`FRAG_LOAD_EMERGENCY_ABORTED`) should act first, so keep `maxLoadTimeMs` ≥ 1.5 × duration. `[inference]`
- **Raw TS.** No per-request timeout makes sense on an endless body. Use **stall-of-bytes** detection: no bytes for 2.5 s means dead. With mpegts.js, use `STATISTICS_INFO.speed` (600 ms cadence) or wrap fetch in a `customLoader` that tracks `lastByteAt` (more precise; and an `AbortController` there can also implement the TTFB timeout).
- **Concurrent fetch.** hls.js loads one fragment at a time per stream type (plus the playlist). Keep it. Prefetching the next fragment in parallel (`startFragPrefetch`) helps only at start. Concurrency is useful just for hedging (§3.5).
- **Wi-Fi vs Ethernet.**
  - Wi-Fi brings jitter, retransmission bursts, roaming gaps of 0.5-3 s and AP power-save. Users widely report that Ethernet or 5 GHz fixes "buffering" `[forum]` (SEO blogs, low-quality, e.g. [third-party IPTV blog link removed, CLAUDE.md rule 2]).
  - Product implication: Diagnostics should show "Network: Wi-Fi/Ethernet" where the platform exposes it (Tizen `webapis.network.getActiveConnectionType()` `[memory]`; webOS connection manager `[memory]`) and the measured throughput vs. stream bitrate. Then the app can say "Your connection delivers 6 Mbps; this stream needs 8 Mbps" without blaming anyone.
- **User-Agent.** Some sources reject unknown user agents (forum reports suggest switching the UA fixes 403s `[forum]` [third-party IPTV blog link removed, CLAUDE.md rule 2]). A per-source "User-Agent" field (already common in comparable players) is legitimate and generic.
  - AVPlay has `setStreamingProperty('USER_AGENT', …)` `[doc]`.
  - Browsers forbid setting `User-Agent` from fetch/XHR, so on the web app this works only where the platform allows it (packaged Tizen/webOS fetch may honour it; verify) `[inference]`.
  - Keep wording neutral; no provider guidance (rule 9).

---

## 6. A/V sync on live

| Issue | Cause | Fix |
|---|---|---|
| Audio dropout at a discontinuity | Audio codec or sample-rate change across a splice; MSE needs `changeType()` or a new SourceBuffer | hls.js handles it via `forceKeyFrameOnDiscontinuity` and per-discontinuity re-basing `[doc]`; on a repeated `BUFFER_APPEND_ERROR`, `swapAudioCodec()` + `recoverMediaError()` `[doc]`. For TS via mpegts.js: reconnect if audio `decodedFrames` stops while video continues `[inference]` |
| Audio slowly drifts from video | Encoder clock drift between the audio sample clock and PCR; small audio gaps after transcoding (e.g. ~111 ms gaps that stall a web player until a manual seek `[forum]` https://emby.media/community/topic/150108-emby-web-live-tv-repeatedly-stalls-after-mp2-to-mp3-transcoding-approximately-111-ms-audio-buffer-gaps/) | mpegts `fixAudioTimestampGap: true` (default; inserts silent frames) `[source]`; hls.js `maxAudioFramesDrift` 1 (drops or duplicates frames past 1 frame of drift) `[source]`. Our GapJumper also covers audio-only holes |
| Constant lip-sync offset | TV audio path (soundbar/ARC latency) | User "Audio delay" setting only on engines that support it (libmpv `audio-delay`, Media3 via a custom AudioSink) `[memory]`; on web TV engines, rely on the TV's own AV-sync setting (A8) |
| A/V desync after a reconnect | New stream, new timeline; usually fine | Nothing; reconnect resets the timeline |
| Audio "chirps" from latency chasing | Seek-based chasing (mpegts `liveBufferLatencyChasing`) and rate changes ≥ 1.1 | Use playback rate ≤ 1.05 (pitch shift is barely audible; browsers preserve pitch by default via `preservesPitch`) `[doc]`/`[inference]`; avoid seeks |

---

## 7. Real-world complaints and what users credit

The forum signal is noisy and dominated by SEO blogs; the patterns below recur across sources. All `[forum]`.

- **"Freezes every few seconds or minutes" → a bigger buffer.** The most-cited fix in comparable players is a "Buffer size" setting (e.g. none/small/medium/large/very large). Users trade about 2 s more zap time for fewer freezes. An Emby user reported a "Large" player buffer "pretty much resolved" freezing on flaky streams. https://emby.media/community/topic/85337-player-buffer-size ; [third-party IPTV blog link removed, CLAUDE.md rule 2]
  - **Design implication:** offer one setting, "Stability: Fast start / Balanced (default) / Maximum stability", mapped to a target buffer (e.g. 2 / 5 / 10 s). This maps to the mpegts `liveSync` target, hls.js `liveSyncDurationCount` (2/3/5), Media3 `targetOffsetMs`, and AVPlay `BUFFER_FOR_RESUME`.
- **"Switching player engine fixed it."** Users of comparable apps switch between ExoPlayer, VLC and the system player per stream. [third-party IPTV blog link removed, CLAUDE.md rule 2] We should do this automatically (L5) and remember the engine that worked per channel. A manual "Player engine: Auto / Alternative" per channel is a reasonable power-user escape hatch (one setting, rule: no sprawl).
- **"Changing the user agent fixed it" (403s).** [third-party IPTV blog link removed, CLAUDE.md rule 2] See §5.
- **"Wired Ethernet / 5 GHz fixed it."** See §5. We can only diagnose it, not fix it.
- **"Freezes but VLC plays it fine."** A web mpegts.js player freezing after 5-10 s while VLC plays the same URL. https://community.appinventor.mit.edu/t/need-help-in-making-app-inventor-mpeg-ts-video-player-extension/174868 This matches our buffer-starvation config (§1.2 #1) and the missing EOS reconnect.
- **"Reconnect after it hangs."** FFmpeg/mpv users report needing `reconnect_streamed`/`reconnect_at_eof`, and that some streams "hang but don't close the TCP connection", so they need a client watchdog. https://ffmpeg.org/pipermail/ffmpeg-user/2025-March/059133.html This supports byte-flow watchdogs (§1.2 #3).
- **"Takes 10-20 s to start sometimes."** On-demand origins wake channels lazily; a 4 s reconnect limit was not enough. https://qna.habr.com/user/Alex-rsk/tag_answers?tag=ffmpeg This supports the split TTFB / first-frame timeouts.
- **Hardware vs software decoding** (Android boxes): "audio plays but video stutters" is fixed by switching the decoder. This only applies to Media3 (the decoder-fallback setting, `setEnableDecoderFallback(true)`) `[memory]`.

---

## 8. TypeScript design

### 8.1 Extend the `Player` contract (packages/player/src/types.ts)

```ts
export interface PlaybackHealth {
  /** Media time in ms (as today). */
  positionMs: number;
  /** Seconds of media buffered ahead of the playhead (0 if unknown). */
  bufferAheadS: number;
  /** Number of disjoint buffered ranges (gap hint); undefined if unknown. */
  rangeCount?: number;
  /** Monotonic count of video frames presented; undefined if the platform can't tell. */
  framesPresented?: number;
  /** ms timestamp (clock.now) of the last network byte received for this stream; undefined if unknown. */
  lastByteAt?: number;
  /** Throughput estimate in bits/s, if known. */
  throughputBps?: number;
  /** Stream bitrate in bits/s, if known. */
  mediaBitrateBps?: number;
}

export type RecoverAction = 'gapJump' | 'seekLiveEdge' | 'softReload';

export interface Player {
  // ...existing members...
  /** Cheap snapshot for the supervisor's 250 ms tick. Must not allocate much. */
  health?(): PlaybackHealth;
  /**
   * Engine-level recovery that keeps the media element / last frame. Resolves true if the action was applied.
   * 'softReload': hls.js startLoad(-1) / recoverMediaError(); mpegts: false (not supported); AVPlay: false.
   */
  recover?(action: RecoverAction): boolean;
  /** Freeze the current frame visually (canvas snapshot) until the next 'playing'. No-op where the plane keeps it. */
  holdLastFrame?(): void;
}

export interface StateDetail {
  code?: 'NETWORK' | 'MEDIA' | 'DECODE' | 'UNSUPPORTED' | 'EOS' | 'AUTH' | 'BEHIND_LIVE';
  message?: string;
  attemptId?: number;
  httpStatus?: number; // when known, for AUTH (401/403/410) mapping
}
```

`EOS` (live end of stream) and `AUTH` become first-class so the supervisor can choose "reconnect at 0 ms" or "re-resolve and switch to an alternate" without guessing.

### 8.2 Supervisor: a policy object and a ladder

```ts
export interface RecoveryPolicy {
  tickMs: number;                 // 250
  minProgressS: number;           // 0.5 forward media seconds counts as progress
  gapJumpAfterMs: number;         // 1000
  maxGapJumpsPer30s: number;      // 3
  edgeSeekAfterMs: number;        // 2000
  noBytesReconnectMs: number;     // 2500 (only when lastByteAt is known)
  emptyBufferReconnectMs: number; // 4000
  frozenVideoMs: number;          // 3000 (frames not advancing while audio/time advances)
  backstopStallMs: number;        // 8000 (old threshold, kept as a backstop when no health() exists, e.g. AVPlay)
  noBytesStartTimeoutMs: number;  // 4000
  firstFrameTimeoutMs: number;    // 15000 while bytes flow
  reconnectDelaysMs: number[];    // [0, 500, 1000, 2000, 4000, 5000]
  jitter: number;                 // 0.2
  perUrlFailuresBeforeAlternate: number; // 2 consecutive failed attempts
  budget: { max: number; windowMs: number }[]; // [{max: 6, windowMs: 60_000}, {max: 20, windowMs: 600_000}]
  stableMs: number;               // 30000 (restores per-URL counter; keep)
  showSpinnerAfterMs: number;     // 1000 (debounce UI)
}

/** Rolling-window limiter replacing the never-decaying totalReconnects. Pure; unit-test with a fake clock. */
export class ReconnectBudget {
  private stamps: number[] = [];
  constructor(private readonly rules: { max: number; windowMs: number }[], private readonly now: () => number) {}
  tryTake(): boolean {
    const t = this.now();
    const longest = Math.max(...this.rules.map((r) => r.windowMs));
    this.stamps = this.stamps.filter((s) => t - s < longest);
    for (const r of this.rules) {
      if (this.stamps.filter((s) => t - s < r.windowMs).length >= r.max) return false;
    }
    this.stamps.push(t);
    return true;
  }
}
```

The decision function is pure, so the ladder is table-testable:

```ts
type Decision =
  | { do: 'none' }
  | { do: 'recover'; action: RecoverAction }
  | { do: 'reconnect'; reason: 'noBytes' | 'emptyBuffer' | 'frozenVideo' | 'eos' | 'backstop' };

export function decide(h: PlaybackHealth, s: WatchState, p: RecoveryPolicy, now: number): Decision {
  const stalledFor = now - s.lastProgressAt;
  if (s.framesStuckSince !== undefined && now - s.framesStuckSince >= p.frozenVideoMs) return { do: 'reconnect', reason: 'frozenVideo' };
  if (stalledFor < p.gapJumpAfterMs) return { do: 'none' };
  if (h.lastByteAt !== undefined && now - h.lastByteAt >= p.noBytesReconnectMs) return { do: 'reconnect', reason: 'noBytes' };
  if (h.bufferAheadS >= 0.5 || (h.rangeCount ?? 1) > 1) {
    if (s.gapJumpsRecent < p.maxGapJumpsPer30s) return { do: 'recover', action: 'gapJump' };
    if (stalledFor >= p.edgeSeekAfterMs) return { do: 'recover', action: 'seekLiveEdge' };
  }
  if (h.bufferAheadS < 0.1 && stalledFor >= p.emptyBufferReconnectMs) return { do: 'reconnect', reason: 'emptyBuffer' };
  if (stalledFor >= p.backstopStallMs) return { do: 'reconnect', reason: 'backstop' };
  return { do: 'none' };
}
```

`WatchState.lastProgressAt` advances only when `positionMs` has moved forward by at least `minProgressS × 1000` since the last anchor. `framesStuckSince` is set when `framesPresented` stays flat while `positionMs` advances. A backward jump of more than 1 s is logged as a discontinuity and resets the anchor without counting as progress.

Supervisor changes:

- Emit `reconnecting` only after `showSpinnerAfterMs`, and only if still not playing, so sub-second blips show no UI.
- On `detail.code === 'EOS'`, reconnect with delay 0.
- On `AUTH`, re-resolve then go to the alternate (no fast loop).
- On `UNSUPPORTED` from a synchronous throw, keep the code (fix backlog bug).
- `alternates: string[]` replaces `alternateUrl`, keeping backwards compatibility through `play(url, alt?)`.

### 8.3 `Html5Player.health()` (sketch)

```ts
health(): PlaybackHealth {
  const v = this.video;
  const t = v.currentTime;
  let ahead = 0; let ranges = 0;
  const b = v.buffered; ranges = b.length;
  for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.05 && b.end(i) > t) { ahead = b.end(i) - t; break; }
  const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : undefined;
  const h: PlaybackHealth = { positionMs: t * 1000, bufferAheadS: ahead, rangeCount: ranges };
  if (q) h.framesPresented = q.totalVideoFrames - q.droppedVideoFrames;
  if (this.lastByteAt !== undefined) h.lastByteAt = this.lastByteAt; // from mpegts STATISTICS_INFO (speed>0) or hls FRAG_LOAD_PROGRESS/FRAG_LOADED
  return h;
}
```

- `getVideoPlaybackQuality` is available across browsers `[doc]` https://developer.mozilla.org/en-US/docs/Web/API/VideoPlaybackQuality/droppedVideoFrames
- `requestVideoFrameCallback` is in Chrome 83+ `[doc]` https://web.dev/articles/requestvideoframecallback-rvfc. It is more precise but needs a per-frame callback; the polled counter is enough at 250 ms.
- Verify that the counters advance on Tizen/webOS MSE; if they stay at 0, omit `framesPresented`. `[inference]`

### 8.4 Engine configuration changes

```ts
// mpegts.js (live)
mpegts.createPlayer({ type: 'mpegts', isLive: true, url }, {
  enableWorker: false,                 // keep (TV Workers + MSE-in-worker support is spotty)
  enableStashBuffer: true,             // smoother IO; default stash is fine for live
  lazyLoad: false,
  liveSync: true, liveSyncMaxLatency: 8, liveSyncTargetLatency: 5, liveSyncPlaybackRate: 1.05,
  liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 20, liveBufferLatencyMinRemain: 6, // far backstop only
  autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 30, autoCleanupMinBackwardDuration: 15, // 1 GB TVs
  statisticsInfoReportInterval: 500,
});
player.on(mpegts.Events.LOADING_COMPLETE, () => this.emit(s, 'error', { code: 'EOS', message: 'Stream ended' }));
player.on(mpegts.Events.STATISTICS_INFO, (i: { speed?: number }) => { if ((i.speed ?? 0) > 0) this.lastByteAt = Date.now(); });
// + element 'ended' → EOS for live sessions
```

The "Stability" preset scales `liveSyncTargetLatency` (2 / 5 / 10) and `MaxLatency` (target + 3).

```ts
// hls.js (live)
new Hls({
  lowLatencyMode: false, backBufferLength: 30,
  liveSyncDurationCount: 3,                 // 'Balanced'; 2 = fast start, 5 = max stability
  liveMaxUnchangedPlaylistRefresh: 4,       // stale playlist → error → failover
  maxBufferHole: 0.5, highBufferWatchdogPeriod: 1, nudgeMaxRetry: 5,
  maxLiveSyncPlaybackRate: 1.05,            // gentle catch-up instead of seek
  abrEwmaDefaultEstimate: persistedEstimateBps ?? 5e5,
  fragLoadPolicy: { default: {
    maxTimeToFirstByteMs: 4000, maxLoadTimeMs: 12000,       // scale with targetDuration once known
    timeoutRetry: { maxNumRetry: 3, retryDelayMs: 0, maxRetryDelayMs: 0 },
    errorRetry: { maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 4000 } } },
  playlistLoadPolicy: { default: {
    maxTimeToFirstByteMs: 4000, maxLoadTimeMs: 8000,
    timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
    errorRetry: { maxNumRetry: 3, retryDelayMs: 500, maxRetryDelayMs: 4000 } } },
});
// Fatal handling: NETWORK → hls.startLoad(-1) once (emit 'buffering', not 'error'); second fatal within 10 s → emit NETWORK.
// MEDIA → recoverMediaError(); if again within 3 s → swapAudioCodec(); recoverMediaError(); third → emit DECODE.
```

AVPlay (call in IDLE, after `open()`, before `prepareAsync`; verify on a TV):

```ts
av.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', 4);
av.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', stabilityPreset === 'max' ? 8 : 4);
av.setTimeoutForBuffering(6);
```

Also add `onbufferingprogress` to `health()` (a percentage), and keep the backstop watchdog. AVPlay exposes no byte or frame counters, so the stall ladder there is: position-flat 3 s while not buffering means reconnect; buffering for longer than 8 s means reconnect.

### 8.5 Telemetry (local only; no URLs)

Keep a ring buffer of the last 50 recovery events in Diagnostics: `{t, level, reason, stalledMs, bufferAheadS, throughputBps, engine}`. This is how we tune thresholds on real TVs without any server (rules 6-7). Log hls.js `STALL_RESOLVED.stalledDuration`.

### 8.6 Test plan (synthetic, rule 1)

Use a local test server (Node, dev-only) that serves an ffmpeg-generated synthetic TS/HLS pattern stream. It must be able to:

- (a) close the connection cleanly every 60 s;
- (b) go silent without closing (half-open);
- (c) throttle to 0.7 × bitrate;
- (d) return 404 for the newest segment;
- (e) freeze the playlist;
- (f) inject a PTS jump of +5 s and −5 s;
- (g) drift the clock by 1000 ppm (ffmpeg `-r` vs. `setpts`);
- (h) return 403 on reconnect.

Assert time-to-recover for each case in unit tests (fake clock and fake `health()`) and in e2e on desktop Chromium. Real-TV runs are added to the existing "Real-TV verification" checklist.

---

## 9. Priority order

1. (Small, high impact) mpegts.js config: chasing off / `liveSync` on, EOS→reconnect, `ended`→reconnect.
2. (Small) Supervisor: 0 ms first retry, rolling `ReconnectBudget`, spinner debounce, 250 ms tick, forward-progress rule, keep the sync `UNSUPPORTED` code.
3. (Medium) `health()` + byte-flow watchdog + frame-freeze detection; the tiered ladder (`decide()`).
4. (Medium) hls.js soft recovery (`startLoad`, `recoverMediaError`/`swapAudioCodec`) and the load-policy tuning.
5. (Medium) Last-frame snapshot overlay during a reconnect.
6. (Small, needs a TV) AVPlay `setBufferingParam`/`setTimeoutForBuffering` measurement.
7. (Product) A "Stability" setting with three presets; `alternates[]` from the user's own playlists; a per-channel remembered engine.
8. (Later) Drift control by slow-down rate (0.98-1.0); hedged fragment requests; A/B dual-video make-before-break where two decoders exist.

## Sources

- hls.js 1.7.3 source: `src/config.ts`, `src/controller/gap-controller.ts`, `src/controller/error-controller.ts` (local `node_modules`) `[source]`; API: https://hlsjs.video-dev.org/api-docs/hls.js.hls.recovermediaerror
- mpegts.js 1.8.2 source: `src/config.js`, `src/player/live-latency-chaser.ts`, `live-latency-synchronizer.ts`, `startup-stall-jumper.ts`, `src/io/io-controller.js`, `fetch-stream-loader.js`, `core/mse-controller.js` `[source]`
- Samsung AVPlay API: https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/avplay-api.html ; FAQ: https://developer.samsung.com/smarttv/develop/faq/multimedia-streaming.html
- Media3 live streaming: https://developer.android.com/media/media3/exoplayer/live-streaming
- RFC 8216 (HLS) §6.3: https://www.rfc-editor.org/rfc/rfc8216
- FFmpeg HTTP reconnect options: https://ffmpeg.org/pipermail/ffmpeg-cvslog/2024-April/142794.html , https://ffmpeg.org/pipermail/ffmpeg-cvslog/2024-April/142795.html
- Shaka-style stall config (third-party wrapper doc): https://developer.quickplay.com/docs/products/player/web/advanced-player-configuration
- Tail at scale summary: https://blog.acolyer.org/2015/01/15/the-tail-at-scale/
- BOLA: https://www.arxiv.org/pdf/1601.06748 ; BOLA small buffers: https://par.nsf.gov/servlets/purl/10172494 ; dash.js latency-target analysis: https://arxiv.org/pdf/2304.13551
- PCR/drift: https://www.forasoft.com/learn/audio-for-video/articles-audio/pcr-mpeg-ts-program-clock-reference ; https://impleotv.com/content/stinspector/help/docs/tests/MpegTS/pcr-pts-drift ; GStreamer skew: https://gitlab.freedesktop.org/gstreamer/gstreamer/-/issues/2681
- MDN VideoPlaybackQuality: https://developer.mozilla.org/en-US/docs/Web/API/VideoPlaybackQuality/droppedVideoFrames ; rVFC: https://web.dev/articles/requestvideoframecallback-rvfc
- Chromium host cache: https://chromium.googlesource.com/chromium/src/+/main/net/dns/host_cache.h ; connections per host: https://codereview.chromium.org/164232/patch/1/3
- Forums: https://juejin.cn/post/7299037876636663847 ; https://community.kodular.io/t/need-a-help-for-completing-my-extension-mpeg-ts-player/327258 ; https://community.appinventor.mit.edu/t/need-help-in-making-app-inventor-mpeg-ts-video-player-extension/174868 ; https://emby.media/community/topic/85337-player-buffer-size ; https://emby.media/community/topic/150108-emby-web-live-tv-repeatedly-stalls-after-mp2-to-mp3-transcoding-approximately-111-ms-audio-buffer-gaps/ ; https://github.com/video-dev/hls.js/issues/5756 ; https://qna.habr.com/user/Alex-rsk/tag_answers?tag=ffmpeg ; https://ffmpeg.org/pipermail/ffmpeg-user/2025-March/059133.html ; [third-party IPTV blog link removed, CLAUDE.md rule 2] ; [third-party IPTV blog link removed, CLAUDE.md rule 2] ; [third-party IPTV blog link removed, CLAUDE.md rule 2]
