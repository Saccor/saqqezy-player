# R3: Native engines (Media3 + libmpv/FFmpeg) tuned for low live delay and no stalls (2026-10)

Scope: Android TV / Fire OS (Kotlin + Media3) and desktop (Tauri + libmpv). This report builds on `docs/research/playback-and-legal-sources-2026-10.md` A5/A6 and does not repeat it. Where A5 gave starting values `[inference]`, this report replaces them with source-verified defaults and mechanisms.

Tags: `[doc]` official docs, `[source]` read directly in the code (androidx/media `release` branch, mpv `master`, FFmpeg `master`, fetched 2026-10-14), `[forum]` issue/thread/third party, `[inference]` my reasoning, `[memory]` recalled and not re-verified this session.

Current Media3: **1.11.1 (2026-09-10)** `[doc]` https://github.com/androidx/media/blob/release/RELEASENOTES.md. The task brief said "~1.8/1.9"; everything below was checked against the 1.11 `release` branch.

---

## 0. Executive findings (read this first)

1. **Media3 does no live-latency control on raw MPEG-TS over HTTP.** `ProgressiveMediaSource` builds a timeline with `isDynamic = false` and no `windowStartTimeMs`. `ExoPlayerImplInternal.shouldUseLivePlaybackSpeedControl()` needs `window.isLive() && window.isDynamic && windowStartTimeMs != TIME_UNSET`. So `LiveConfiguration` and `DefaultLivePlaybackSpeedControl` **do nothing** for `.ts` URLs. Every rebuffer adds to the delay for good, and clock drift builds up. `[source]` We need our own buffer-based catch-up controller (section 1.4).
2. **Media3 HLS speed control is OFF unless we turn it on, and it needs `EXT-X-PROGRAM-DATE-TIME`.** `HlsMediaSource.updateLiveConfiguration()` forces min/max speed to 1.0 when the MediaItem sets no speeds and the playlist has no `HOLD-BACK`/`PART-HOLD-BACK`. `windowStartTimeMs` is set only when the playlist has PDT. Without PDT there is no live-offset control even when we set speeds. `[source]` The default target offset is `3 × EXT-X-TARGETDURATION` unless `EXT-X-START` or server-control hold-back is present. `[source]`
3. **The current `DefaultLoadControl` defaults are already low:** `bufferForPlaybackMs = 1000`, `bufferForPlaybackAfterRebufferMs = 2000` (reduced in 1.6.0), min/max buffer 50 000 ms. `[source]` A5's proposed 500-1000 / 2000-5000 is in the same range. The real decision is max buffer for progressive live (see 1.3).
4. **Fire TV already gets async MediaCodec queueing by default.** That is API 31+ for everyone, plus API 28+ on devices that report `com.amazon.hardware.tv_screen`. `[source]` We do not need to force it.
5. **Do not use PreloadManager for live zapping as designed.** It is built for short-form VOD lists. Preloading a live TS stream either holds a socket open, so stale data piles up as extra delay, or wastes a decoder. Use it at most to the `SOURCE_PREPARED` stage for HLS, or skip it and pre-resolve URLs instead. `[inference]` from `[source]` API.
6. **libmpv has no PCR clock recovery and no automatic live catch-up.** It times video to the audio device clock. The manual tells you to skip ahead manually or use `drop-buffers`. `[doc]` We need a small controller that reads `demuxer-cache-state` and adjusts `speed`, the same design as on Android.
7. **mpv's `low-latency` profile is the wrong default for "zero stalls".** It sets `cache-pause=no`, `audio-buffer=0` and `vd-lavc-threads=1`. `[source]` That is good for webcams and bad for sports over the internet. Ship a "Balanced" profile as the default and offer "Lowest delay" as an option.
8. **Window `setPreferMinimalPostProcessing` (ALLM/Game mode) is meant for games and video calls, not TV.** It switches the TV into game mode, which usually turns off motion smoothing, noise reduction and other processing. That cuts display lag (tens of ms) but changes the picture. Don't enable it by default. Offer it at most as an advanced "Game mode on TV" toggle. `[doc]` + `[inference]`

---

## 1. Media3 (Android TV / Fire OS)

### 1.1 `DefaultLivePlaybackSpeedControl`: exact algorithm `[source]`

Source: https://github.com/androidx/media/blob/release/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/DefaultLivePlaybackSpeedControl.java

| Constant | Default | Meaning |
|---|---|---|
| `DEFAULT_FALLBACK_MIN_PLAYBACK_SPEED` | 0.97 | Used when neither MediaItem nor media sets a minimum |
| `DEFAULT_FALLBACK_MAX_PLAYBACK_SPEED` | 1.03 | Same, maximum |
| `DEFAULT_MIN_UPDATE_INTERVAL_MS` | 1000 | Speed is recomputed at most once a second (a rebuffer resets the timer) |
| `DEFAULT_PROPORTIONAL_CONTROL_FACTOR` | 0.1 | `speed = 1 + 0.1 × errorSeconds`, then clamped |
| `DEFAULT_TARGET_LIVE_OFFSET_INCREMENT_ON_REBUFFER_MS` | 500 | Each rebuffer adds 500 ms to the target offset, capped at `maxOffsetMs` |
| `DEFAULT_MIN_POSSIBLE_LIVE_OFFSET_SMOOTHING_FACTOR` | 0.999 | Smoothing of the "smallest offset we could have had" estimate |
| `DEFAULT_MAX_LIVE_OFFSET_ERROR_MS_FOR_UNIT_SPEED` | 20 | Within ±20 ms, the speed is exactly 1.0 |

How it moves the target:
- **After a rebuffer** (`notifyRebuffer`): `currentTarget += 500 ms` (capped at max offset). The player therefore settles further behind live after every stall. This trades delay for stall resistance automatically.
- **Moving back toward live:** every update it computes `minPossibleOffset = liveOffset − bufferedDuration`. It smooths this with a filter that rises immediately but decays slowly (factor 0.999), and tracks a smoothed deviation. `safeOffset = smoothedMin + 3 × smoothedDeviation` (about 99% confidence). If the current target is above `safeOffset`, it is lowered gradually: no lower than `max(safeOffset, idealTarget)`, and by at most what the speed range can recover per interval. Net effect: after a stall the target drops back toward the configured `targetOffsetMs` only as the network shows it can hold a smaller buffer. That takes minutes at 0.999.
- **Speed:** `1 + 0.1 × (liveOffset − target)` in seconds, clamped to `[min, max]`. With the default clamp of ±3%, a 2 s error is corrected at 1.03x, which takes about 67 s. That is slow but inaudible.

Tuning for sports (`[inference]`):
- Keep `proportionalControlFactor` at 0.1 and the max speed ≤ 1.04-1.05. Media3 time-stretches audio with pitch kept (Sonic), but above about 1.05 crowd noise and commentary start to sound off. The docs warn that higher factors are "more audible". `[doc]`
- Set `targetLiveOffsetIncrementOnRebufferMs` to 500-1000 for "Stable" mode and 250 for "Low delay". Never 0 on bad networks: 0 means the player keeps aiming at the same edge and stalls again.
- `minPossibleLiveOffsetSmoothingFactor`: 0.999 for Stable, 0.99 for Low delay (moves back to live faster, higher stall risk). `[doc]` describes this trade-off.

```kotlin
val liveSpeed = DefaultLivePlaybackSpeedControl.Builder()
    .setFallbackMinPlaybackSpeed(0.97f)
    .setFallbackMaxPlaybackSpeed(1.04f)
    .setProportionalControlFactor(0.1f)
    .setTargetLiveOffsetIncrementOnRebufferMs(if (lowDelay) 250 else 750)
    .setMinPossibleLiveOffsetSmoothingFactor(if (lowDelay) 0.99f else 0.999f)
    .setMinUpdateIntervalMs(1_000)
    .build()
```

### 1.2 `LiveConfiguration` for HLS: what actually takes effect `[source]`

Source: `HlsMediaSource.getTargetLiveOffsetUs / updateLiveConfiguration / onPrimaryPlaylistRefreshed`, https://github.com/androidx/media/blob/release/libraries/exoplayer_hls/src/main/java/androidx/media3/exoplayer/hls/HlsMediaSource.java

- Target offset priority: MediaItem `targetOffsetMs` > global `DefaultMediaSourceFactory.setLiveTargetOffsetMs` > `EXT-X-START` > `PART-HOLD-BACK` (LL-HLS) > `HOLD-BACK` > **`3 × target duration`**. `[doc]` + `[source]`
- Speed control is **disabled** (min = max = 1.0) unless the MediaItem sets `minPlaybackSpeed`/`maxPlaybackSpeed` or the playlist has hold-back. So for ordinary HLS we must set the speeds ourselves.
- Even then it only runs if `windowStartTimeMs` is known, which **requires `EXT-X-PROGRAM-DATE-TIME`** (`hasProgramDateTime ? startTimeUs : TIME_UNSET`). Diagnostics should show "PDT: yes/no" per stream, because it decides whether Media3 can hold a delay at all. Without PDT, fall back to our own buffer controller (1.4); it works for HLS too.
- The default start position is `duration + liveEdgeOffset − targetOffset`, snapped to the preceding segment start (or independent part). Starting with a smaller `targetOffsetMs` (for example `1.5 × targetDuration`) is the Media3 version of hls.js `liveSyncDurationCount = 1-2`. The start then snaps to the segment *before* that point. With 6 s segments the real start offset lands somewhere between 1.5 and 2.5 segments behind the edge. `[inference]`
- Fixed in 1.11.0: "unconfigured live streams (`liveConfiguration == UNSET`) were queued as `STREAM_TYPE_BUFFERED`". `[doc]` Use ≥ 1.11.

```kotlin
fun liveItem(uri: String, segHintMs: Long?, mode: DelayMode): MediaItem {
    val target = when (mode) {            // segHintMs: EXT-X-TARGETDURATION if we know it from a pre-fetch
        DelayMode.LOW      -> (segHintMs ?: 4_000) * 3 / 2
        DelayMode.BALANCED -> (segHintMs ?: 4_000) * 2
        DelayMode.STABLE   -> C.TIME_UNSET  // let the media decide (3 × TD)
    }
    return MediaItem.Builder()
        .setUri(uri)
        .setLiveConfiguration(
            MediaItem.LiveConfiguration.Builder()
                .setTargetOffsetMs(target)
                .setMinOffsetMs(if (mode == DelayMode.LOW) 2_000 else C.TIME_UNSET)
                .setMaxOffsetMs(60_000)
                .setMinPlaybackSpeed(0.97f)   // enables speed control for non-LL HLS
                .setMaxPlaybackSpeed(1.04f)
                .build())
        .build()
}
```

**BehindLiveWindowException:** A5 already covers `seekToDefaultPosition(); prepare()`. Add: count these in Diagnostics. Repeated ones mean the window is too short for our target, so raise the target.

### 1.3 `DefaultLoadControl` for live `[source]`

Current defaults (1.11): `DEFAULT_MIN_BUFFER_MS = 50_000`, `DEFAULT_MAX_BUFFER_MS = 50_000`, `DEFAULT_BUFFER_FOR_PLAYBACK_MS = 1000`, `DEFAULT_BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS = 2000`, `DEFAULT_TARGET_BUFFER_BYTES = LENGTH_UNSET` (computed from track types), `DEFAULT_PRIORITIZE_TIME_OVER_SIZE_THRESHOLDS = false`, back buffer 0. There are also local-playback variants and `DEFAULT_TARGET_BUFFER_BYTES_FOR_PRELOAD`. 1.9.0 added `setPlayerTargetBufferBytes(String, int)` and a maximum-memory cap on the automatic calculation. 1.11.0 "reduces the OOM risk of `prioritizeTimeOverSizeThresholds`". `[doc]`

Key insight for live (`[inference]`):
- For **HLS live**, the buffer can never be larger than (live edge − position). With a 3-segment target, `max` is effectively capped by the stream. Leaving 50 s is harmless; the live offset controller is what decides the delay.
- For **progressive live TS**, the buffer *is* the delay we added. The source arrives at real-time rate, so the buffer level stays at whatever was built up at start plus every stall since. If `maxBufferMs` is small, the loader stops reading and the backlog moves into TCP/server buffers, where we cannot see it or catch it up. **Keep `maxBufferMs` large (≥ 30 s) so any backlog shows up in `totalBufferedDuration` and our controller (1.4) can play it off.** Do not use a small max buffer to "force low delay".
- `bufferForPlaybackMs` (start/zap): 500 ms for LOW, 1000 (default) for BALANCED. Below 500 ms a single long GOP or audio-only gap at start causes an immediate rebuffer.
- `bufferForPlaybackAfterRebufferMs`: this is the stall-resistance knob. 2000 (default) for BALANCED, 3000-4000 for STABLE. Each rebuffer adds this much to the delay on progressive TS, until our controller removes it.
- 1 GB RAM TVs: set `setTargetBufferBytes` explicitly (e.g. 24-32 MB) with `setPrioritizeTimeOverSizeThresholds(false)` on low-RAM boxes, so a 20 Mbps stream with a 30 s max cannot grow to 75 MB. On high-RAM boxes, `true`.

```kotlin
val loadControl = DefaultLoadControl.Builder()
    .setBufferDurationsMs(
        /* minBufferMs */ 15_000,
        /* maxBufferMs */ 30_000,
        /* bufferForPlaybackMs */ if (lowDelay) 500 else 1_000,
        /* bufferForPlaybackAfterRebufferMs */ if (stable) 3_500 else 2_000)
    .setTargetBufferBytes(if (isLowRam) 32 * 1024 * 1024 else C.LENGTH_UNSET)
    .setPrioritizeTimeOverSizeThresholds(!isLowRam)
    .setBackBuffer(0, false)
    .build()
```

### 1.4 Raw MPEG-TS over HTTP (continuous live TS)

**How Media3 treats it** `[source]`:
- `ProgressiveMediaPeriod`: `isLive = !isLengthKnown && seekMap.getDurationUs() == TIME_UNSET`, which sets `DATA_TYPE_MEDIA_PROGRESSIVE_LIVE`. `ProgressiveMediaSource` publishes `isDynamic = false, useLiveConfiguration = isLive`. As shown in section 0, the live speed controller never runs.
- `TsExtractor`: the duration reader runs only when the input length is known. Live TS gets `SeekMap.Unseekable`, so the stream cannot be seeked (seeks go to 0, which means reconnect). `DEFAULT_TIMESTAMP_SEARCH_BYTES = 600 × 188`.
- Modes: `MODE_SINGLE_PMT` (the default in `DefaultExtractorsFactory`), `MODE_MULTI_PMT` (ISO 13818-1 behaviour, one timestamp adjuster per program), `MODE_HLS`. For SPTS from a tuner or gateway, keep SINGLE_PMT. For a full MPTS (rare, some SAT>IP setups), MULTI_PMT plus track selection.
- **Prepare waits for a format on every declared track:** `maybeFinishPrepare()` returns early while any `SampleQueue.getUpstreamFormat() == null`. A PMT that declares an audio PID which never carries data blocks prepare forever ("stuck buffering"). That is why `FLAG_IGNORE_AAC_STREAM` / `FLAG_IGNORE_H264_STREAM` exist. `[source]` Our watchdog should catch "STATE_BUFFERING before first frame > N s" and retry with ignore flags or the mpegts.js/hls fallback.
- 1.6.0 fixed "TS streams can get stuck on some devices"; 1.9.0 fixed an `IllegalArgumentException` for PES without timestamps; 1.11.0 last-frame rendering. `[doc]`

**`DefaultTsPayloadReaderFactory` flags** `[source]` + troubleshooting `[doc]` https://developer.android.com/media/media3/exoplayer/troubleshooting:

| Flag | Use for live TS |
|---|---|
| `FLAG_ALLOW_NON_IDR_KEYFRAMES` | H.264 recovery-point / open-GOP streams with no IDR. **Big zap win on streams with rare IDRs:** decoding starts at the first I-slice instead of waiting for an IDR. Cost: brief corruption at start. Default ON for live TS (`[inference]`). |
| `FLAG_DETECT_ACCESS_UNITS` | Streams with no AUD NAL units. They otherwise "get stuck buffering". Only cost is CPU. Default ON. |
| `FLAG_IGNORE_SPLICE_INFO_STREAM` | Skip SCTE-35 parsing. ON (we don't use it). |
| `FLAG_ENABLE_HDMV_DTS_AUDIO_STREAMS` | DTS in M2TS-style streams. Turns off SCTE subtitle detection. OFF by default; retry flag. |
| `FLAG_IGNORE_AAC_STREAM` / `FLAG_IGNORE_H264_STREAM` | Retry flags when the PMT declares a stream with no packets (prepare hang). |
| `FLAG_OVERRIDE_CAPTION_DESCRIPTORS` | Not needed. |

```kotlin
val tsFlags = DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES or
              DefaultTsPayloadReaderFactory.FLAG_DETECT_ACCESS_UNITS or
              DefaultTsPayloadReaderFactory.FLAG_IGNORE_SPLICE_INFO_STREAM
val extractors = DefaultExtractorsFactory()
    .setTsExtractorMode(TsExtractor.MODE_SINGLE_PMT)
    .setTsExtractorFlags(tsFlags)
val tsSource = ProgressiveMediaSource.Factory(httpFactory, extractors)
    // default 1 MiB: how often the loader yields to LoadControl. Smaller = finer control
    .setContinueLoadingCheckIntervalBytes(256 * 1024)
    .createMediaSource(MediaItem.fromUri(url))
// Same flags for HLS-TS:
val hlsFactory = HlsMediaSource.Factory(httpFactory)
    .setExtractorFactory(DefaultHlsExtractorFactory(tsFlags, /* exposeCea608WhenMissingDeclarations */ true))
```

**Delay drift on progressive TS** (`[inference]`, mechanism from `[source]` above, field report `[forum]` https://github.com/google/ExoPlayer/issues/5604):
- Sources of growing delay: (a) start buffer; (b) every rebuffer (the server keeps sending, and we resume from where we stopped); (c) clock drift. ExoPlayer's clock is the AudioTrack position, so the device audio crystal sets the pace and nothing locks it to the encoder's PCR. A 50 ppm mismatch is about 4.3 s per day: tiny for a match, relevant for a box that stays on one channel all day. If the device clock is *faster* than the encoder, the buffer slowly drains instead, which causes periodic micro-rebuffers.
- ExoPlayer issue #5604 reports exactly this ("latency kept building after buffering"). The workaround there (drop packets + `seekToDefaultPosition`) is not available for unseekable TS, so the options are speed catch-up or reconnect.

**Our controller (works for progressive TS, and for HLS without PDT):**

```kotlin
/** Keeps buffered-ahead (≈ the delay we added) near a target by nudging speed. */
class BufferCatchUp(
    private val player: ExoPlayer,
    private val targetMs: Long,          // e.g. 1500 LOW, 3000 BALANCED, 6000 STABLE
    private val hysteresisMs: Long = 700,
    private val maxSpeed: Float = 1.04f,
    private val hardResetMs: Long = 20_000, // backlog beyond this: re-open = jump to live
    private val onHardReset: () -> Unit,
) {
    private val handler = Handler(player.applicationLooper)
    private var catchingUp = false
    private val tick = object : Runnable {
        override fun run() {
            if (player.isPlaying && !audioIsPassthroughOrTunneled()) {
                val buffered = player.totalBufferedDuration
                when {
                    buffered > targetMs + hardResetMs -> onHardReset()
                    buffered > targetMs + hysteresisMs -> catchingUp = true
                    buffered < targetMs -> catchingUp = false
                }
                val want = if (catchingUp)
                    (1f + 0.02f * ((buffered - targetMs) / 1000f)).coerceIn(1.01f, maxSpeed)
                    else 1f
                if (player.playbackParameters.speed != want) player.setPlaybackSpeed(want)
            }
            handler.postDelayed(this, 500)
        }
    }
    fun start() = handler.post(tick)
    fun stop() { handler.removeCallbacks(tick); player.setPlaybackSpeed(1f) }
}
```

Notes: only ever *speed up*; never slow down below 1.0 on live (no edge to protect for progressive). On a stall, the player's own rebuffer wait (`bufferForPlaybackAfterRebufferMs`) is the protection. Re-opening the URL to jump to live costs one zap; only do it for big backlogs (≥ 20 s), for example after a long pause. `audioIsPassthroughOrTunneled()`: speed changes are not applied to AC3/E-AC3 passthrough or offload audio, and tunneled mode has its own rules (KEY_OPERATING_RATE). In those modes use hard reset only. `[inference]`, and the tunneling doc says variable speed in tunnel mode needs operating-rate handling `[doc]`.

### 1.5 HLS specifics

- **Chunkless preparation**: on by default; prepares from the multivariant playlist when `CODECS` is present. Turn it off only for undeclared muxed CEA-608, at a start-up cost. `[doc]` https://developer.android.com/media/media3/exoplayer/hls
- **LL-HLS**: Apple LL-HLS supported (blocking reload, preload hints except open-ended byteranges, delta updates); the community variant is not. `[doc]` Speed control turns on automatically when `PART-HOLD-BACK` exists. 1.11.0 fixed an audio discontinuity when resuming LL live playback. `[doc]` No configuration is needed from us.
- `HlsMediaSource.Factory.setTimestampAdjusterInitializationTimeoutMs(...)` exists `[source]`. It is useful if a stream's first segments stall waiting for a timestamp adjuster on multi-rendition streams. Leave the default unless you see hangs.
- Playlist hygiene (PDT, `DISCONTINUITY-SEQUENCE`, a long window, `INDEPENDENT-SEGMENTS`) is in A5. Add: **PDT is needed for delay control** (finding 2).

### 1.6 Tunneled playback

What it does `[doc]` https://source.android.com/docs/devices/tv/multimedia-tunneling:
- Compressed video goes to a hardware decoder, and the HWC shows frames on its own schedule against the audio clock (VOD) or a tuner PCR/STC (Android 11+ broadcast). It gives "more accurate frame cadence and sync" with no app-side frame scheduling jitter.
- Limits: no frame access; the first frame is held until audio starts unless `PARAMETER_KEY_TUNNEL_PEEK` is set (Media3 handles the first-frame render since 1.3.1 `[doc]`); **an audio underrun stalls video**; timestamp gaps are handled by the OEM (negative gap stalls, positive gap drops frames); pause support is OEM-dependent.
- Media3: `TrackSelectionParameters.Builder.setTunnelingEnabled(true)`. Only active when exactly one audio and one video renderer support tunneling for the selected formats. The javadoc warns: "Tunneling is known to have many device specific issues and limitations. Manual testing is strongly recommended" (cites ExoPlayer #9661, #9133, #9317, #9502). `[source]`
- Fire TV `[doc]` https://developer.amazon.com/docs/fire-tv/4k-tunnel-mode-playback.html: recommended for **4K60**, because app-side rendering cannot reliably hit a 16 ms cadence. Fire OS 6+; sticks support VP9/HEVC tunneling; Fire TV smart TVs H.264/H.265/VP9; the Cube 2nd gen supports it only on secure decoders; some 2018 TVs have PCM limits. Fire OS 14+: move to Media3.

Recommendation `[inference]`: **Off by default; Auto-on for ≥ 50 fps UHD on Fire TV and for devices on a tested allow-list.** Tunneling does not reduce delay meaningfully, and it makes catch-up speed changes harder. Its benefit is smoothness (judder on 50p sports) on weak SoCs. Expose "Smooth 50/60 fps (tunneled)" in Advanced, and log `isTunnelingEnabled` in Diagnostics.

### 1.7 MediaCodec knobs

- **Async queueing:** on by default on API 31+, and on Fire TV (API 28+ with the `com.amazon.hardware.tv_screen` feature). `[source]` `DefaultMediaCodecAdapterFactory.shouldUseAsynchronousAdapterInDefaultMode`. `forceEnableMediaCodecAsynchronousQueueing()` (API 23+) is an A/B experiment for older Android TV boxes (API 28-30 non-Amazon) that show dropped frames.
- `experimentalSetMediaCodecAsyncCryptoFlagEnabled` is only for DRM on API 36. Not relevant (we play clear streams). `[source]`
- **`setEnableDecoderFallback(true)`**: if the primary (hardware) decoder fails to initialise, for example when it is still held by a previous instance after a fast zap, try the next one. **Turn ON.** A software H.264 decoder at 1080p is better than an error screen. `[source]`
- Media3 already sets `KEY_PRIORITY = 0` (realtime) and `KEY_OPERATING_RATE` in `MediaCodecVideoRenderer.getMediaFormat`. `[source]`
- **`KEY_LOW_LATENCY`** (API 30, decoder must advertise `FEATURE_LowLatency`) `[memory]`: Media3 does **not** set it (no reference in the renderers `[source]`). It removes decoder-internal output delay, typically a few frames, which is ≤ 100 ms and nothing like the seconds of network buffer. It can be added by overriding the protected `getMediaFormat(...)`:

```kotlin
class LowLatencyVideoRenderer(/* same ctor args as MediaCodecVideoRenderer */) : MediaCodecVideoRenderer(/*...*/) {
    override fun getMediaFormat(format: Format, codecMimeType: String, codecMaxValues: CodecMaxValues,
        codecOperatingRate: Float, deviceNeedsNoPostProcessWorkaround: Boolean,
        tunnelingAudioSessionId: Int): MediaFormat =
        super.getMediaFormat(format, codecMimeType, codecMaxValues, codecOperatingRate,
            deviceNeedsNoPostProcessWorkaround, tunnelingAudioSessionId).apply {
            if (Build.VERSION.SDK_INT >= 30 && codecSupportsLowLatency) setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
        }
}
// Register via DefaultRenderersFactory.buildVideoRenderers(...) override. If prewarming is enabled,
// also override buildSecondaryVideoRenderer(...) (javadoc requirement) [source].
```
Verdict: an experiment behind a flag, measured with `zapTimings`. Not part of v1. `[inference]`

- **Surface vs texture:** use `SurfaceView` (`PlayerView` default `surface_type="surface_view"`). It is required for tunneling and HDR, and it uses the hardware overlay with lower power and no GPU copy. `TextureView` only if we must animate or transform the video in the UI (the mini-preview); on TVs that costs a GPU composition pass per frame. `[doc]` (Media3 UI docs) `[memory]`
- **`setVideoChangeFrameRateStrategy`**: default `ONLY_IF_SEAMLESS`. For `CHANGE_FRAME_RATE_ALWAYS`, set `OFF` and call `Surface.setFrameRate` yourself. `[source]` javadoc in `ExoPlayer.java`. Recent fixes in 1.9.1-1.11: codec discard on frame-rate change below API 30, and a better frame-rate estimator that accounts for dropped frames. `[doc]` For "Match frame rate: Always", expect a 1-3 s HDMI blank on each zap between 50 and 60 Hz content. Sports viewers zapping between 50i and 60p channels will hate that, so the default stays Seamless.
- **Scrubbing mode / seek parameters**: `setScrubbingModeEnabled` (1.8+) is for timeline dragging (timeshift/catch-up UI later), not live. `setSeekParameters(SeekParameters.CLOSEST_SYNC)` makes timeshift seeks snap to keyframes and start instantly. `[source]`
- **Dynamic scheduling** is on by default since 1.11.0 `[doc]`. It lowers render-loop wakeups (less CPU on weak boxes). Keep it.
- **Renderer prewarming** (`experimentalSetEnableMediaCodecVideoRendererPrewarming`, 1.6+) prewarms a *secondary* video codec for the next playlist item. Recent fixes: stall with a non-transitioning secondary renderer (1.11.1), Surface handback (1.11.1), crash on decoder-error recovery (1.10.1). `[doc]` It only helps playlist transitions in one player, so it is not useful for zapping (we replace the item, not transition). Leave it off.

### 1.8 Android ALLM / "game mode": `Window.setPreferMinimalPostProcessing`

- API 30+. Asks the display to minimise post-processing. Over HDMI the device sends InfoFrames with **ALLM on and Content Type = Game**. Check support with `Display.isMinimalPostProcessingSupported()`. Android docs pitch it for "game and videoconferencing applications, where low latency is more important than having the best possible graphics". `[doc]` https://developer.android.com/training/tv/games and the AOSP commit (https://gerrit.omnirom.org/plugins/gitiles/android_frameworks_base/+/a4aff1e1df81010367555d93b1df18e1b23f180e%5E2)
- Effect for us `[inference]`: TV display lag drops from roughly 50-120 ms to 10-20 ms. The TV usually also turns off motion interpolation, noise reduction and some upscaling. For sports, interpolation is a matter of taste and many owners already turn it off. **A/V sync risk:** some soundbars and AVRs apply their own lip-sync compensation based on reported display latency (ALLM changes it), so audio could end up ahead. Display lag does not matter for one-way TV; the delay that matters is seconds of network buffer. **Do not enable it.** At most an Advanced toggle, off by default.

### 1.9 Fire OS specifics

- Async MediaCodec is automatic (1.7). Tunneling: see 1.6.
- Amazon recommends its ExoPlayer port for older apps and Media3 on Fire OS 14+. `[doc]` https://developer.amazon.com/docs/fire-tv/media-players.html. A5 already notes the Dolby patches. Plan: stock Media3 ≥ 1.11 + verify Dolby passthrough on a Fire TV stick in the real-device checklist.

---

## 2. Instant zap with more than one player

### 2.1 `DefaultPreloadManager` (Media3 1.4+) `[source]` + `[doc]`
- API: `DefaultPreloadManager.Builder(context, targetPreloadStatusControl)`, `buildExoPlayer()` (players **must** come from the same builder), `add/remove(mediaItem, rankingIndex)`, `setCurrentPlayingIndex(i)`, `getMediaSource(item)`. Stages: `PRELOAD_STATUS_SOURCE_PREPARED`, `PRELOAD_STATUS_TRACKS_SELECTED`, `specifiedRangeLoaded(durationMs)` / `(startMs, durationMs)`, `specifiedRangeCached(...)`. Shares `LoadControl` with the player (1.8+), so preload bytes count against `DEFAULT_TARGET_BUFFER_BYTES_FOR_PRELOAD`. Since 1.8 a `PreloadMediaSource` played on a different playback thread throws. `[doc]`
- Designed for "a one-dimensional list (like a playlist or carousel)" of short-form VOD. The docs and Android blog never mention live. `[doc]`
- **Live fit `[inference]`:**
  - `SOURCE_PREPARED` for HLS = master + media playlist fetched and parsed. That is exactly the "pre-warm neighbours" tactic from A2, done by Media3. The prepared source goes stale (the live window moves), but the playlist tracker refreshes while the source stays prepared. **Worth trying for CH+/CH- neighbours on HLS.**
  - `TRACKS_SELECTED`: still no media loaded. A little extra start-up gain.
  - `specifiedRangeLoaded`: **don't use for live.** Preloaded media ages in real time. When played, it starts *behind* live by the time since preload. HLS can seek forward (to default position), but then the preload was wasted. For progressive TS, the preload holds an open HTTP connection per neighbour and the backlog becomes delay.
  - Raw TS: no PreloadManager. The only lever is URL pre-resolution plus connection keep-alive (a warm OkHttp pool to the same host).

### 2.2 Second ExoPlayer as a warm standby
- `MediaCodecInfo.CodecCapabilities.getMaxSupportedInstances()` reports the per-codec limit, but it is an upper bound. Real limits on TV SoCs are lower and depend on resolution (memory/bandwidth) and on secure vs clear. `[doc]` `[memory]` Low-end Android TV sticks often handle one 4K or two 1080p decodes. `[forum]`/`[inference]`
- Pattern that does not need a second decoder: keep **one** player and swap the `MediaSource`. The renderer and codec are reused when the format is compatible (Media3 can keep a codec across format changes if adaptive/seamless), and prepare the next source in the background with PreloadManager to `SOURCE_PREPARED`. `[inference]`
- Pattern with a second decoder (experiment only): player B, prepared with `playWhenReady=false` on the most likely next channel, **without a surface** (no surface = no video codec configured on many devices, which defeats the purpose) or with a 1×1 hidden `SurfaceView`. On CH+, swap surfaces (`setVideoSurfaceView`) and call `play()`. Costs: a second hardware decoder, network bandwidth for a live stream you are not watching, and for TS a growing backlog. Measure on the weakest target; keep only if the zap gain is > 300 ms and dropped frames on A do not rise. `[inference]`

---

## 3. libmpv (Tauri desktop)

### 3.1 What the built-in `low-latency` profile sets `[source]` https://github.com/mpv-player/mpv/blob/master/etc/builtin.conf

```
[low-latency]
audio-buffer=0          # minimize extra audio buffer (can lead to dropouts)
vd-lavc-threads=1       # multithreaded decoding buffers extra frames
cache-pause=no          # do not pause on underruns
demuxer-lavf-o-add=fflags=+nobuffer
demuxer-lavf-probe-info=nostreams
demuxer-lavf-analyzeduration=0.1
video-sync=audio
interpolation=no
video-latency-hacks=yes # typically 1 or 2 video frame less latency
stream-buffer-size=4k
```
The manual: "mpv is optimized for normal video playback... tries to buffer as much data as it seems to make sense"; some options "can reduce playback quality"; for live streams "data can build up due to pausing the stream, due to slightly lower playback rate, or 'buffering' pauses... can be skipped manually. The experimental `drop-buffers` command can be used to discard any buffered data, though it's very disruptive." `[doc]` (`DOCS/man/mpv.rst`, LOW LATENCY PLAYBACK)

Why not to ship it as the default (`[inference]`):
- `vd-lavc-threads=1`: single-threaded software decoding of 1080p50 H.264 high-bitrate content will drop frames on modest CPUs. With hwdec the thread count does not matter. Keep the default threads and use hwdec.
- `audio-buffer=0`: dropouts on Windows with Bluetooth or HDMI audio. The default is 0.2 s and the manual says to change it "for testing only". `[doc]`
- `cache-pause=no`: on an underrun, playback stutters instead of rebuffering. That gives minimal added delay but many micro-freezes. For sports over Wi-Fi, a single 1-2 s rebuffer is better, then catch up.
- `video-latency-hacks=yes`: "known to break other options such as interpolation… not recommended". `[doc]`
- `probe-info=nostreams` plus `analyzeduration=0.1`: see section 4 (missing-audio and codec-parameter risk).

### 3.2 Recommended libmpv option sets (set with `mpv_set_option_string` before `loadfile`)

Relevant defaults `[source]`/`[doc]`: `cache=auto` (on for network), `cache-secs` very high, `demuxer-max-bytes = 150 MiB`, `demuxer-max-back-bytes = 50 MiB`, `demuxer-readahead-secs = 1` (ignored when cache is on), `cache-pause = yes`, `cache-pause-wait = 1 s`, `cache-pause-initial = no`, `network-timeout = 60 s`, `audio-buffer = 0.2`, `hwdec = no`, `video-sync = audio`, `hls-bitrate = max`, `stream-buffer-size = 128 KiB`.

**BALANCED (default for live):**
```
hwdec=auto-safe                 # whitelisted HW decoders only (d3d11va / videotoolbox / vaapi / nvdec)
vo=gpu-next
cache=yes
cache-secs=30                   # readahead cap; the backlog stays visible to our controller
demuxer-max-bytes=64MiB         # 1 GB-RAM-class safety; 30 s × 15 Mbps ≈ 56 MB
demuxer-max-back-bytes=16MiB    # small back buffer for an instant "replay 10 s"; 0 if not needed
cache-pause=yes
cache-pause-wait=1.5            # rebuffer target after a stall (stall resistance knob)
cache-pause-initial=no          # start as soon as decodable
demuxer-lavf-o-add=fflags=+nobuffer+discardcorrupt
demuxer-lavf-probesize=1000000  # 1 MB instead of 5 MB
demuxer-lavf-analyzeduration=1  # 1 s instead of 5 s (lavf default)
network-timeout=10
hls-bitrate=max                 # or a cap from the quality setting (bits/s)
video-sync=display-resample     # see 3.4; falls back to audio automatically
interpolation=no
framedrop=vo
stream-lavf-o-add=reconnect=1
stream-lavf-o-add=reconnect_streamed=1
stream-lavf-o-add=reconnect_on_network_error=1
stream-lavf-o-add=reconnect_delay_max=4
stream-lavf-o-add=reconnect_on_http_error=5xx
```

**LOWEST DELAY (opt-in):** as Balanced plus `cache-pause-wait=0.5`, `demuxer-lavf-analyzeduration=0.5`, `demuxer-lavf-probesize=500000`, `video-sync=audio`, controller target 1.0 s. For HLS: `demuxer-lavf-o-add=live_start_index=-1` (FFmpeg default **-3** `[source]` `libavformat/hls.c`; -1 starts at the newest segment, which is like hls.js `liveSyncDurationCount=1`).

**STABLE:** `cache-pause-wait=3`, controller target 6 s, `live_start_index=-3` (default).

Do not use `--untimed` with audio ("will likely break unless the stream has no audio") `[doc]`. `--demuxer-cache-wait` is for files, not live. `[doc]`

### 3.3 Live catch-up controller for libmpv

mpv has no automatic catch-up. Its clock is the audio output. With `video-sync=audio` (default), video is timed to audio; there is no PCR clock recovery, so encoder/device clock drift ends up in the demuxer cache. `[doc]` for the clock role (`--video-sync` docs), `[inference]` for drift. An existing script uses this method: divout/mpv_reduce_stream_cache "reduces MPV cache for streams by increasing playback speed", with an aggressive default threshold that suits wired connections. `[forum]` https://github.com/divout/mpv_reduce_stream_cache

Signal: prefer `demuxer-cache-state` → `cache-duration` / `cache-end − time-pos`. `demuxer-cache-duration` is documented as "very unreliable… often not available" `[doc]`, so compute `cache-end - time-pos` when present and skip the tick when neither is available. Also watch `paused-for-cache` and `cache-buffering-state`. `[doc]`

Rust side of Tauri (pseudo-code, run on a 500 ms timer or `mpv_observe_property`):
```rust
let ahead = cache_end.zip(time_pos).map(|(e, p)| e - p).or(cache_duration);
if let Some(ahead) = ahead {
    if ahead > target + 20.0 { mpv.command(&["drop-buffers"])?; }     // hard reset ("very disruptive")
    else if ahead > target + 0.7 { catching = true; }
    else if ahead < target { catching = false; }
    let speed = if catching { (1.0 + 0.02 * (ahead - target)).clamp(1.01, 1.04) } else { 1.0 };
    mpv.set_property("speed", speed)?;   // scaletempo2 keeps pitch automatically above 1.0 [doc]
}
```
Notes: speed above 1.0 auto-inserts `scaletempo2` (pitch correction is on by default) `[doc]`. With `audio-spdif` passthrough (AC3/DTS to an AVR), speed changes cannot be time-stretched. Use only the hard reset there, or re-open the URL (more reliable than `drop-buffers` for TS, at the cost of one zap). `[inference]`

### 3.4 `video-sync` trade-off `[doc]`
- `audio` (default): most robust; video timed to audio; "occasional frame drops or repeats". On 50 fps content on a 60 Hz desktop monitor, that means visible 5:6 judder whatever the mode. The real fix is the display refresh, outside our control on desktop.
- `display-resample`: times video to vsync and resamples audio by up to `video-sync-max-video-change` = **1%** (default). Extra audio correction up to `video-sync-max-audio-change` = **0.125%**. Smooth motion when display Hz ≈ k × content fps (50 fps on a 50/100 Hz panel, 59.94 on 60). Needs constant frame rate, and "the player automatically reverts to audio mode" otherwise. Display-sync modes "require reading ahead a frame" (one frame of extra delay; builtin.conf comment). **Best choice for sports smoothness**, and it does not fight our speed controller (speed multiplies).
- `display-desync`, `desync`: "meant for testing". Never use.
- `interpolation=yes` (needs display-resample) adds frames of delay and costs GPU on weak iGPUs. Off by default; offer "Smooth motion" as a toggle.
- `framedrop=vo` default is right. `decoder` is "not recommended". `[doc]`

### 3.5 Reconnects and stalls (FFmpeg http protocol; defaults read in `libavformat/http.c`) `[source]`

| Option | Default | Live use |
|---|---|---|
| `reconnect` | 0 | 1: reconnect if dropped before EOF |
| `reconnect_streamed` | 0 | **1, required for live TS** (non-seekable) |
| `reconnect_at_eof` | 0 | 1 only for endless streams whose server closes at "EOF" between segments of a TS stream. It can loop forever on a dead channel, so our supervisor must cap it. |
| `reconnect_on_network_error` | 0 | 1 (TCP/TLS errors during connect) |
| `reconnect_on_http_error` | unset | `5xx`. Do not include 401/403/404: those need a re-resolve from the stored URL (A7). |
| `reconnect_delay_max` | 120 s | **4 s**. The default backoff can freeze the picture for minutes. |
| `reconnect_max_retries` | -1 (unlimited) | 5 |
| `reconnect_delay_total_max` | 256 s | 15 s, then hand over to our supervisor |
| `respect_retry_after` | 1 | keep |
| `rw_timeout` (µs, generic) | unset | 5 000 000. mpv's `network-timeout` (default 60 s) maps to it; set `network-timeout=10`. |

Reconnecting a live TS URL restarts at the server's live edge: the picture jumps forward and the buffer resets. Our A7 escalation ladder stays the outer layer; FFmpeg reconnect is layer 0.

### 3.6 HLS in mpv
mpv uses FFmpeg's HLS demuxer (`nested_network` hack) `[source]` `demux/demux_lavf.c`. FFmpeg HLS defaults `[source]`: `live_start_index=-3`, `prefer_x_start=0`, `max_reload=100`, `m3u8_hold_counters=1000`, `http_persistent=1`, `http_multiple=-1` (auto), `seg_max_retry=0` (**set 2-3** for flaky origins). `hls-bitrate=max` picks the top variant; there is no ABR in the FFmpeg HLS demuxer `[memory]`, so on a weak link the only option is a cap (`hls-bitrate=<bps>` from our quality setting) or reopening at a lower variant.

---

## 4. FFmpeg-level: probing, start time, correctness, PCR

- `probesize` default **5 000 000 bytes**; `analyzeduration` default **5 s**. "A higher value will enable detecting more information… but will increase latency." `[doc]` https://ffmpeg.org/ffmpeg-formats.html. For MPEG-TS, mpv's docs say probesize "identifies the maximum number of TS packets to scan". `[doc]`
- `fflags=nobuffer`: "Reduce the latency introduced by buffering during initial input streams analysis." `[doc]` `discardcorrupt` drops corrupted packets (useful on lossy tuner/UDP-sourced TS).
- mpv's format hacks: `mp4` and `matroska` skip `avformat_find_stream_info`, but **`mpegts` does not** (it only has `use_stream_ids`), so with the default `probe-info=auto`, TS start-up always runs the stream-info probe, bounded by analyzeduration/probesize. `[source]` `demux/demux_lavf.c` That is the main lever for TS start time in mpv.
- **The missing-audio risk** (`[inference]`, consistent with the docs' "detecting more information… dispersed in the stream"): the PMT lists the PIDs immediately, so streams exist. Codec *parameters* (AAC/AC3 sample rate and channels, H.264 SPS for size) come from the first packets. Typical TS muxing interleaves audio every 20-100 ms, but some muxers start a channel with long video-only runs, or AC3 arrives after a delay. With `analyzeduration=0.1` plus `probe-info=nostreams` (the low-latency profile), problems seen in practice are: audio stream with unknown parameters (decoder init fails or late), wrong channel layout, or a subtitle/teletext stream not detected. With 0.5-1 s and 0.5-1 MB these are rare, and start-up cost drops from about 5 s worst case to ≤ 1 s. **Fallback rule:** if after start `aid` is "no" while the demuxer lists an audio track, or audio params are missing, reload once with the FFmpeg defaults (probesize 5 MB, analyzeduration 5 s) and remember that per channel.
- ExoPlayer has no probesize equivalent: `TsExtractor` reads the PAT/PMT and creates readers immediately. Each track's format comes from its first PES, and prepare waits for **all** tracks (1.4), so the "missing audio" failure there is a *hang* rather than silent playback. Handle it with the watchdog plus `FLAG_IGNORE_*` retry.
- **PCR/PTS:** FFmpeg's mpegts demuxer uses PCR for timestamp estimation; `correct_ts_overflow=1` (default) fixes single 33-bit PTS wraparounds (about every 26.5 h, relevant for 24/7 channels). `[doc]` mpv: `demuxer-lavf-linearize-timestamps` (default auto) linearises timestamp resets, "tested only for single audio streams", and likely won't work for video. `[doc]` For video PTS jumps (encoder restart, splices), mpv's playback loop handles resets by re-syncing, with a brief freeze or A/V glitch `[memory]`. Our watchdog's "position not advancing / jumped backwards" rule (A7) is the backstop. Media3: `TimestampAdjuster` is shared in SINGLE_PMT mode; there is no general PTS-reset handling for progressive TS `[source]`. A backwards jump usually shows as a stall, so the watchdog reconnects.
- **Neither engine does PCR-based clock recovery** (broadcast set-top boxes slave their STC to PCR). That is the root cause of slow drift on all-day viewing, and why our speed controller exists. Tunneled playback with a tuner AV-sync ID does PCR/STC sync, but only for Android TV tuner-framework input, not HTTP streams. `[doc]` (tunneling page) + `[inference]`

---

## 5. Published measurements

- Bentaleb, Lim, Akcay, Begen, Hammoudi, Zimmermann, "Toward One-Second Latency: Evolution of Live Media Streaming", IEEE Communications Surveys & Tutorials (arXiv 2310.03256), Tables VIII-X `[doc]`. Setup: ExoPlayer **r2.13.2** on Android 10 over home Wi-Fi; LL-DASH/LL-HLS CMAF; 5 s segments with 1 s parts; encoder/origin in the USA and CDN/players in Singapore; 5 s target latency; 600 s sessions. ExoPlayer defaults in their table: `bufferForPlayback 2.5 s`, `afterRebuffer 5 s` (old defaults; 1.6+ uses 1 s / 2 s). Results (the table extracts badly, so treat these as ranges): **default parameters about 7-11 s end-to-end latency** for ExoPlayer, **tuned about 5-6 s with 2-3 s start-up**, speed range 0.5-1.5x. Across all players the tuned average was 5.11 s against 7.27 s default. Old version and LL CMAF, not TS. Useful only as an order of magnitude: tuned client buffer and speed control saves about 2-5 s on a 5 s-segment stream.
- ExoPlayer issue #5604 `[forum]`: a qualitative report of latency growth on live TS after buffering, no numbers.
- divout/mpv_reduce_stream_cache `[forum]`: the author claims "a few hundred milliseconds lower latency than the [platform's] web player" with speed catch-up and `cache=no`. Anecdotal, wired connection.
- **No published zap-time measurements for Media3 or libmpv on raw TS or HLS found.** A1 already said this. Our `zapTimings` instrumentation is the only route to numbers.

---

## 6. Proposed product setting and defaults

One setting, "Live delay": **Low / Balanced (default) / Stable**, mapped like this:

| | Low | Balanced | Stable |
|---|---|---|---|
| Media3 HLS `targetOffsetMs` | 1.5 × TD | 2 × TD | media default (3 × TD) |
| Media3 speed range (HLS w/ PDT) | 0.97-1.05 | 0.97-1.04 | 0.98-1.03 |
| Rebuffer increment | 250 ms | 500 ms | 1000 ms |
| `bufferForPlayback` / after rebuffer | 500 / 1500 | 1000 / 2000 | 1500 / 3500 |
| Our buffer controller target (TS, HLS without PDT) | 1.5 s | 3 s | 6 s |
| mpv `cache-pause-wait` | 0.5 | 1.5 | 3 |
| mpv HLS `live_start_index` | -1 | -2 | -3 |
| mpv `analyzeduration` / `probesize` | 0.5 s / 0.5 MB | 1 s / 1 MB | 1 s / 1 MB |
| Hard reset (re-open) above | +15 s | +20 s | +30 s |

Always on: TS flags (`ALLOW_NON_IDR_KEYFRAMES | DETECT_ACCESS_UNITS | IGNORE_SPLICE_INFO`), `setEnableDecoderFallback(true)`, SurfaceView, `ONLY_IF_SEAMLESS` frame-rate strategy, FFmpeg reconnect set (3.5), mpv `hwdec=auto-safe`, `video-sync=display-resample`.
Off unless tested per device: tunneling (auto for UHD ≥ 50 fps on Fire TV), `KEY_LOW_LATENCY`, minimal post-processing, second warm player, renderer prewarming.

Diagnostics to add (feeds tuning): PDT present y/n; live offset (Media3) or buffered-ahead (both engines); current speed; rebuffer count and total stall time; target offset after rebuffers; tunneling active; decoder name and HW/SW; `BehindLiveWindow` count; mpv `paused-for-cache` events and `cache-speed`.

## 7. Open questions / to verify on hardware
1. Does Media3 apply speed changes while AC3/E-AC3 passthrough is active on Fire TV / Android TV? (Expected no; then catch-up must use reconnect.)
2. Is `KEY_LOW_LATENCY` advertised by Amlogic/MediaTek/Realtek TV decoders, and does it change time-to-first-frame?
3. Can two 1080p H.264 hardware decoders run at once on the lowest target box, and what does a warm standby do to dropped frames?
4. Delay drift over 2 h on one TS channel with and without the controller (measures the device clock vs encoder clock).
5. mpv `probe-info=auto` vs `nostreams` on synthetic TS files with late AC3 (generate with ffmpeg, guardrail 1): start time and audio correctness.

## Sources
- Media3 source (release branch): DefaultLivePlaybackSpeedControl, DefaultLoadControl, DefaultRenderersFactory, DefaultMediaCodecAdapterFactory, MediaCodecVideoRenderer, ExoPlayerImplInternal, ProgressiveMediaSource/Period, TsExtractor, DefaultTsPayloadReaderFactory, DefaultExtractorsFactory, HlsMediaSource, DefaultTrackSelector, DefaultPreloadManager: https://github.com/androidx/media/tree/release
- Media3 release notes: https://github.com/androidx/media/blob/release/RELEASENOTES.md
- Live streaming guide: https://developer.android.com/media/media3/exoplayer/live-streaming
- HLS guide: https://developer.android.com/media/media3/exoplayer/hls
- Troubleshooting (TS flags): https://developer.android.com/media/media3/exoplayer/troubleshooting
- PreloadManager: https://developer.android.com/media/media3/exoplayer/preloading-media/preloadmanager and /concepts; blog part 2: https://developer.android.com/blog/posts/elevating-media-playback-a-deep-dive-into-media3-s-preload-manager-part-2
- Tunneling (AOSP): https://source.android.com/docs/devices/tv/multimedia-tunneling
- Fire TV tunnel mode: https://developer.amazon.com/docs/fire-tv/4k-tunnel-mode-playback.html ; media players: https://developer.amazon.com/docs/fire-tv/media-players.html
- Minimal post-processing / ALLM: https://developer.android.com/training/tv/games ; AOSP commit https://gerrit.omnirom.org/plugins/gitiles/android_frameworks_base/+/a4aff1e1df81010367555d93b1df18e1b23f180e%5E2
- ExoPlayer issue #5604: https://github.com/google/ExoPlayer/issues/5604 ; tunneling #1688: https://github.com/google/ExoPlayer/issues/1688
- mpv: builtin.conf https://github.com/mpv-player/mpv/blob/master/etc/builtin.conf ; options.rst, mpv.rst (LOW LATENCY PLAYBACK), input.rst (properties, `drop-buffers`) under https://github.com/mpv-player/mpv/tree/master/DOCS/man ; demux/demux_lavf.c, demux/demux.c
- FFmpeg: https://ffmpeg.org/ffmpeg-formats.html , https://ffmpeg.org/ffmpeg-protocols.html ; libavformat/http.c, libavformat/hls.c (defaults)
- divout/mpv_reduce_stream_cache: https://github.com/divout/mpv_reduce_stream_cache
- Bentaleb et al., "Toward One-Second Latency", arXiv 2310.03256: https://arxiv.org/abs/2310.03256
