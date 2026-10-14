# R4: Input lag and UI responsiveness, from remote button to pixels

Date: 2026-10-14. Scope: TV web app (Lightning 3 renderer 3.7.0 + @lightningtv/solid 3.2.5 + Solid 1.9) on Tizen/webOS, with notes for Android TV (Media3) and desktop (Tauri).

Claim tags: **[doc]** official documentation or the shipped library source/typings in `node_modules`; **[source]** a reputable non-official source; **[forum]** community reports; **[inference]** my own reasoning or estimate, to be verified on a device.

---

## 0. TL;DR (the 8 things that matter most)

1. **OK is acted on at key release, not key press** (`apps/tv/src/input/keys.ts:151-160,175-183`). With an IR remote the TV can only detect "released" after the repeat frames stop (NEC repeat every ~110 ms), so every OK press pays press duration plus release detection: roughly **120-250 ms** of added lag on the most-used key [inference, built on the [doc] protocol timing below]. This is the single biggest app-side lag source. Fix: give instant visual feedback on keydown and act on keydown wherever the focused element has no `onLongOk` (Player: banner toggle).
2. **The Lightning render loop sleeps in `setTimeout(16.7 ms)` when idle**, then waits for `requestAnimationFrame` (`@lightningjs/renderer/dist/src/core/platforms/web/WebPlatform.js`, the `startLoop` idle branch) [doc: library source]. The first frame after a key press from an idle UI is therefore **0-33 ms late (about 17-25 ms on average)** [inference]. Fix: pass a `platform` subclass of `WebPlatform` whose idle branch reschedules with `requestAnimationFrame` directly, or wakes the loop on keydown.
3. **The zap preview waits for a worker round trip that does an EPG lookup**: `api.neighbour` → `playable()` → `toRows()` → `nowNextCached()` (`packages/app-api/src/appApi.ts:211-212,844-846,827-830`). While the worker is busy (XMLTV import, refresh) the banner number and name can lag by seconds. Held CH+ also queues one RPC per repeat (`zapper.ts:67`). Fix: keep a small UI-side ring of neighbour ids, numbers and names (±20 around the current channel) so the banner updates synchronously. Coalesce resolves to one in flight, and load EPG for the banner as a second phase.
4. **Text is rendered by the Canvas text engine only** (`main.tsx:31`). Each new or changed string is rasterised on a 2D canvas and uploaded as a texture. During animations only **1 texture upload per frame** is allowed (`maxTextureUploadsDuringAnimation` default 1), and texture processing may take up to **42 ms per frame** (`textureProcessingTimeLimit` default in code is 42, although the typings say 10) [doc: library source]. Set `textureProcessingTimeLimit` to about 8-10 ms explicitly. Benchmark SDF text with a bundled, licence-clean font, which is the renderer's "more performant" engine [doc].
5. **Stream commit is debounced 300 ms** (`Player.tsx:28`), and Home preview 700 ms (`Home.tsx:43`). That is correct for bursts, but a single CH+ pays 300 ms before the stream even starts opening. Consider a leading-edge commit for isolated presses on engines where abort is cheap (Media3, mpegts.js), and keep the debounce on AVPlay.
6. **Number entry waits 1.5 s idle** (`Player.tsx:29`, `numberEntry.ts:42`). Submit immediately when no longer number can start with the typed prefix, for example "7" when the highest channel is 500 and no 70-79 or 700+ exists [inference; the usual behaviour in set-top boxes].
7. **Display-side lag is mostly outside our control on built-in TV apps.** HDMI game mode / ALLM affects external HDMI sources: Android TV / Fire OS sticks and the desktop build. Android exposes `Window.setPreferMinimalPostProcessing()` (Android 11+) [doc]. Tizen has a `use.game.mode` metadata key, but it is documented for cloud-gaming WebRTC apps [doc]. Do **not** enable either for a video player by default, because it disables motion processing that many sports viewers want. Instead, offer a user-facing tip screen.
8. **Measure it.** Add an in-app "key → next presented frame" probe (keydown `timeStamp` → renderer `frameTick` after the state change → following rAF), record p50/p95 in the DebugOverlay, and validate with a 240 fps phone camera. The existing perf suite (`vitest.perf.config.ts`) only covers core parsing in Node. Add zap-path and list-scroll budgets.

---

## 1. The latency chain, stage by stage

| Stage | Typical | Notes |
|---|---|---|
| Remote: IR (NEC-style) | ~67-86 ms to transmit a full first frame; repeats every ~110 ms | The receiver can decode only after the whole message [source: SB-Projects NEC protocol, https://www.sbprojects.net/knowledge/ir/nec.php]. Samsung's own IR format is similar in length [inference]. **Key-up is synthesised by the TV once repeat frames stop**, so `keyup` arrives ≥ ~110 ms after the last frame [inference]. |
| Remote: Bluetooth LE / RF4CE | ~7.5-50 ms connection interval plus stack processing | No controlled public measurement found. One patent describes a BT→IR relay whose latency setting changed from 500 ms to 50 ms, which shows how much configuration matters [source: USPTO 11050967]. Vendors claim RF is "more responsive" [source: https://www.telink-semi.com/tv-remotes-protocols-ble-rf4ce/]. Typical BLE intervals [inference]. |
| TV input stack → browser process → renderer | ~2-15 ms | OS input service, key mapping, IPC into Chromium [inference]. Tizen only delivers non-basic keys that the app registers (`tvinputdevice.registerKey`), already done in `platform/tizen.ts:34-56` [doc: Samsung]. |
| Chromium dispatch of `keydown` | ~0 ms extra | Discrete events (keydown/keyup) are **not** vsync-aligned; they are dispatched immediately, while continuous events (mousemove, wheel) wait for rAF [doc: https://developer.chrome.com/blog/aligning-input-events]. A busy main thread delays dispatch by the length of the current task. |
| JS handler (our code) | target < 2 ms | keys.ts → synthetic KeyboardEvent → Lightning focus path → Solid signal writes. Any `await` to the worker moves the visible change to a later frame. |
| Lightning frame scheduling | 0-16.7 ms active, **0-33 ms from idle** | Active: `requestAnimationFrame`. Idle: `setTimeout(16.67)` then rAF [doc: renderer 3.7.0 source]. |
| Frame build | 1-10 ms on low-end SoCs | Solid updates node props, then the renderer updates quads (dirty-quad uploads on by default, `enableDirtyRepaints`) [doc]. |
| Text and texture work | 1-5 ms per new canvas text string on low-end SoCs [inference] | Canvas text: measure, `fillText` on a 2D canvas, then `texImage2D`. Upload throttling: 1 per frame during animations; time cap 42 ms by default [doc: source]. Images decode via `createImageBitmap` (`'full'` default) [doc]. |
| GPU, compositor, graphics plane | 1-2 frames (16-33 ms) | Chromium compositor plus the TV's hardware composition of the graphics plane over the video plane [inference]. |
| Panel processing (built-in app OSD) | ~10-50 ms | The graphics/OSD plane usually bypasses heavy video processing such as frame interpolation, but goes through scaler and panel timing [inference]. |
| Panel processing (HDMI source: sticks, desktop) | Game mode: < 15 ms is "good" at 1080p60; outside game mode, < 40 ms is "good" | RTINGS methodology. The 60 Hz measurement floor is 8.33 ms (mid-screen) [source: https://www.rtings.com/tv/tests/inputs/input-lag]. Motion smoothing / interpolation commonly adds tens of ms [source/forum: https://www.thegamer.com/reduce-input-lag-tv-guide/]. |

**Budget view [inference].** IR transmission (~70 ms) + stack (~10 ms) + our handler and the frame (~20-50 ms) + compositor and panel (~30-60 ms) gives about **130-190 ms** from fingertip to photon at best on a built-in TV app. Any extra 100 ms that we add (key-up semantics, a worker round trip) is clearly felt. The perceptual threshold for "instant" in direct manipulation is about 100 ms (Nielsen's 0.1 s rule) [source: https://www.nngroup.com/articles/response-times-3-important-limits/]. Our share should be **≤ 1 frame on top of the next vsync, so p95 key → presented ≤ 50 ms** in our instrumentation.

### Web engine versions we target (affects API availability)

| Platform | Chromium |
|---|---|
| Tizen 6.0 (2021) | M76 |
| Tizen 6.5 (2022) | M85 |
| Tizen 7.0 (2023) | M94 |
| Tizen 8.0 (2024) | M108 |
| webOS 6 (2021) | 79 |
| webOS 22 | 87 |
| webOS 23 | 94 |
| webOS 24 | 108 |

Sources: [doc] https://developer.samsung.com/tv/develop/specifications/web-engine-specifications and https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine.

---

## 2. Lightning 3 + @lightningtv/solid best practices (with what the repo does today)

Facts from the installed packages (`node_modules/@lightningjs/renderer@3.7.0` typings and source, `@lightningtv/solid@3.2.5`) [doc]:

- **Render loop.** rAF while there are scene updates. When idle, `setTimeout(16.67)` then rAF, and `idle`/`active` events are emitted. `targetFPS` (0 by default) throttles the whole loop and must not be used to "save power" on the zap path. `WebPlatform` is exported from `@lightningjs/renderer/platform` and can be replaced via the `platform` setting.
- **`textureProcessingTimeLimit`.** Documented default 10 ms, but `Renderer.js` uses `settings.textureProcessingTimeLimit || 42`. That allows up to 42 ms of texture work in one frame, which is a dropped frame or two right after a screen change.
- **`maxTextureUploadsDuringAnimation`.** Default 1: during any animation only one new texture per frame is uploaded. New text or logos appear progressively while something animates. Keep animations off the key path so uploads are not throttled.
- **`textureMemory`.** `criticalThreshold` default 124e6 bytes (118 MB), `targetThresholdLevel` 0.5, `cleanupInterval` 5 s, `baselineMemoryAllocation` 25 MB, `doNotExceedCriticalThreshold` false. Cleanup runs in idle frames. On 1 GB TVs consider about 60-80 MB critical, and listen for `criticalCleanupFailed` [inference for the values].
- **`enableDirtyRepaints`.** Default true: only changed quads are re-uploaded. Keep it on.
- **`inspector`.** Default `false`. Never pass it in production; it mirrors every node into the DOM.
- **`devicePhysicalPixelRatio`.** Defaults to `window.devicePixelRatio`. On a desktop/Tauri window with DPR 2 the GL canvas has 4× the pixels. Set it to 1 on TVs and cap it at about 1.5 on desktop [inference].
- **Font engines.** "SdfTextRenderer is a more performant renderer". The Canvas text engine works everywhere. SDF needs WebGL plus an SDF font (msdf atlas JSON + PNG) [doc: `Renderer.d.ts` `fontEngines` remarks]. The repo bundles no fonts (`main.tsx:16`) and uses Canvas only. SDF requires shipping a licence-clean font such as an OFL font with Latin + Latin Extended glyphs. Glyphs outside the atlas would fall back to Canvas if both engines are listed, so CJK/Arabic channel names still work [doc: fallback order in `fontEngines`]. Warm up the atlas at startup (load it before the first render) so the first banner does not wait for it.
- **`Config.throttleInput`** (global) and per-element `throttleInput` exist in the focus manager. They **drop** repeats of the same key within N ms. That is useful for list scrolling on slow devices. Never use it on the zap path, because it drops presses instead of coalescing them.
- **`useFocusManager(keyMap, keyHoldOptions)`** supports key-hold detection natively. The repo instead implements LongOk itself in `keys.ts`.
- **Animations.** `Config.animationsEnabled = true` (`main.tsx:18`). Only the Wordmark fades (`shell/Wordmark.tsx:36-43`), which is good. Rules: no animation on focus moves or zaps; if any, ≤ 100-150 ms, and transform/alpha only, with no size changes that re-layout text.

Community view: the author of the Solid integration wrote that "on real TV hardware, Lightning 3 has not yet delivered the performance improvements many of us were hoping for" [source: https://javascript.plainenglish.io/boosting-lightning-fps-by-50-e0ff8617ee48, which returned 403, so only the abstract was read]. The lesson is to measure on the actual 2021 Tizen (M76) tier, not on desktop.

**General rules for this codebase [inference]:**
- **Keep node count per row low.** ChannelList rows are 1 container + 3 Text nodes + a logo container + an image + 2 progress views, about 8 nodes × ~22 rows ≈ 180 nodes. That is fine.
- **The `For` keyed by row index** (`ChannelList.tsx:77`) is the right choice: scrolling one row creates one row and destroys one, and re-positions the rest (cheap). Do **not** switch to slot-recycling (`Index`), which would re-rasterise every row's text on each step.
- **Avoid "Loading…" → real text double rasterisation.** Prefetch the next page when focus is within ~10 rows of a page edge, so rows rarely render a placeholder.
- **Text that changes every second** (stream info panel, clock, the sleep countdown) re-rasterises each tick. Keep these small (short strings, `contain="width"`).
- **The Spinner** (`Player.tsx:46-62`) changes 8 node colours every 120 ms. That keeps the loop active (≈8 frames/s) and costs no text uploads. Acceptable.

---

## 3. Main-thread hygiene

**Already right.** All parsing, storage, networking and search run in one classic Worker (`worker.ts`, `api.ts`, IIFE format for M76) [doc: repo]. The UI thread only renders.

**Risk: a single worker means queries queue behind imports.** `neighbour`, `getChannelSlice`, `byNumber` and `getPlayable` go to the same worker that parses a 300 MB XMLTV. The XMLTV parser yields async items (`packages/core/src/xmltv/parse.ts:66-69`), but microtask-level `yield` does not let the message queue run. Only real macrotask boundaries (network chunk awaits, IDB awaits) do. If a parse chunk plus index insertion runs for 100-500 ms, every zap preview waits that long [inference].

Options:
- **(a)** In parse loops, yield to the event loop every ~8-16 ms of work, using a `MessageChannel` post (works on M76) or `setTimeout(0)`.
- **(b)** Keep the zap path off the worker entirely: a UI-side neighbour ring (see §4).
- **(c)** A second worker for heavy imports, if memory allows (each worker costs a JS heap, about 5-15 MB [inference]).

**Scheduling APIs by engine:**

| API | Available from | Usable on M76? |
|---|---|---|
| `requestIdleCallback` | Chrome 47 [doc: MDN] | Yes. Fine for non-urgent UI work such as prefetching logos and warming text. Note that the Lightning loop "busy" frames still look idle to rIC. |
| `scheduler.postTask` | Chrome 94 [source: https://caniuse.com/mdn-api_scheduler_posttask] | Only on Tizen 7+/webOS 23+. |
| `scheduler.yield` | Chrome 129 [doc: https://developer.chrome.com/blog/new-in-chrome-129] | Not available on any shipping TV engine listed above. |

Use a tiny `yieldToMain()` shim: `scheduler.yield` → `MessageChannel` → `setTimeout(0)`.

**Long-task measurement:**
- `PerformanceObserver` with `entryTypes: ['longtask']` has been available since Chrome 58 [doc: MDN Long Tasks API], so it works on every target.
- Event Timing (`PerformanceEventTiming`, `'event'`/`'first-input'`) is listed from Chrome 76 [source: https://caniuse.com/wf-event-timing; MDN]. The per-type availability on M76 is unverified. Feature-detect via `PerformanceObserver.supportedEntryTypes`.
- `longtask` in a **worker** is not reported (main-thread only) [inference]. Time worker RPCs directly by timestamping in `wrap()`.

**GC and allocations during playback [inference]:**
- Avoid allocating per key or per frame. `keys.ts:104,119` copies the listener `Set` into an array on every key (`[...listeners]`). That is tiny but avoidable: iterate the Set directly and guard against mutation.
- `forward()` (`keys.ts:98-102`) allocates a `KeyboardEvent` per key, which is needed for Lightning. That is fine.
- `{ ...ch, favourite }` objects on a toggle are fine.
- **Real GC risk:** large structured-clone payloads from the worker. EPG grid pages (`getEpgRows`) and 40-row slices are cloned into the UI heap. Keep pages small and avoid re-fetching unchanged pages (already handled by `sliceCache`).
- V8 minor GCs are usually 1-5 ms on TV SoCs. Major GCs can take 20-100 ms on a 1 GB TV when the UI heap grows past ~50 MB [inference]. Watch `performance.memory` in the DebugOverlay (already shown).

---

## 4. Key-handling patterns

### 4.1 OK on keydown vs keyup (biggest win)

Current behaviour: `Ok` waits for `keyup` (< 600 ms) or becomes `LongOk` after 600 ms (`keys.ts:151-160, 175-183`). Cost per press = press duration (~80-150 ms) + the TV's release detection. On IR remotes, release detection is the repeat timeout, ~110-150 ms after the last frame [inference, see §1]. That is **~150-250 ms** before anything visible happens on OK, the main "select" key.

Options, in order of preference:

1. **Context-sensitive OK.** Dispatch `Ok` on keydown when the focus path has no `onLongOk` handler. Use release semantics only where a long press means something. Implementation: `installKeys` asks a registered predicate (`hasLongPressTarget()`, for example by walking Lightning's focus path for `onLongOk`) on keydown. Today 5 places use `onLongOk`. In the **Player**, OK toggles the banner and LongOk opens the menu: act on keydown (show or hide the banner), and if the hold reaches 600 ms, open the menu (the banner toggle is harmless).
2. **Instant acknowledgement where release semantics stay** (list rows, where OK = play and long OK = options). On keydown, set a "pressed" visual state on the focused row: a colour shift, no layout change, no new text. The user sees the response within one frame, and the action fires on release.
3. **Shorten the long-press threshold.** Use about 500 ms; Android's default long-press timeout is 400-500 ms [doc: `ViewConfiguration.getLongPressTimeout`]. This only affects LongOk, not normal OK latency.

### 4.2 Zap path (CH+/CH−, Up/Down in the player)

Current design (`zapper.ts`): every press resolves `anchor + offset` asynchronously through the worker, shows a preview on answer, and commits 300 ms after the last press or when the latest answer arrives. Problems:

- **The preview depends on a worker round trip that includes EPG now/next lookups** (`appApi.ts:844-846` → `toRows` → `nowNextCached`, which may read IndexedDB on a miss). Fix: an **identity-first preview**. Keep in the UI a small ring of lite rows (`{id, number, name, logo}`) for ±N neighbours in the zap group, refreshed after each commit (one RPC: `neighbourWindow(group, id, 20)`). The banner number and name then update **synchronously in the key handler**, and now/next arrives in a later frame.
- **Held CH+ floods the worker.** Each auto-repeat calls `opts.resolve` (`zapper.ts:67`). At typical repeat rates of 10-20 Hz [inference; Android's default key-repeat delay is 50 ms after a 400-500 ms initial timeout, doc: `ViewConfiguration`], stale requests pile up ahead of the latest. Fix: **coalesce**, with at most one resolve in flight. When it returns and `offset` has moved, issue one more for the latest offset. With the UI-side ring this disappears for |offset| ≤ N.
- **The 300 ms trailing debounce** (`Player.tsx:28`) delays the stream open for single presses. Options:
  - (a) Keep 300 ms on AVPlay, where `close()`/`prepareAsync` churn is expensive and can stall [inference].
  - (b) Use a **leading-edge commit** when no burst is active (`!e.repeat` and the last press was > 400 ms ago) on engines where cancel is cheap (Media3, mpegts.js, hls.js), then debounce the rest of the burst.
  - (c) Reduce to ~200-250 ms. TV users rarely press faster than every ~250 ms when stepping [inference]; measure with real users.
- **Repeat awareness.** `keys.ts:99` forwards `src.repeat`, but some remotes do not set `repeat` (`keys.ts:152` comment). Treat a same-key keydown within ~150 ms as a repeat for zap acceleration. Optionally accelerate: after 1 s of hold, step 2-5 channels per repeat, or show a fast-scroll number.
- **Never block on teardown.** Commit should call `playback.playChannel(ch)` and return. Any `await player.stop()` or `close` must not run on the key path. Verify in the AVPlay wrapper that `stop/close` are not synchronous long calls on the UI thread. AVPlay's `close()` is synchronous and can take tens of ms or more [inference; measure].

### 4.3 Number entry

The `NUMBER_IDLE_MS = 1500` idle submit (`Player.tsx:29`) is standard, but it is avoidable when the prefix is unambiguous. Cache the set of channel numbers, or a `maxNumber` plus a prefix bitmap, in the UI after load. Submit immediately when `prefix × 10 > maxNumber` or no number starts with `prefix` followed by another digit. Also accept OK as "go now" (already handled: `onEnter` → `numbers.submit()`). With the OK-on-keydown change this also gets faster.

### 4.4 Lists (Home, Guide, Search)

- Held Down creates one row per repeat (good). Every page boundary (40 rows) triggers a fetch, and rows may flash "Loading…" (`ChannelList.tsx:102`). Prefetch ahead in the scroll direction.
- **Coalescing for lists:** if the frame budget is exceeded (`frameTick` delta > 33 ms), apply the accumulated delta in one update rather than one per queued repeat [inference]. Alternatively set `throttleInput` (about 60-80 ms) on the list node only on low-end tiers, which drops excess repeats so the list never "runs on" after the key is released. Run-on is the classic TV-UI complaint: the queue drains after release.
- **The preview debounce** (700 ms, `Home.tsx:43`) is a good guard against starting streams while scrolling. Keep it.

### 4.5 keydown vs keyup in general

- Act on keydown for everything except keys with a long-press meaning.
- Back: act on keydown. The platform's own Back handling on webOS can also run on keydown [inference].
- Swallow the matching keyup (already done for typed keys).
- On `blur`/`visibilitychange`, reset the hold state (already done for OK: `keys.ts:188-193`).

---

## 5. Display-side lag the app can influence

**Built-in TV apps (Tizen, webOS, Vidaa, Titan).** The app's UI is drawn on the TV's graphics/OSD plane and the video on the video plane. HDMI "game mode" and ALLM are signalled by an external HDMI source, so a built-in app cannot trigger them through HDMI. Picture-mode processing such as motion interpolation applies to the **video** plane, which delays the video relative to audio and remote presses but not the app's own UI drawing [inference].

- **Tizen.** `<tizen:metadata key="http://samsung.com/tv/metadata/use.game.mode" value="true"/>` is documented in the cloud-gaming WebRTC guide. It needs 2022+ models and engine M85+, and apps defining it for older models cannot be submitted in Seller Office [doc: https://developer.samsung.com/smarttv/develop/guides/cloud_gaming/cg_implement_webapp.html]. It is meant for game streaming. Using it in a video player would likely change picture processing for all content and could be questioned in review [inference]. **Do not use it.**
- **Tizen AVPlay / WASM player** have latency modes for **stream** latency (buffering), not display processing [doc: https://developer.samsung.com/smarttv/develop/extension-libraries/webassembly/tizen-wasm-player/overview.html]. That is a separate topic (live-edge latency).
- **webOS.** No public API to request low-latency picture mode was found [doc search returned nothing].

**Android TV / Google TV / Fire OS.** `Window.setPreferMinimalPostProcessing(true)` or the window attribute `preferMinimalPostProcessing`, on Android 11+. Check support with `Display.isMinimalPostProcessingSupported()`. On HDMI 2.1 sinks this triggers ALLM; otherwise a vendor game mode [doc: https://developer.android.com/training/tv/games]. Users can globally disable it, and switching can cause flicker or slow mode changes on some TVs [source: AOSP commit adding the user setting, https://gitlab.e.foundation/e/os/android_frameworks_base/-/commit/088d7c097c42dbf984a07db9bb2be49958dbecf5].

**Recommendation:**
- Never on by default, because a picture-mode flip on every app launch is jarring and removes processing that sports viewers may want.
- Offer an opt-in "Low-latency picture (game mode)" toggle on Android builds only, used while the app UI is in the foreground.
- **Desktop (Tauri) via HDMI to a TV:** nothing to call. The TV's own setting applies.

### "Sports and low-latency tips" help screen (app-only, no provider guidance)

The copy must stay neutral: no league or broadcaster names, no "free" wording. Suggested content:

1. **Picture mode.** If remote presses or the picture feel delayed, try your TV's Game or "low latency" picture mode, or turn off motion smoothing (often called motion interpolation or similar in picture settings). Game mode reduces delay but may make fast motion look less smooth; choose what you prefer.
2. **Streaming sticks.** On a streaming stick or box, turn on "Auto Low Latency Mode" or "ALLM" in the device's display settings, if your TV supports it.
3. **Sound delay.** If you use a soundbar or receiver, set the TV's audio delay / lip-sync so that sound matches the picture.
4. **Network.** A wired connection usually changes channels faster and more reliably than Wi-Fi.
5. **Remote.** If presses are sometimes missed, point the remote at the TV, replace the batteries, or pair the Bluetooth remote again.
6. **In the app.** Hold CH+/CH− to move quickly; the stream starts when you stop. Type a channel number and press OK to jump at once.
7. **Diagnostics.** In Settings > Diagnostics, "Show debug overlay" shows the app's frame rate and key response time (after §6 is implemented).

---

## 6. Measuring input-to-photon latency

### 6.1 Camera method (ground truth, end to end)

- Use a phone in 240 fps slow motion, which gives 4.17 ms per frame. Frame both the remote's IR LED (visible to most phone cameras) or the fingertip, and the screen.
- For each sample, count frames from LED-on (or button bottom-out) to the first visible pixel change. Take at least 20 samples per scenario and report the median and p90.
- **Scenarios:**
  - (1) Home list Down, from idle and while scrolling.
  - (2) Player CH+ → banner number change.
  - (3) CH+ → first video frame of the new channel (stream-dependent; report separately).
  - (4) OK in the player → banner.
  - (5) Number entry → jump.
- Run on the minimum-spec TV tier (Tizen 6.0 / M76, 1-1.5 GB) and one recent model. Test both IR and Bluetooth remotes if available.
- Optional rig: an Arduino with an IR LED plus a photodiode taped to the screen over a test patch that the app flips on the key [inference]. This gives automated hundreds of samples at ±1 ms.

### 6.2 In-app instrumentation (the app's share)

Add `apps/tv/src/perf/latencyProbe.ts`, DEV or Diagnostics-toggle only:

1. In `installKeys` (`keys.ts:117`), on a mapped keydown, record `t0 = e.timeStamp`, which is the event creation time on the same clock as `performance.now()` in Chromium ≥ 49 [doc: MDN `Event.timeStamp`]. Also record `tHandlerStart = performance.now()`, so queueing delay = `tHandlerStart − t0`.
2. After the handler (synchronously), record `tHandlerEnd`.
3. Subscribe once to `renderer.on('frameTick', …)` (the Stage emits `frameTick` each frame [doc: renderer source `Stage.js:349`]). The first frameTick after `tHandlerEnd` is the frame that includes the change. Then use a `requestAnimationFrame(() => requestAnimationFrame(t2 => …))` double-rAF as an approximation of "presented".
4. Keep a ring buffer per key class (nav, zap, ok, digit) and display p50/p95 in `DebugOverlay.tsx`. Report `queue`, `handler`, `toFrame` and `toPresent` separately.
5. Add a `PerformanceObserver({ entryTypes: ['longtask'] })` counter (M58+), and feature-detect `'event'` Event Timing to cross-check `processingStart − startTime`.
6. Worker RPC timing: wrap `remote.api` calls to log the round-trip p95 by method (`neighbour`, `getChannelSlice`, `getPlayable`). This is the zap-preview critical path until §4.2 is done.

**Budgets (proposed):**

| Metric | p95 budget |
|---|---|
| queue | ≤ 4 ms |
| handler | ≤ 3 ms |
| key → frame including the change | ≤ 20 ms active, ≤ 35 ms from idle (≤ 20 ms after the idle-loop fix) |
| Zap banner update (number + name) | same frame as the key |
| Worker `neighbour` RPC (while idle) | ≤ 10 ms |
| Worker `neighbour` RPC (during XMLTV import) | ≤ 50 ms |

### 6.3 Automated perf tests

- **`vitest.perf.config.ts`** runs `packages/**/perf/**/*.perf.ts` in Node with `--expose-gc` and forks (`m3u.perf.ts`, `xmltv.perf.ts`). It covers parser and index throughput only. Additions:
  - **Core:** `channelIndex.neighbour` and a new `neighbourWindow` at 50k channels. Target: p99 < 0.2 ms, measured over 10k random calls after a warm-up.
  - **App-api:** `AppApi.neighbour` end to end with an in-memory storage stub, while an XMLTV import of the 300 MB synthetic fixture runs concurrently. Assert that the worst-case latency stays under 50 ms. This catches "the query queues behind the import" regressions and pairs with the yield-to-event-loop fix.
- **Browser-level:** a Playwright run against `vite preview` with Chrome throttled (`CPU throttling 6×` via CDP `Emulation.setCPUThrottlingRate`). Script held-Down for 3 s on a 50k list and held CH+ for 2 s. Collect probe p95s via `window.__iptv` (DEV) and longtask counts. Fail on budget regressions. This is not a TV, but it catches relative regressions cheaply [inference].
- **On-device smoke:** a Diagnostics "latency self-test" that synthesises 50 key events (dispatching synthetic events through the same `installKeys` path) and reports handler → frame stats. It excludes remote and panel time but runs on the real SoC.

---

## 7. Code review: concrete improvement opportunities

Ordered by expected user-visible impact.

| # | Where | Issue | Suggested change | Impact |
|---|---|---|---|---|
| 1 | `apps/tv/src/input/keys.ts:151-160, 175-183` | OK is dispatched on keyup (or after 600 ms). It adds press duration plus release detection (~150-250 ms on IR) to every OK. | Context-sensitive: keydown dispatch when the focus path has no `onLongOk`. Pressed-state feedback on keydown elsewhere. Lower `LONG_PRESS_MS` (`keys.ts:12`) to ~500. | High |
| 2 | Renderer loop (`@lightningjs/renderer` `WebPlatform.startLoop`, idle branch); configured in `apps/tv/src/main.tsx:23-34` | Idle loop polls with `setTimeout(16.67)` then rAF, adding 0-33 ms to the first frame after a key. | Pass `platform: class extends WebPlatform` with an idle branch using `requestAnimationFrame` (rAF with no draw is cheap). Or expose a `wake()` that cancels the timeout and calls rAF from the keydown handler. Measure the power impact on TVs (negligible versus video decode) [inference]. | Medium-high |
| 3 | `apps/tv/src/playback/zapper.ts:54-75`; `apps/tv/src/screens/Player.tsx:134-148`; `packages/app-api/src/appApi.ts:211-212, 844-846` | The zap preview awaits a worker RPC that also fetches now/next (possible IDB). Held keys flood the worker with stale resolves. | A UI-side neighbour ring (±20 lite rows) updates the banner synchronously. One coalesced resolve in flight. EPG for the banner as a second phase. Add `neighbourWindow` to the app-api. | High during imports, medium otherwise |
| 4 | `apps/tv/src/main.tsx:23-34` | Renderer defaults are not tuned for TVs: `textureProcessingTimeLimit` falls back to 42 ms in code; `devicePhysicalPixelRatio` comes from `window.devicePixelRatio`; `textureMemory` uses the 118 MB critical threshold. | Set `textureProcessingTimeLimit: 8-10`, `devicePhysicalPixelRatio: 1` on TV platforms, `textureMemory: { criticalThreshold: ~64-80e6 }` on low-RAM tiers. Leave `inspector: false` explicit. | Medium (jank on screen changes) |
| 5 | `apps/tv/src/main.tsx:16, 31` | Canvas-only text: every new string is rasterised and uploaded. | Prototype `SdfTextRenderer` first with a bundled OFL font (Latin set) and Canvas as fallback. Benchmark list scroll and banner on M76 hardware before committing. Warm the atlas at startup. | Medium (list scroll smoothness, banner pop-in) |
| 6 | `apps/tv/src/screens/Player.tsx:28` (`ZAP_DELAY_MS = 300`) | A single press waits 300 ms before the stream opens. | Leading-edge commit for isolated presses on cheap-abort engines (Media3, mpegts.js, hls.js). Keep the trailing debounce for bursts and for AVPlay. Make the delay per engine. | Medium (perceived zap time) |
| 7 | `apps/tv/src/screens/Player.tsx:29, 173-178`; `apps/tv/src/playback/numberEntry.ts:38-43` | Number entry always waits 1.5 s. | Submit immediately on an unambiguous prefix (the UI caches channel-number info). Keep 1.5 s otherwise. | Medium for number users |
| 8 | Worker: `packages/core/src/xmltv/parse.ts:60-70` and the index build in the import path | Microtask-only yielding can block the worker message queue during large imports, so UI queries wait. | Yield to the event loop every ~10 ms of CPU work (a `MessageChannel` / `setTimeout(0)` shim). Add the concurrent-import perf test (§6.3). | High during refresh, otherwise none |
| 9 | `apps/tv/src/components/ChannelList.tsx:77-114`; `Home.tsx` slice prefetch | Held scrolling can queue repeats ("run-on") on slow TVs. Page boundaries show "Loading…" then re-rasterise text. | Directional prefetch ~1 page ahead. On low tiers, `throttleInput` ~60-80 ms on the list node or delta coalescing per frame. | Medium on low-end |
| 10 | `apps/tv/src/input/keys.ts:104, 119, 141` | `[...set]` copies per key. | Iterate the Set directly (handlers do not mutate during dispatch, or guard with a version counter). | Low (GC hygiene) |
| 11 | `apps/tv/src/shell/DebugOverlay.tsx` | It shows FPS and heap only. | Add key-latency p50/p95 per class, long-task count, and worker RPC p95 (§6.2). Use the renderer's own `fpsUpdateInterval`/`fpsUpdate` (with `fpsBoundaries` frame-time buckets) instead of a second rAF loop. | Enables everything else |
| 12 | `vitest.perf.config.ts` | Covers parsers only (`packages/**/perf`). | Add an app-api perf (neighbour under concurrent import) and index `neighbour` micro-benchmarks. Optionally add a Playwright CPU-throttled UI test. | Prevents regressions |
| 13 | Android (future Media3 app) | n/a | Opt-in `setPreferMinimalPostProcessing` toggle, after checking `isMinimalPostProcessingSupported()`. Never default on. | Low-medium for HDMI-stick users |

**Things already done well** (keep them):
- One global capture listener that maps keys before Lightning sees them (`keys.ts:195-197`).
- Tizen key registration with batch plus fallback (`platform/tizen.ts:34-56`).
- All core work in a worker, with an IIFE build for M76 (`vite.config.ts`).
- A virtualised list with index-keyed rows and a 5-row buffer (`virtualWindow.ts`).
- A bounded, expiring slice cache (`sliceCache.ts`).
- The 700 ms preview debounce on Home.
- A trailing-commit zapper with sequence numbers, so stale answers never win (`zapper.ts`).
- A non-modal debug HUD whose rAF loop runs only while visible.
- Animations kept to one wordmark fade.

---

## Sources

- SB-Projects, NEC IR protocol: https://www.sbprojects.net/knowledge/ir/nec.php
- Chrome blog, Aligned input events: https://developer.chrome.com/blog/aligning-input-events
- RTINGS, TV input lag test methodology: https://www.rtings.com/tv/tests/inputs/input-lag
- TheGamer, reduce TV input lag guide: https://www.thegamer.com/reduce-input-lag-tv-guide/
- Android, Build TV games (minimal post-processing / ALLM): https://developer.android.com/training/tv/games
- AOSP-derived commit for the minimal post-processing user setting: https://gitlab.e.foundation/e/os/android_frameworks_base/-/commit/088d7c097c42dbf984a07db9bb2be49958dbecf5
- Samsung, Cloud gaming web app (`use.game.mode`): https://developer.samsung.com/smarttv/develop/guides/cloud_gaming/cg_implement_webapp.html
- Samsung, Tizen WASM Player overview: https://developer.samsung.com/smarttv/develop/extension-libraries/webassembly/tizen-wasm-player/overview.html
- Samsung, Web engine specifications: https://developer.samsung.com/tv/develop/specifications/web-engine-specifications
- LG, webOS TV web engine: https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine
- Chrome 129 (scheduler.yield): https://developer.chrome.com/blog/new-in-chrome-129
- caniuse, scheduler.postTask: https://caniuse.com/mdn-api_scheduler_posttask
- caniuse, Event Timing: https://caniuse.com/wf-event-timing
- MDN, PerformanceEventTiming: https://developer.mozilla.org/en-US/docs/Web/API/PerformanceEventTiming
- Telink, TV remote protocols: https://www.telink-semi.com/tv-remotes-protocols-ble-rf4ce/
- USPTO 11050967 (BT→IR relay latency): https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11050967
- "Boosting Lightning FPS by 50%" (abstract only): https://javascript.plainenglish.io/boosting-lightning-fps-by-50-e0ff8617ee48
- Lightning 3 renderer: https://github.com/lightning-js/renderer, and the installed `@lightningjs/renderer@3.7.0` typings and source (`Renderer.d.ts`, `Renderer.js`, `TextureMemoryManager.d.ts`, `platforms/web/WebPlatform.js`, `Stage.js`)
- @lightningtv/solid 3.2.5 installed source (`core/config.d.ts`, `core/focusManager.js`)
- NN/g, response time limits: https://www.nngroup.com/articles/response-times-3-important-limits/
