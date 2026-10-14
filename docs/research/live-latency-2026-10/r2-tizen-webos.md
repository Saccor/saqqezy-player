# R2: Lowest live latency and fewest stalls on Samsung Tizen and LG webOS

Research date: 2026-10-14. Scope: client-only playback of the user's own live sources (HLS and raw MPEG-TS over HTTP) on Tizen (AVPlay and MSE in the Tizen web engine) and webOS (native `<video>`/Starfish and MSE).

Builds on `docs/research/playback-and-legal-sources-2026-10.md` section A (A3 and A4 already cover the basic AVPlay and `mediaOption` knobs) and on the current code: `apps/tv/src/video/AvplayPlayer.ts`, `Html5Player.ts` and `engineChoice.ts`.

Tags: `[doc]` = vendor or spec documentation. `[source]` = library source code, README or a vendor engineering blog. `[forum]` = developer forum, issue or anecdote. `[inference]` = my reasoning, to be measured on a TV. `[memory]` = recalled, not re-verified this session.

---

## 0. Answers in one screen

| Question | Short answer |
|---|---|
| Is the AVPlay 4 s FOR_PLAY minimum real? | **Yes, documented:** "The time buffer size must be at least 4 seconds" `[doc]`. Whether a value under 4 is rejected or clamped is undocumented. Try it in a `try` block and measure. |
| Any AVPlay latency/low-latency property? | **None documented.** The `setStreamingProperty` types are COOKIE, USER_AGENT, PREBUFFER_MODE, ADAPTIVE_INFO, SET_MODE_4K, … with no latency entry `[doc]`. The only start-position levers are `ADAPTIVE_INFO` `STARTFRAGMENT` (live) and `START_TIME` `[doc]`. |
| Does AVPlay support LL-HLS? | **Partly, from Tizen 6.0 (2021).** Samsung's HLS tag table lists `EXT-X-PART`, `EXT-X-PART-INF` and `EXT-X-SKIP` as "Version 10 (HLS Low Latency)" since Tizen 6.0, and `EXT-X-PRELOAD-HINT` since Tizen 7.0. HLS v10 is listed for Tizen 8.0+, and v7 for 2.4-7.0 `[doc]`. 2020 (Tizen 5.5) and older have no LL support `[source]`. This only helps if the user's source actually serves LL-HLS. |
| Does AVPlay start live HLS 3 segments back? | **Not documented.** RFC 8216 says a client should not start less than three target durations from the end `[doc]`, and we should assume AVPlay follows it `[inference]`. Measure with `GET_LIVE_DURATION`. |
| Distance to live edge on AVPlay | `getStreamingProperty("GET_LIVE_DURATION")` returns `"start|end"` (ms). Distance = `end - getCurrentTime()`. Seeking must stay inside that window `[doc]`. |
| Catch up with `setSpeed`? | **No.** Only -16..16 in integer steps (±2, 4, 8, 16), implemented as repeated seeks over HTTP `[doc]`. There is no 1.05x-style gentle catch-up on AVPlay. Resync means a seek or a re-prepare. |
| Is MSE + mpegts.js lower latency than AVPlay for raw TS? | **Very likely yes**: mpegts.js keeps 0.5-1.5 s in the element with latency chasing `[source]`, against AVPlay's ≥4 s start buffer `[doc]`. The costs are JS transmuxing on a weak CPU, an FHD cap on MSE `[doc]`, and higher stall risk `[inference]`. |
| TV "game mode"/ALLM from an app? | **Not for a video app.** Tizen has `use.game.mode` metadata (2022+, for WebRTC cloud gaming; apps using it on older models are refused in Seller Office) `[doc]`. AvInfo has no picture-mode API `[doc]`. webOS settings service is read-only with no picture keys `[doc]`. TV processing adds tens of ms, which is irrelevant next to seconds of stream latency `[doc/forum, inference]`. |
| webOS low-latency `mediaOption`? | **Not in the public docs.** The full field list has nothing about delay, buffering or latency (only `playTime.start`, `adaptiveStreaming.*`, `bps.start`) `[doc]`. Native HLS on webOS also refuses playback rates other than 1.0 `[doc]`. |
| Remote input | Tizen: arrows/Enter/Back are delivered automatically. `registerKeyBatch` (2016+) is faster at launch. ChannelUp 427, ChannelDown 428 `[doc]`. The main threat to <100 ms is main-thread contention (transmux, manifest parsing, GC) `[doc other platform / forum]`. |

**What to change in our app (priority order)** `[inference]` unless noted:

1. AVPlay: call `setBufferingParam(FOR_PLAY, 4 s)`, `setBufferingParam(FOR_RESUME, 6-8 s)` and `setTimeoutForBuffering(6-8)` in IDLE before `prepareAsync`. Today `AvplayPlayer.ts` sets none of them, so it runs on the 10 s / 20 s-timeout defaults `[doc]`.
2. AVPlay: add a **live-edge monitor**: poll `GET_LIVE_DURATION` and `getCurrentTime()` every 2-5 s. If the distance exceeds a threshold, `seekTo(end - margin)`, or `stop()` + `prepareAsync()`. Expose it as a "Jump to live" action as well.
3. AVPlay: add a **prepare watchdog** (some live HLS streams never call either `prepareAsync` callback `[forum]`). After N seconds, report `NETWORK` so the supervisor retries or falls back to the HTML5/MSE engine.
4. Offer one user setting, **"Live delay: Low / Balanced / Stable"**, which maps to the buffer values below per engine. Default to Balanced: zero stalls beats one extra second for most viewers.
5. mpegts.js on Tizen/webOS: test `enableStashBuffer: false` and an explicit `liveBufferLatencyMaxLatency`/`MinRemain`, and turn `autoCleanupSourceBuffer` on. **Test `enableWorker: true`** to move transmuxing off the UI thread (it is `false` today).
6. hls.js: set `liveSyncDurationCount: 2` (default 3), `liveMaxLatencyDurationCount: 5`, a small `backBufferLength` (already 30, consider 10 on TVs), and `maxBufferLength: 10-15`. Keep `maxLiveSyncPlaybackRate: 1` on TVs until `playbackRate` is proven on the device.
7. On TVs, prefer **seek-based** catch-up (jump to the edge when far behind) over **rate-based** catch-up. `playbackRate` on Tizen MSE is unverified, and webOS native HLS rejects rates other than 1.0 `[doc]`.

---

## 1. Tizen AVPlay

### 1.1 Buffering knobs (documented)

From the AVPlay API reference `[doc]` (https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/avplay-api.html):

- `setBufferingParam(option, unit, amount)`: **IDLE only**. `option` is `PLAYER_BUFFER_FOR_PLAY` (initial) or `PLAYER_BUFFER_FOR_RESUME` (rebuffer). Unit is seconds only (`PLAYER_BUFFER_SIZE_IN_SECOND`); the byte unit is deprecated from Tizen 5.0. Quote: "The time buffer size must be at least 4 seconds." No maximum is given.
- Defaults: the API reference says "32MB or 10 seconds of playable data, and 20 seconds time-out". The streaming FAQ says "10 second or 15 MB" and "it is not recommended to modify the default values" `[doc]` (https://developer.samsung.com/smarttv/develop/faq/multimedia-streaming.html).
- `setTimeoutForBuffering(seconds)`: allowed in IDLE/READY/PLAYING/PAUSED, with 3-10 s recommended. When it expires, buffering-complete fires anyway (per A3 in the earlier report).
- `stop()` returns to IDLE and **keeps the URI, display area and listeners**, so `prepare()`/`play()` can run again `[doc]` (https://developer.samsung.com/smarttv/develop/guides/multimedia/media-playback/using-avplay.html). This makes a cheap "re-prepare at live edge" possible without `close()`/`open()`. Whether `setBufferingParam` must be re-applied after `stop()` is not stated; re-apply it to be safe.

**Below 4 s?** Not documented. Possible behaviours: an exception (`InvalidValuesError`/`TypeMismatchError`), a silent clamp to 4, or acceptance. Probe it once per device in a `try`, read back latency with `GET_LIVE_DURATION`, and cache the result per firmware `[inference]`. Do not ship below-4 values without measurement.

**Effect on latency** `[inference]`: for live HLS, end-to-end delay behind the encoder is roughly *(segments back from the end × target duration) + FOR_PLAY buffer + segment packaging delay*. With 6 s segments and a 3-segment start, that is about 18 s before AVPlay's own buffer; the 4 s FOR_PLAY floor is not the dominant term. For raw TS over HTTP, many servers burst a few seconds of cached data on connect. The 4 s fills instantly, and latency is set by the server's burst depth, not by our buffer.

### 1.2 Live start position

- `ADAPTIVE_INFO` attributes: `BITRATES`, `STARTBITRATE`, `SKIPBITRATE`, `STARTFRAGMENT` ("for live playback, sets the start fragment number") and `FIXED_MAX_RESOLUTION` `[doc]`. The adaptive-streaming guide also lists `START_TIME`, "Resume time for live streaming", in ms `[doc]` (https://developer.samsung.com/smarttv/develop/guides/multimedia/adaptive-streaming.html).
- Whether `STARTFRAGMENT` is an absolute media-sequence number or an offset from the start of the window is not stated `[doc gap]`. Experiment: fetch the media playlist ourselves (we pre-warm it anyway, see A2.2), read `EXT-X-MEDIA-SEQUENCE` plus the segment count, and pass `STARTFRAGMENT=<last-1>` to start one to two segments from the edge. Measure stall rate before adopting `[inference]`.
- `EXT-X-START` appears in Samsung's tag table, but the cell for its version/since did not parse `[doc, unclear]`. Older (2020) AVPlay had "no start offsets" `[source]` (https://optiview.dolby.com/resources/blog/playback/going-big-screen-exhaustive-list-of-samsung-tizens-avplay-limitations/). It is a server-side tag anyway, so we cannot rely on it.

### 1.3 LL-HLS on AVPlay

Samsung General Specifications, HLS tag table `[doc]` (https://developer.samsung.com/smarttv/develop/specifications/general-specifications.html):

| Tag | Listed as | Since |
|---|---|---|
| `#EXT-X-PART-INF`, `#EXT-X-PART`, `#EXT-X-SKIP` | "Version 10 (HLS Low Latency)" | Tizen 6.0 |
| `#EXT-X-RENDITION-REPORT` | – | Tizen 6.0 |
| `#EXT_X_PRELOAD_HINT` (sic) | – | Tizen 7.0 |
| `EXT-X-SERVER-CONTROL` | listed, version/since cell unparsed | ? |

Protocol versions: HLS v10 on Tizen 8.0/9.0/10.0, v7 on 2.4-7.0, v3 on 2.3 `[doc]`. Third-party lists say 2020 (Tizen 5.5) had "no low latency support … no parts, delta playlists … preload hints" `[source]`. These do not conflict, because Tizen 6.0 is 2021.

Takeaway: if a user's source serves LL-HLS, AVPlay on 2021+ TVs may honour parts; 2023+ adds preload hints; 2024+ (v10) is the safest. Most user playlists are plain HLS or TS, so this is a bonus, not a strategy `[inference]`.

### 1.4 Measuring and fixing drift

- `getStreamingProperty("GET_LIVE_DURATION")` (READY/PLAYING/PAUSED; since Tizen 2.4) returns `"start|end"`. Samsung's own example splits on `|` and seeks only inside that range `[doc]`.
- `seekTo(ms)`: "For LIVE stream case, seek position must be within DVR range" `[doc]`. The FAQ says live HLS seek works if the server keeps past segments `[doc]`. A forum report shows a **freeze on one frame after rewinding live HLS** (no fix posted) `[forum]` (https://forum.developer.samsung.com/t/live-hls-rewind-not-working-avplay-api/1239). Forward seeks to near the edge are less risky than rewinds, but still test.
- `jumpForward(ms)`: "out-of-range results are reset internally to an in-range value" for HTTP streaming `[doc]`. That suggests `jumpForward(60000)` might snap to the edge, but it is untested `[inference]`.
- `setSpeed`: -16x … 16x in fixed steps; over HTTP it is "implemented as repeated seek" `[doc]`. It is not usable for smooth live catch-up.
- `getStreamingProperty("IS_LIVE")` tells live from VOD `[doc]`; since 6.0 an unknown property throws `TypeMismatchError` `[doc]`.

**Resync ladder for AVPlay** `[inference]`:
1. Distance < target + 2 × segment: do nothing.
2. Distance larger, and `end - margin` inside the window: `seekTo(end - margin)`, where margin = 2 × target duration (or 3 s for TS).
3. Seek throws or the picture freezes (position not advancing for 3 s after the seek): `stop()` → re-apply buffering params → `prepareAsync()` → `play()`. A re-prepare starts at the default live point.
4. Still failing: hand over to the supervisor (re-open, then alternate format/engine).

### 1.5 Other AVPlay facts that matter for zapping and stalls

- `setVideoStillMode("true")` "freezes the last frame in the display buffer" `[doc]`. It can be used to keep the previous channel's last frame on screen during a zap (perceived speed) instead of black. Test that it does not survive into the next stream's first frame `[inference]`.
- `restoreAsync` is "preferred over restore because it returns immediately" `[doc]`. For live after resume from background: do not pass 0 as `resumeTime` and do not pass `true` for `bPrepare`, and re-check the URL `[doc]`. Simpler for live: on visibility return, fully re-open `[inference]`.
- An HTML5 video element and AVPlay **cannot play at the same time** `[doc]` (multimedia FAQ Q6). This confirms "one decoder at a time" on Tizen: no warm second player.
- `prepare()` (sync) hangs the UI thread; always use `prepareAsync` `[doc]`. Our code already does.
- Some HLS live streams never call either `prepareAsync` callback `[forum]` (https://forum.developer.samsung.com/t/some-hls-livestreams-not-prepared-by-webapis-avplay-prepareasync/26050). **Add a watchdog.**
- A report of intermittent AVPlay stutter on 2022 models only (2021 and 2023 fine) `[forum]`. Firmware-specific; keep a per-model escape hatch ("Use HTML5 player" setting already exists via `forceHlsJs`/engine choice).
- "Media with higher bit or frame rate than specifications can cause video or audio playback to stall" `[doc]` (2024 TV video specs). A 50/60p 1080 stream with a very high bitrate on a basic model is a legitimate stall cause, not a network one.

### 1.6 Code: AVPlay open with latency profile, watchdog and edge monitor

```ts
type LiveProfile = 'low' | 'balanced' | 'stable';
const AVPLAY_BUFFERS: Record<LiveProfile, { play: number; resume: number; timeout: number }> = {
  low:      { play: 4, resume: 5,  timeout: 5 },   // 4 = documented minimum
  balanced: { play: 4, resume: 8,  timeout: 8 },
  stable:   { play: 6, resume: 12, timeout: 10 },
};

function configureAvplay(av: typeof webapis.avplay, p: LiveProfile, startFragment?: number) {
  const b = AVPLAY_BUFFERS[p];
  // All of these are IDLE-only (setTimeoutForBuffering also works later).
  try { av.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', b.play); } catch { /* log once */ }
  try { av.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', b.resume); } catch {}
  try { av.setTimeoutForBuffering(b.timeout); } catch {}
  const adaptive = ['STARTBITRATE=LOWEST'];            // fastest first frame; ABR climbs after
  if (startFragment !== undefined) adaptive.push(`STARTFRAGMENT=${startFragment}`); // experiment, see 1.2
  try { av.setStreamingProperty('ADAPTIVE_INFO', adaptive.join('|')); } catch {}
}

// Prepare watchdog: some live HLS never calls back.
function prepareWithWatchdog(av: typeof webapis.avplay, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('PLAYER_ERROR_CONNECTION_TIMEOUT')), ms);
    av.prepareAsync(() => { clearTimeout(t); resolve(); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// Live window and distance to the edge (ms), or undefined when not live / not available.
interface LiveWindow { start: number; end: number; distance: number }
function liveWindow(av: typeof webapis.avplay): LiveWindow | undefined {
  try {
    const live = String(av.getStreamingProperty('IS_LIVE')); // raw format undocumented: log it on a device first
    if (live !== '1' && live !== 'true') return undefined;
    const [start, end] = String(av.getStreamingProperty('GET_LIVE_DURATION')).split('|').map(Number);
    const now = av.getCurrentTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(now)) return undefined;
    return { start, end, distance: end - now };
  } catch { return undefined; }
}

// Called every 3 s while playing; thresholds in ms.
function maybeResync(av: typeof webapis.avplay, d: LiveWindow, targetMs: number, marginMs: number) {
  if (d.distance <= targetMs) return 'ok';
  const to = d.end - marginMs;
  if (to > d.start) {
    try { av.seekTo(to, () => {}, () => {}); return 'seek'; } catch { /* fall through */ }
  }
  return 'reprepare'; // caller: stop() → configureAvplay() → prepareWithWatchdog() → play()
}
```

The exact `IS_LIVE` return format is not documented in the parts of the page I could read. Log the raw value on a device first `[inference]`.

---

## 2. Tizen MSE (hls.js / mpegts.js in the Tizen web engine)

### 2.1 Platform facts

- Samsung devices "support the W3C Media Source Extensions (MSE) and Encrypted Media Extensions" `[doc]` (https://developer.samsung.com/smarttv/develop/specifications/media-specifications.html).
- **"MSE supports resolutions up to FHD; it does not support UHD."** This appears in the video spec tables for 2015-2020 and in the 2024 and 2026 tables `[doc]` (https://developer.samsung.com/smarttv/develop/specifications/media-specifications/2024-tv-video-specifications.html). UHD live via MSE is therefore off the table on Tizen; UHD must go through AVPlay. A forum answer claims HEVC lets MSE play 4K `[forum]`, which contradicts the spec. Trust the spec and test.
- HEVC: "Supported only for MKV/MP4/TS containers", FHD Level 4.1 `[doc]`. mpegts.js and hls.js remux to fMP4, so HEVC via MSE is plausible at FHD if `MediaSource.isTypeSupported('video/mp4; codecs="hvc1…"')` says yes `[inference]`. Feature-detect, never assume.
- Hardware decode: MSE on Tizen feeds the TV's hardware decoders. Dolby: MSE "gives access to the audio and video decoders" and its player has "workarounds for limits on how many decoders can run in parallel" `[source]` (https://optiview.dolby.com/resources/blog/playback/how-to-build-a-tizen-tv-streaming-app-choosing-the-right-video-player). A single video decoder is effectively what we get `[inference]`.
- Web engine per year: 2021 Tizen 6.0 = M76, 2022 = M85, 2023 = M94, 2024 = M108, 2025 = M120, 2026 = M130 `[doc]` (from earlier report A3).
- hls.js does not list Tizen as a tested platform, and Shaka only lists 2017 Tizen `[source]` (Dolby blog). We are on our own for QA.

### 2.2 Known Tizen MSE problems

| Problem | Evidence | Mitigation |
|---|---|---|
| Memory climbs during long MSE playback (hls.js and Shaka) until the app crashes; smaller buffers only delay it | `[forum]` https://forum.developer.samsung.com/t/memory-leak-when-playing-video-via-mse/8704 (thread content not fetchable; from search summary) | Small back buffer, `autoCleanupSourceBuffer`, **periodic soft re-open** (e.g. after 60-90 min or when `performance.memory` grows, during a natural pause) `[inference]` |
| hls.js live freezes after 2-4 min on hardware (not on emulator) | `[forum]` https://forum.developer.samsung.com/t/the-content-hls-stops-on-its-own-after-playing-for-some-time/6483 | Stall watchdog (position not advancing) → nudge, then re-open |
| **Playing into a buffered gap stalls, and a seek does not fix it**; Shaka's fix was to jump gaps *before* reaching them on Tizen | `[source]` (2017 Shaka commit, via mirror) https://gitea.mediatoday.ru/viaprog/shaka-player/src/commit/ca640531180b97a8a7bbaccde0e774bdb5934a79 | hls.js: keep `maxBufferHole` default/raise to 0.3-0.5; for mpegts.js, watch `buffered` ranges and pre-jump `[inference]` |
| Tizen 2.4: live freeze after 1 s because a timestamp was truncated to a 32-bit int | `[forum]` https://forum.developer.samsung.com/t/tizen-2-4-smart-tv-gets-stuck-after-1-second-of-live-streaming/21370 | Legacy only (we require Tizen 6.0), but large PTS values from long-running TS streams are worth one test |
| `QuotaExceededError` on append; no API to query SourceBuffer size | `[doc]` https://developer.chrome.com/blog/quotaexceedederror ; hls.js cannot manage disconnected forward ranges `[source]` https://github.com/video-dev/hls.js/issues/5587 | hls.js handles it by flushing; mpegts.js: `autoCleanupSourceBuffer: true`; keep forward buffer short on live |

### 2.3 `playbackRate` on Tizen MSE

No source confirms or denies that `video.playbackRate = 1.05` works smoothly (or with pitch correction) on Tizen MSE `[doc gap]`. Chromium supports it upstream, but TV audio sinks are vendor code `[inference]`.

- mpegts.js `liveSync` (rate-based, `liveSyncPlaybackRate` default 1.2) and hls.js `maxLiveSyncPlaybackRate` (default **1**, verified in hls.js 1.7.3 `dist`) both depend on it `[source]`.
- **Plan:** keep rate-based catch-up off by default on TVs. Use seek-based chasing (`liveBufferLatencyChasing` in mpegts.js, `liveMaxLatencyDurationCount` in hls.js). Add a device test: set `playbackRate=1.1` for 10 s and check that `ratechange` fires, `currentTime` advances at 1.1x, and audio does not drop out or stutter.

### 2.4 Is MSE + mpegts.js lower latency than AVPlay for raw TS?

- mpegts.js is explicitly "optimized for low-latency live stream playback" with "extremely low latency of less than 1 second in the best case" `[source]` (https://github.com/xqq/mpegts.js).
- Its documented knobs `[source]` (https://github.com/xqq/mpegts.js/blob/master/docs/api.md):
  - `enableStashBuffer` (default `true`). Set it to `false` "if you need realtime (minimal latency)".
  - `liveBufferLatencyChasing` (default `false`) with `liveBufferLatencyMaxLatency` 1.5 s and `liveBufferLatencyMinRemain` 0.5 s. This is seek-based.
  - `liveSync` (rate-based), with `liveSyncMaxLatency` 1.2, `liveSyncTargetLatency` 0.8 and `liveSyncPlaybackRate` 1.2.
  - `autoCleanupSourceBuffer` (default `false`), with backward durations of 180/120 s.
  - `lazyLoad` (default `true`). `enableWorker` (default `false`) and `enableWorkerForMSE`.
- AVPlay will not start with less than 4 s buffered `[doc]`, whereas mpegts.js chases to 0.5-1.5 s.
- **Conclusion** `[inference]`: on raw TS, MSE + mpegts.js can sit 2-3 s closer to the edge than AVPlay. The costs:
  1. JS transmuxing per packet on a weak CPU, competing with the UI thread when `enableWorker: false` (our current setting).
  2. An FHD cap.
  3. Less resilience: 0.5 s of buffer cannot absorb Wi-Fi hiccups.
  4. Seek-based chasing produces small visible jumps.
- **Recommendation:** default Tizen raw TS to AVPlay (Balanced profile). Offer MSE/mpegts.js under the "Low" live-delay profile only after it passes device tests (stalls per hour, key latency under load).

### 2.5 Code: engine profiles

```ts
// mpegts.js (Html5Player.startEngine, kind === 'mpegts')
const MPEGTS_PROFILE = {
  low:      { enableStashBuffer: false, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 1.5, liveBufferLatencyMinRemain: 0.5 },
  balanced: { enableStashBuffer: true,  stashInitialSize: 384 * 1024, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 4, liveBufferLatencyMinRemain: 1.5 },
  stable:   { enableStashBuffer: true,  liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 8, liveBufferLatencyMinRemain: 3 },
} as const;

const player = mpegts.createPlayer(
  { type: 'mpegts', isLive: true, url: src },
  {
    ...MPEGTS_PROFILE[profile],
    enableWorker: true,              // test on Tizen 6 (M76) / webOS 6 (Chromium 79): moves transmux off the UI thread
    lazyLoad: false,                 // live: never abort the connection
    autoCleanupSourceBuffer: true,   // TVs: bound SourceBuffer memory
    autoCleanupMaxBackwardDuration: 30,
    autoCleanupMinBackwardDuration: 10,
    liveSync: false,                 // rate-based catch-up off until playbackRate is proven on the device
  },
);

// hls.js live profile (defaults verified in hls.js 1.7.3: liveSyncDurationCount 3, liveMaxLatencyDurationCount Infinity,
// maxLiveSyncPlaybackRate 1, liveSyncMode 'edge', maxBufferHole 0.1, maxBufferSize 60 MB, initialLiveManifestSize 1)
const hls = new Hls({
  lowLatencyMode: false,             // true only if the playlist has EXT-X-PART
  liveSyncDurationCount: profile === 'low' ? 1.5 : profile === 'balanced' ? 2 : 3,
  liveMaxLatencyDurationCount: profile === 'stable' ? 8 : 5, // seek forward when this far behind
  maxLiveSyncPlaybackRate: 1,        // seek, do not speed up, on TVs
  maxBufferLength: 12,
  maxMaxBufferLength: 20,
  backBufferLength: 10,
  maxBufferSize: 30 * 1000 * 1000,   // 1 GB RAM TVs
  maxBufferHole: 0.5,                // jump small gaps early (Tizen gap-stall note)
  startFragPrefetch: true,
  startLevel: 0,                     // lowest first, ABR climbs (fast first frame)
  enableWorker: true,                // default; keep transmux off the UI thread
});
```

Profile values are starting points `[inference]`. Defaults are `[source]`.

### 2.6 Other projects

- The Jellyfin Tizen main client uses HTML5 playback. An AVPlay integration exists on a separate branch and is not merged `[source/search summary]`.
- Moonfin (a Jellyfin client for Tizen/webOS) uses **AVPlay on Tizen** ("buffering is tuned", serialized seeks) and **Starfish via a shared HTML5 video element on webOS**, with hls.js as the last fallback `[source]` (https://github.com/Moonfin-Client/Smart-TV/wiki/Playback-and-Codecs). This is the same split as our app.
- Commercial players (Dolby/THEOplayer) choose MSE/EME on Tizen for control, and describe AVPlay as struggling "with ad insertion and latency" `[source]`.
- TizenTube: not researched in depth (it targets a different use case).

### 2.7 Tizen WASM Player (an option, not for now)

Samsung's Tizen WASM Player is "a more low level alternative to MSE" `[doc]` (https://developer.samsung.com/smarttv/develop/extension-libraries/webassembly/tizen-wasm-player/overview.html):

- The app feeds elementary-stream packets.
- Low-latency mode: the app controls the clock and packets "render immediately". Seek and DRM are unavailable, and **"B-frames cannot be used"**.
- Ultra-low mode: also, "picture enhancements are disabled".

Most broadcast-style H.264/HEVC uses B-frames `[inference]`, so the low-latency modes would break typical live TV. Normal-latency mode buys nothing over MSE, and we would have to write a WASM TS demuxer. **Not worth it for v1.**

---

## 3. Video plane, overlays, and TV picture processing

### 3.1 Video plane vs web layer (Tizen)

- AVPlay renders on a plane beneath the page, through `<object type="application/avplayer">`. Its rect is always in a 1920×1080 space regardless of viewport `[doc]` (using-avplay guide). If the rect changes during playback, the `<object>` style must be updated too `[doc]`.
- Overlays (banner, EPG strip) are composited by the web engine above the plane. Their cost is GPU fill rate and compositing in the graphics plane, not video decode `[inference]`. One Tizen game port went from ~10 to ~20 fps by removing a single overlay canvas stacked on a WebGL canvas `[forum]` (LittleJS discussion via search). For us that means **one canvas, no DOM layers over it, no full-screen semi-transparent scrims** during playback (see A9).
- The MSE `<video>` path on TVs is typically also hole-punched to a video plane rather than GPU-composited `[inference]`. CSS transforms/opacity on the video element may be ignored or expensive. Move the video by rect, never animate it.

### 3.2 Can an app trigger game mode / ALLM / low-latency picture?

- **Tizen:** `<tizen:metadata key="http://samsung.com/tv/metadata/use.game.mode" value="true"/>` exists for **cloud gaming over WebRTC**. It is "supported on 2022 and later TV models only", and apps that define it for older models "cannot be submitted in the Seller Office" `[doc]` (https://developer.samsung.com/smarttv/develop/guides/cloud_gaming/cg_implement_webapp.html). The page does not say it switches picture processing. A video player declaring a game-mode key is off-purpose and a certification risk `[inference]`. **Do not use it.**
- **Tizen AvInfo** has `getVersion`, `getDolbyDigitalCompMode`, `isHdrTvSupport`, `setSubAmpMode` (hotel), and get/set energy saving and eco sensor. **No picture or game mode** `[doc]` (https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/avinfo-api.html).
- `tizen.playerutil.setLatencyMode('LOW'|'MID'|'HIGH')` exists in the **mobile** Web Device API (since 3.0) for the W3C player `[doc]` (https://docs.tizen.org/application/web/api/9.0/device_api/mobile/tizen/playerutil.html). It is not listed for TV. Feature-detect it on a TV out of curiosity, but do not depend on it `[inference]`.
- **ALLM** is an HDMI signal from a source device to a display `[doc]` (https://hdmi.org/spec2sub/autolowlatencymode). A built-in app is not an HDMI source, so it does not apply.
- **webOS:** the Settings Service exposes only `getSystemSettings` (read-only) for `localeInfo`, `option` (`country`, `smartServiceCountryCode2`, `audioGuidance`) and `caption*` keys `[doc]` (https://webostv.developer.lge.com/develop/references/settings-service). No picture or game mode is exposed. `luna://com.webos.service.tv.display` and similar are not public APIs; using them would be a store-rejection risk `[inference]`.

### 3.3 How much delay TV processing adds

RTINGS measures input lag "outside Game Mode" with other settings optimized. It treats under 40 ms as good and about 15 ms as a noticeable difference `[doc]` (https://Rtings.com/tv/tests/inputs/input-lag). One Samsung example quoted on a forum is 63 ms outside game mode `[forum]`. Motion interpolation usually needs game mode off and raises lag `[doc]`.

**Relevance** `[inference]`: 30-120 ms of picture processing is negligible against 4-20 s of stream latency. It applies equally to audio and video (A/V sync is handled by the TV). Do not chase it; mention "Game/Filmmaker mode reduces picture processing" only in a help article about smoothness, if ever.

---

## 4. LG webOS

### 4.1 Native `<video>` (Starfish) for HLS and TS

From the streaming spec `[doc]` (https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm):

- HLS: live seek is supported from webOS 3.0. **"Fast forward/reverse and playback speeds other than 1.0 are not supported."** There is no rate-based catch-up on native HLS.
- Unsupported tags: `EXT-X-PROGRAM-DATE-TIME`, `EXT-X-DATERANGE`, `EXT-X-DISCONTINUITY-SEQUENCE`, `EXT-X-INDEPENDENT-SEGMENTS`, I-frame tags and more. `EXT-X-DISCONTINUITY` works only for PTS discontinuities (4.0+). Audio and video segment durations should match.
- No LL-HLS or CMAF low-latency mention. A Nagra SDK note says its CMAF low-latency mode works on Tizen and webOS from **2020 models** "due to their internal web engine implementation" `[source]` (https://docs.nagra.vision/connect-player-sdk-5-for-browsers/5.20.x/Default/latency-on-live). That suggests MSE + chunked fetch is the only LL path on webOS `[inference]`.
- Progressive MPEG-TS over HTTP is **not listed**, and LG says unlisted formats "are not supported or not recommended" `[doc]`. On webOS raw TS should go to **mpegts.js over MSE**. Our `chooseEngine` already does this when `canPlayType('video/mp2t')` is empty. If a webOS TV reports `maybe`, the native-first-with-fallback path is used. Log which one wins on real hardware.
- The native live start position and buffer depth are undocumented. Assume the RFC 3-target-duration rule `[inference]`, and measure `seekable.end(0) - currentTime` (the Apple-style latency definition) `[inference]`.

### 4.2 `mediaOption` (complete documented list)

From https://webostv.developer.lge.com/develop/guides/mediaoption-parameter `[doc]`:

- `mediaTransportType`
- `option.mediaFormat.type`
- `option.drm.type`/`clientId`
- `option.transmission.playTime.start` (ms, resume)
- `option.adaptiveStreaming.audioOnly`, `adaptiveResolution`, `seamlessPlay`, `maxWidth` (1920), `maxHeight` (1080), and `bps.start` (HLS, webOS 3.0+)

**There is no documented `lowDelay`, `lowLatency`, buffer-time or live-delay option.** Anything else found online is undocumented and must not ship without device testing.

Useful today:

```ts
// Faster first frame + quality cap on webOS native HLS
const mediaOption = encodeURI(JSON.stringify({
  mediaTransportType: 'HLS',
  option: { adaptiveStreaming: { bps: { start: 1_500_000 }, maxWidth: 1920, maxHeight: 1080 } },
}));
const source = document.createElement('source');
source.src = url;
source.type = `application/vnd.apple.mpegurl;mediaOption=${mediaOption}`;
video.appendChild(source);
```

The exact `type` string format follows LG's guide. Verify the `bps.start` units (bps) on a device.

### 4.3 webOS MSE

- MSE is supported from webOS 3.x (2013 Editor's Draft), 4.x (2016 PR), and 5.0-6.0 and 22-26 (2016 Recommendation). webOS 1.x/2.x have none `[doc]`.
- **webOS 4.x (2018-2019) is the weak generation:**
  - "Major: GC" every 5 s during any MSE playback, even a bare `<video>` + `MediaSource`. After an hour the main thread was blocked 4.8 s every 5 s. It affected hls.js, dash.js and Shaka. Destroying the player stopped it. LG gave no fix `[forum]` (https://forum.webostv.developer.lge.com/t/poor-mse-performance-on-webos-4/7852).
  - Stutter at ~14 fps during playback on a 2018 OLED (webOS 4.4) with Shaka; **"webOS 24+ TVs do not exhibit these issues"**. Smaller buffers did not help `[forum]` (https://forum.webostv.developer.lge.com/t/video-stuttering-on-webos-4-x/28288).
- Our minimum is webOS 6 (Chromium 79) per STACK, so 4.x is out of scope. If 4.x support is ever considered, use the native pipeline there and periodic player re-creation `[inference]`.
- An older LG TV (circa 2017) shows 0.5-1.5 s UI response lag in Jellyfin `[forum]` (https://forum.jellyfin.org/t-webos-ux-performance). That is the context for our <100 ms goal on low-end models.

### 4.4 Luna services

No public Luna API for picture/game mode or media latency (see 3.2). The Settings Service is read-only. Moonlight on webOS reaches low latency through native NDL media APIs (homebrew native app) `[source]` (webosbrew), which are not available to store web apps.

---

## 5. Remote key input latency

### 5.1 Tizen

From https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html `[doc]`:

- ArrowLeft/Up/Right/Down, Enter and Back arrive without registration. Everything else needs `tizen.tvinputdevice.registerKey(name)` or, since 2016 models, `registerKeyBatch([...])`, which "can improve application launch time". It needs the `http://tizen.org/privilege/tv.inputdevice` privilege, or a `SecurityError` is thrown `[doc]`.
- Codes: ChannelUp **427**, ChannelDown **428**, digits **48-57**, Minus 189, ChannelList 10073, PreviousChannel 10190, VolumeUp 447/VolumeDown 448. Use `tizen.tvinputdevice.getKey(name).code` rather than constants.
- Long press: on the basic remote, RW click = MediaRewind and long = MediaTrackPrevious; FF click = MediaFastForward and long = MediaTrackNext. On the Smart Remote, Back click = Back and long = Exit `[doc]`.
- A registered key loses its default TV function `[doc]`. Do not register VolumeUp/Down or Mute.
- Repeat behaviour and `event.repeat` are undocumented. Our `keys.ts` already notes that remotes repeat keydown while held without always setting `repeat`, and guards with a timer `[source: our code]`.

### 5.2 webOS

- Back 461; arrows 37-40; OK 13. Long press performs "the alternate key function". The Magic Remote switches between pointer and 5-way mode, and the `cursorStateChange` event tells the app which `[doc]` (https://webostv.developer.lge.com/develop/guides/magic-remote).
- Channel +/- on webOS arrive as PageUp 33 / PageDown 34 `[memory]`. Verify with a key logger.
- Touch remotes (StanbyME-type) do **not** support long press `[forum]` (https://forum.webostv.developer.lge.com/t/issues-detecting-a-long-press-on-some-models/306). Every long-press action (our `LongOk`) needs a non-long-press path, such as the Options/Menu key.
- With an `<input>` focused, the virtual keyboard owns key events and repeated keydowns have been reported; read values from `input`/`change` `[forum]` (https://forum.webostv.developer.lge.com/t/keydown-event-fires-continuously/5513).

### 5.3 Keeping the zap UI under 100 ms

Key delivery itself is fast. What delays it is **a busy main thread**. Amazon's TV guidance names heavy synchronous JS, re-renders and "frequent refresh and parsing of large manifest" in MSE players as causes of delayed key events `[doc, other platform]` (https://developer.amazon.com/docs/vega/0.23/media-player-improve-hls-performance.html). On webOS 4, GC pauses are the extreme case `[forum]`.

`[inference]` checklist:

1. **Do the minimum in keydown:** update the zap banner's text node/texture and return. Resolve the target channel from the in-memory index, never from IndexedDB, inside the handler. The zapper already resolves async and previews on answer; make sure the in-memory path answers in the same frame.
2. **Never open the stream inside the keydown.** Commit after a 150-250 ms debounce (`createZapper` `delayMs`). During a burst, no player work runs at all.
3. **Move transmuxing off the UI thread:** hls.js `enableWorker: true` (default); mpegts.js `enableWorker: true` (currently `false`, so test it). Tizen 6 = M76 and webOS 6 = Chromium 79 support dedicated workers. The no-module-worker-before-80 rule (STACK) matters only if we bundle the worker as a module.
4. **Keep live playlists small in RAM:** hls.js parses each refresh. A long DVR window means big parses every target duration. A cap like `liveMaxLatencyDurationCount` does not shrink parsing, so nothing to tune there, but measure parse time on long-window sources.
5. **Avoid GC spikes:** no per-tick allocations in the clock or progress bar. Update the progress bar at most 1 Hz in full screen (A9 already says keep text static).
6. **AVPlay calls are synchronous bridge calls.** Do not call `getStreamingProperty`/`getCurrentStreamInfo` on every key press or frame. Poll at 1-5 s and cache.
7. **Measure:** record `performance.now() - event.timeStamp` at keydown entry and at the next `requestAnimationFrame` after the banner update. Log p50/p95 to Diagnostics, both idle and while playing (AVPlay vs MSE).

---

## 6. Stall causes on these TVs and mitigations

| Cause | Where | Evidence | Mitigation |
|---|---|---|---|
| Buffer too small for network jitter | All, worst with mpegts.js "low" | `[inference]` | Profiles (Low/Balanced/Stable); auto-step from Low to Balanced after 2 stalls in 10 min |
| Prepare never returns on some live HLS | Tizen AVPlay | `[forum]` | Prepare watchdog → `NETWORK` → supervisor retry or engine fallback |
| Freeze after live seek/rewind | Tizen AVPlay | `[forum]` | Seek only forward to `end - margin`; if position does not advance in 3 s, re-prepare |
| MSE memory growth over long sessions | Tizen MSE, webOS 4 | `[forum]` | `backBufferLength` 10, `autoCleanupSourceBuffer`, soft re-open after long sessions or on memory threshold |
| GC pauses blocking main thread | webOS 4 (platform), any engine with allocation churn | `[forum]` | Out of our webOS 6+ scope; keep hot paths allocation-free |
| Buffered gaps (discontinuity, PCR jumps) | Tizen MSE: stall not fixed by seek | `[source]` | Pre-emptive gap jump; hls.js `maxBufferHole` 0.5; mpegts.js watchdog on `buffered` ranges |
| Codec/PID change mid-stream | webOS native HLS (only PTS discontinuities) | `[doc]` | On `error` after playing has started, re-open with MSE engine (not only at start) |
| Bitrate/frame rate above model spec | Tizen | `[doc]` "can cause video or audio playback to stall" | Quality cap setting; read `streamInfo` (fps, resolution) and warn in Diagnostics |
| UI rendering contention (WebGL fill rate, overlay layers) | Low-end Tizen/webOS | `[forum]` overlay anecdote; `[inference]` | One canvas; 720p UI canvas on low-end; no full-screen alpha; Lightning renders only on change; hide UI fully during playback |
| Wi-Fi throughput/jitter | All TVs | `[inference]`: TV Wi-Fi radios and placement are often weak, and many TVs have only 100 Mbit Ethernet `[memory]` | Show measured throughput vs stream bitrate in Diagnostics; help text: "Ethernet is the most reliable"; start ABR low |
| Model-specific firmware stutter | e.g. 2022 Tizen AVPlay | `[forum]` | Per-device engine override (already exists); collect model + firmware in Diagnostics |
| Background/foreground transitions | Tizen | `[doc]` restore rules | On `visibilitychange` → visible: re-open live streams from the stored URL rather than `restore` |

**Stall watchdog (both platforms)** `[inference]`:

```ts
// Every 1 s while state === 'playing'
const pos = player.position();
if (pos === lastPos) { frozenFor += 1000; } else { frozenFor = 0; lastPos = pos; }
if (frozenFor === 3000) softRecover();  // Html5: seek to buffered.end - margin / hls.startLoad(); AVPlay: seekTo(end - margin)
if (frozenFor === 8000) hardReopen();   // stop() + open(storedUrl) via supervisor (counts towards reconnect cap)
```

---

## 7. Device test plan (what must be measured before tuning)

Use synthetic or self-hosted test streams only, e.g. ffmpeg `testsrc2` with a burned-in wall clock, served as HLS (2 s and 6 s segments) and raw TS from a LAN machine (guardrail 1).

1. **Latency:** photograph the TV next to the encoder clock. Record AVPlay (default buffers, then 4 s FOR_PLAY), AVPlay + `STARTFRAGMENT`, hls.js (sync count 3 / 2 / 1.5), mpegts.js (Low/Balanced) and webOS native.
2. **setBufferingParam < 4:** does it throw, clamp or work?
3. **GET_LIVE_DURATION:** log the raw string, check that `end - getCurrentTime()` tracks the photographed latency, and test `seekTo(end - 2×target)` and `jumpForward(60000)`.
4. **playbackRate on MSE:** 1.05 / 1.1 / 1.2 for 30 s each. Check that `ratechange` fires, that position advances at the rate, and listen to the audio.
5. **Stalls/hour** over 2 h per engine and profile on Wi-Fi and Ethernet, plus memory growth over 2 h (MSE).
6. **Key latency p95,** idle vs playing per engine (5.3 item 7).
7. **HEVC via MSE:** `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"')` and a real FHD HEVC TS through mpegts.js.
8. **`enableWorker: true` for mpegts.js** on Tizen 6 and webOS 6: does it load and play, and does key latency improve?

---

## Sources

Samsung (Tizen)
- AVPlay API: https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/avplay-api.html
- Using AVPlay: https://developer.samsung.com/smarttv/develop/guides/multimedia/media-playback/using-avplay.html
- Adaptive streaming guide: https://developer.samsung.com/smarttv/develop/guides/multimedia/adaptive-streaming.html
- Multimedia Streaming Q&A: https://developer.samsung.com/smarttv/develop/faq/multimedia-streaming.html
- Multimedia Q&A: https://developer.samsung.com/smarttv/develop/faq/multimedia.html
- General Specifications (HLS tags, versions): https://developer.samsung.com/smarttv/develop/specifications/general-specifications.html
- Media specifications / 2024 video specs: https://developer.samsung.com/smarttv/develop/specifications/media-specifications.html , https://developer.samsung.com/smarttv/develop/specifications/media-specifications/2024-tv-video-specifications.html
- Remote control guide: https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html
- AvInfo API: https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/avinfo-api.html
- Cloud gaming web app (use.game.mode): https://developer.samsung.com/smarttv/develop/guides/cloud_gaming/cg_implement_webapp.html
- Tizen WASM Player: https://developer.samsung.com/smarttv/develop/extension-libraries/webassembly/tizen-wasm-player/overview.html , https://developer.samsung.com/smarttv/develop/extension-libraries/webassembly/tizen-wasm-player/tizen-wasm-player-features.html
- Tizen PlayerUtil (mobile): https://docs.tizen.org/application/web/api/9.0/device_api/mobile/tizen/playerutil.html
- Forums: https://forum.developer.samsung.com/t/live-hls-rewind-not-working-avplay-api/1239 ; https://forum.developer.samsung.com/t/some-hls-livestreams-not-prepared-by-webapis-avplay-prepareasync/26050 ; https://forum.developer.samsung.com/t/memory-leak-when-playing-video-via-mse/8704 ; https://forum.developer.samsung.com/t/the-content-hls-stops-on-its-own-after-playing-for-some-time/6483 ; https://forum.developer.samsung.com/t/tizen-2-4-smart-tv-gets-stuck-after-1-second-of-live-streaming/21370 ; https://forum.developer.samsung.com/t/video-playback-stuttering-on-tizen-tv-2022-models/42306

LG (webOS)
- Streaming protocol & DRM: https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm
- mediaOption: https://webostv.developer.lge.com/develop/guides/mediaoption-parameter
- Magic Remote: https://webostv.developer.lge.com/develop/guides/magic-remote
- Settings Service: https://webostv.developer.lge.com/develop/references/settings-service
- Forums: https://forum.webostv.developer.lge.com/t/poor-mse-performance-on-webos-4/7852 ; https://forum.webostv.developer.lge.com/t/video-stuttering-on-webos-4-x/28288 ; https://forum.webostv.developer.lge.com/t/keydown-event-fires-continuously/5513 ; https://forum.webostv.developer.lge.com/t/issues-detecting-a-long-press-on-some-models/306

Libraries and third parties
- mpegts.js README and API: https://github.com/xqq/mpegts.js , https://github.com/xqq/mpegts.js/blob/master/docs/api.md
- hls.js defaults: read from `node_modules/.pnpm/hls.js@1.7.3/.../dist/hls.mjs` (local, v1.7.3); issue #5587: https://github.com/video-dev/hls.js/issues/5587
- Shaka Tizen gap commit (mirror): https://gitea.mediatoday.ru/viaprog/shaka-player/src/commit/ca640531180b97a8a7bbaccde0e774bdb5934a79
- Dolby/THEOplayer: https://optiview.dolby.com/resources/blog/playback/going-big-screen-exhaustive-list-of-samsung-tizens-avplay-limitations/ , https://optiview.dolby.com/resources/blog/playback/how-to-build-a-tizen-tv-streaming-app-choosing-the-right-video-player , https://optiview.dolby.com/resources/blog/playback/leverage-mse-eme-in-lg-webos/
- Nagra CMAF LL note: https://docs.nagra.vision/connect-player-sdk-5-for-browsers/5.20.x/Default/latency-on-live
- Moonfin playback wiki: https://github.com/Moonfin-Client/Smart-TV/wiki/Playback-and-Codecs
- Amazon Vega HLS performance (key latency from manifest parsing): https://developer.amazon.com/docs/vega/0.23/media-player-improve-hls-performance.html
- Chrome QuotaExceededError: https://developer.chrome.com/blog/quotaexceedederror
- RTINGS input lag: https://Rtings.com/tv/tests/inputs/input-lag ; HDMI ALLM: https://hdmi.org/spec2sub/autolowlatencymode
- Jellyfin webOS UX lag thread: https://forum.jellyfin.org/t-webos-ux-performance
