# Backlog (after v1.1)

## Now: beta platforms, then the review's roadmap

The beta platform plans (`superpowers/plans/2026-10-19-beta-*.md`, foundations first) come before the mobile app
below. The 2026-10-20 review, [research/health-and-roadmap-2026-10-20.md](research/health-and-roadmap-2026-10-20.md),
ranks what follows: catch-up/archive and custom headers (both "must"), the PC app with libmpv (the desktop answer to
audio-track choice in MKV/MP4), then "Follow a show", the phone digest and second screen, HDHomeRun, Watch Together
and a dual-view prototype.

## Done after v1.1

- **Movies and series** (VOD): browse, details, resume, duplicate versions folded into one title, player controls,
  ±30 s, audio and subtitle tracks, subtitles from a file, a link or OpenSubtitles with sync and delay, volume.
- **Start tab**: Continue watching, Live now, Sports in your guide (Teams I follow), Recently added; Open on setting.
- **Home search bar**, **pointer/mouse** support, **gentle source retry** and **refusal cooldown**, **live delay and
  recovery**, **playback journal and stable dev server**.

## Next: mobile app (sub-project, approved)

The next piece of work after v1.1, approved by the user. Start with a brainstorm and a spec
(`docs/superpowers/specs/`), as usual.

- **What:** a phone app for Android and iOS, built with **Capacitor**, that looks like the TV app (same colours,
  type and layout language, adapted to touch).
- **It can:**
  - **watch**: the user's own sources, with the same core (`@iptv/core`, `@iptv/app-api`) and a native player;
  - **manage**: sources, lists, groups and display, like the companion web app (`apps/companion`);
  - **pair with the TV**: scan the TV's QR code with the camera (or type the code) and manage the TV over the same
    end-to-end encrypted relay (`@iptv/companion-protocol`).
- **Questions for the brainstorm:** how much of `apps/companion` can be reused as-is; the native player on each
  platform (Media3 on Android, AVPlayer on iOS) versus a web player; where pairing secrets live on the phone
  (never persisted across sessions today); store rules for a neutral player (guardrails 1–4 apply to the store
  listings); one licence per account.

## Done in v1.1

Organisation and the companion (Plans 3 and 4):

- **Lists:** Favourites plus your own lists; add, remove, reorder and rename, on the TV and on the companion.
- **Groups:** order, hide and show, rename; **channels:** rename, hide, and per-group sort (provider order / number /
  A–Z) or a custom order by dragging. (Was "Sort options" in the features table.)
- **Hide channels without TV guide.**
- **Manage on phone or computer** (was "Phone QR setup"): QR or 12-character code pairing, end-to-end encrypted
  (AES-GCM, PBKDF2 for codes), a Cloudflare relay that stores nothing, and the companion web app for sources, lists,
  groups and display. Deployment: [deploy-companion.md](deploy-companion.md).

Items deliberately left out of v1. Evidence comes from the user-needs research,
[`research/user-needs-2026-10.md`](research/user-needs-2026-10.md) (section numbers below refer to it). Legal
guardrails in `CLAUDE.md` apply to every item: no bundled content, no provider links, client-only media,
credentials stay on the device.

## Features

| Item | Why | Evidence | Notes |
|---|---|---|---|
| **Seconds behind live per channel** (user idea 2026-10-14; next to brainstorm) | Pick the channel or source closest to live at a glance | User request; no rival shows it (research R6) | The value is measured while watching (every engine) and remembered per channel. HLS playlists with a stream clock can be probed in the background without playing. Raw TS can only be measured while watching. Values are relative, not "true broadcast" time |
| **Parental PIN** (locked groups/channels) | Competitors ship it; a family-TV differentiator | Research §1 #18, §2; Televizo changelog (no link), [Airo IPTV PIN](https://github.com/zigorminsk-debug/IP-TV-player/pull/1) | PIN stored locally only |
| **User-Agent / Referer setting** applied to playlist, guide **and** stream requests | Header-gated lists load but fail in playback when only the list fetch sends them | Research §1 #8, §2, §5; [iptvnator #1221](https://github.com/4gray/iptvnator/issues/1221) | **Caveat:** limited on Tizen web apps (the web layer restricts headers; check AVPlay `setStreamingProperty` support first) |
| **Quality cap** (Auto / 720p / 1080p) | Weak TV chips overheat or stutter on high bitrates | Research §1 #23, §2; [StreamVault #263](https://github.com/Davidona/StreamVault-IPTV/issues/263) | |
| **Local XMLTV file** (and paste-a-URL, gz / double-gz tolerant) | Guide data is hosted in odd ways | Research §2; [iptvnator v0.24 notes](https://4gray.github.io/iptvnator/blog/v0-24-release-notes/) | Needs a file picker per platform |
| **Catch-up / archive** | Strongest long-running demand | Research §1 #17, §3; [Kodi pvr.iptvsimple issues](https://github.com/kodi-pvr/pvr.iptvsimple/issues?q=is%3Aissue+sort%3Acomments-desc), [iptvnator #1562](https://github.com/4gray/iptvnator/issues/1562) | Start times must use the server's time zone |
| **Timeshift** (pause / restart live) | Frequently asked for | Research §1 #16, §3; [Kodi pvr.iptvsimple issues](https://github.com/kodi-pvr/pvr.iptvsimple/issues?q=is%3Aissue+sort%3Acomments-desc) | Tizen AVPlay cannot pause live ([note](https://github.com/muratcode/iptv-player-tizen)) |
| **Recording** | Asked for; competitors' versions are unreliable | Research §3 | Hard in TV web apps (storage, background) |
| **Multiview** | Premium feature in competitors | Research §3 (low confidence) | One-stream-at-a-time rule must be revisited |
| **Sync** between devices | Same sources on every TV | Research §3 | End-to-end encrypted only (guardrail 7). The companion's pairing and `SecureChannel` are a starting point |
| **Profiles** | Separate favourites / history per person | Research §3; OTT Navigator changelog (no link) | |

## Platforms and distribution

| Item | Notes |
|---|---|
| **LG webOS packaging** (`.ipk`) | Key codes are already mapped in `@iptv/platform` (Back 461, CH+/- 33/34); needs packaging, the `<video>` path tested on webOS, and an install guide like the Samsung one. |
| **Store submission** (Samsung, LG) | Store listings, privacy policy, screenshots without broadcaster logos, copyright contact page. Follows real-TV verification. |
| **Migrate `@lightningtv/solid` → `@solidtv/solid`** (checkpoint) | npm marks `@lightningtv/solid` 3.2.5 as deprecated ("moved to `@solidtv/solid`"). The successor targets a forked renderer (`@solidtv/renderer`). Decide before v2: stay, or migrate both packages together. See `apps/tv/STACK.md`. |

## Real-TV verification (first Samsung install)

Nothing has run on a real TV yet. From `tools/tizen/README.md`:

- Settings → Diagnostics → Player says **AVPlay**, not HTML5. HTML5 means `webapis.js` did not load.
- Video appears in the Home preview, the Guide mini window and full screen, and moves between them.
- Aspect modes (16:9, 4:3, stretch, zoom) keep the picture inside its box in the preview and in full screen
  (zoom crops only in full screen), and AVPlay accepts partly off-screen rects (zoom uses a negative offset).
- The module entry script and the worker load from the widget's file URL. If not: a Blob / inlined classic worker,
  or `@vitejs/plugin-legacy` / a classic entry.
- `AVPLAY_DISPLAY_SPACE` (1920×1080) gives the right picture size on a UHD panel.
- Remote keys: colour, digit, channel, play/pause and info keys arrive (they must be registered); Back, arrows
  and OK always arrive.
- Gzip lists on Tizen 6.0 (no `DecompressionStream` before Chromium 80) fail with the clear "cannot read
  compressed lists" error; plain lists work.
- Performance on the TV: cached start to the Channels list under 1 s, key response under 100 ms, smooth with a
  large list (50k channels) and a large guide.
- Dolby (AC3 / E-AC3) audio plays on the TV (it cannot in desktop browsers).
- Manage on phone page: the once-a-second countdown redraw does not flicker on the TV's GPU (it re-renders one `Text`
  node per second). If it does, update the text only when the displayed `mm:ss` changes or render it as a fixed-width node.
  In the v1.1 end-to-end pass (desktop, in a browser pane that was often hidden) the countdown line was sometimes
  missing while connected: the renderer held the text node with a loaded texture but `isRenderable` false and an
  update still pending. It could not be confirmed with a visible, normally running page; check it on the TV.
- Companion over the deployed relay: pairing from the packaged app (`Origin` null or `file://` for `role=tv`) to
  `wss://` works; the TV's `CompressionStream` is detected (TV→phone states are compressed only when it exists).

### Live delay and recovery (from `docs/research/live-latency-and-stalls-2026-10.md` §10)

These gate releasing the live-delay work on TVs. Use synthetic test streams only (the live lab, sub-project 3).

1. `video.playbackRate` 1.05 / 1.1 / 1.2 on MSE live, 30 s each, on Tizen 6+ and webOS 6+. Check whether the speed changes and whether the audio continues. This decides whether TVs may get rate catch-up (`allowRate`).
2. AVPlay `setBufferingParam` below 4 s: does it throw, clamp or work? Measure how long the picture freezes after a rebuffer with FOR_RESUME at 4, 8 and 10 s.
3. AVPlay:
   - The raw formats of `GET_LIVE_DURATION` and `IS_LIVE`.
   - `seekTo(end − margin)` near the live edge.
   - Whether `setVideoStillMode` keeps the last frame visible during a reconnect.
4. Stalls per hour and memory growth over 2 h, per engine and preset, on Wi-Fi and on Ethernet.
5. Key → frame p95, idle versus playing, AVPlay versus MSE.
6. Whether the `getVideoPlaybackQuality()` counters advance on Tizen/webOS MSE. Frozen-video detection needs them.
7. `enableWorker: true` for mpegts.js on Tizen 6 (M76) and webOS 6 (Chromium 79). Does it play, and does key response improve?

## Live delay follow-ups (deferred from the review)

- When a recording or file ends, the screen gives no feedback: the status stays `playing` on a frozen frame. Add an "Ended" state.
- `.ts` files, and native files reporting an infinite duration, are treated as live, so they reconnect when they end. Detect a file from `LOADING_COMPLETE` arriving with much more buffered than a live stream could hold.
- While the page is hidden, `buffering`→`playing` events still count as stalls (only the tick pauses).
- `notifyUserAction()` is not wired to anything yet; there is no user seek or pause.
- The reconnect budget resets on every give-up retry, so a source that keeps failing soon after starting loops through 5-minute give-up windows.
- `openCurrent` reapplies the current preset on every reconnect, while the delay controller keeps the preset it had at `play()`.
- The learned raise is per source and shared by all of its channels.
- Stall ladder tuning:
  - With 0.1–0.5 s buffered, a stall waits for the 8 s backstop.
  - Gap jumps delay `seekLive` to about 4 s.
  - Tune both with measurements from the live lab.
- AVPlay `behindLiveS` can be up to 2 s too high because the edge is cached; extrapolate it. AVPlay `seekToLive` ignores asynchronous seek failures.
- Test gaps:
  - Overlay 30 s cap and destroy.
  - hls.js `softReload`.
  - `livePill` boundary.
  - Budget exhaustion on a tick reconnect.
  - Malformed `GET_LIVE_DURATION`.
  - Edge cases in `liveTargets`.

## Companion deployment (first real deploy)

- **First `pnpm relay:deploy`:** confirm the Durable Object migration (`new_sqlite_classes`) applies under
  `--env production` (the `[[migrations]]` block is top level).
- **Logging check** in the Cloudflare dashboard after the first deploy (Workers Logs off, no Logpush for the relay
  host); see [deploy-companion.md](deploy-companion.md) §9.
- **GDPR review** of the relay (Cloudflare as processor, DPA, privacy policy text) before anyone else uses it.

## v1.1 follow-ups

Open items from the Plan 3 and Plan 4 reviews and the v1.1 end-to-end pass.

Done in the v1.1 final review:

- ~~Companion: the TV does not push source changes made on the TV itself.~~ **Done:** while a companion is
  connected, the TV pushes a coalesced `state` (300 ms, single-flight, cached) when the active source, the source
  list or the channel set changes.
- ~~Companion: `layoutChanged` carries no source id.~~ **Done:** protocol 1 (unshipped) now has `sourceId` on `ops`
  and `layoutChanged`; ops for a source that is no longer active fail with `WrongSource` and the companion resyncs.
- ~~App API: a connected companion gets a layout push per zap (`markWatched`).~~ **Done:** a batch that only changed
  "recently watched" is not pushed. (`markWatched` still writes the whole layout to storage on every zap.)
- **Done:** one field-limit contract (name `NAME_MAX`, URLs and credentials 8192) for the TV form, the companion form
  and `validateSourceInput`; the companion validates every request with `isPhoneToTv` before sending it.
- **Done:** the wordmark hides under in-screen overlays and is drawn after the cold start.
- **Done:** production builds warn about missing `VITE_RELAY_URL` / `VITE_COMPANION_ORIGIN` (`REQUIRE_PROD_ENV=1`
  fails them); the API-floor guard covers `crypto.randomUUID`, `TextDecoderStream` and block comments.

Still open:

- Companion: the Sources page's Set active, Edit and Refresh buttons have no source name in their accessible name
  (Delete has one). Add `aria-label`s like `Set ${name} as active`.
- App API: `markWatched` writes the whole layout to storage on every zap. Keep "recently watched" out of the
  stored layout, or debounce the write.
- App API: `deleteSource` should take the layout lock; `loadLayout` migration runs outside the lock; guide coverage
  is not updated atomically with the guide generation; no test for a layout op during a refresh.
- App API: logo URLs from the user's playlist can carry tokens; they go to the companion (end-to-end encrypted). Consider
  dropping query strings from logos in the companion state.
- Core: table-driven test for `withLayout` invalidation; document that the index cache reuse relies on
  copy-on-write layouts.
- Protocol: sweep the `Reassembler` on `setTransport` / close; use a monotonic clock (`performance.now`) for
  reassembly and queue ages.
- Relay: retry the per-IP key derivation when it rejects; `forwardedBytes` wording in the code and README.

## Remaining technical items

| Item | Notes |
|---|---|
| **Multi-tab EPG locking** | Per-source locks live in one worker. Two browser tabs (or a future second worker) can refresh the same source's guide at once. Needs a cross-context lock (Web Locks API where available) or a single owner. |
| **Tizen file-URL module/worker verification** | The built entry is a module script and the worker is loaded relative to the chunk. Confirm both load from the widget's `file://` URL on a real TV; fallbacks are a Blob / inlined classic worker or `@vitejs/plugin-legacy`. |

## Polish backlog

Small items from the implementation reviews that v1 ships without.

- Core: `redactUrl` matches only lower-case `username` / `password` query keys.
- Core: guide name matching (normalize) does not fold ø, æ or ß.
- Core: 32-bit `fnv1a` channel ids (collisions are suffixed); consider a wider hash.
- Core: thin edge-case tests in utils; `uniqueId` not tested end to end through `m3uEntriesToChannels`.
- M3U: `#EXTGRP` before `#EXTINF` is ignored.
- Channel index: duplicate favourite ids not de-duplicated; `byNumber` is O(n).
- Storage: `done()` loses request-level error detail; channels are stored as one record per source.
- Xtream: base64 decoding may garble plain-text titles; credential query built twice in the client.
- EPG: matcher fallback for undeclared ids untested; overlapping "now" programmes depend on order.
- EPG: migration of legacy (pre-generation) guide data untested.
- Streams: the `responseText` cancel test is timing-sensitive; its `url` parameter is unused.
- Fake provider: the XMLTV writer ignores backpressure.
- Net: `withTimeout` leaves one `{ once }` abort listener per request on a shared signal.
- App API: `updateSource` / `clearCache` run outside the per-source queue; small gap between deleting a source and clearing its meta keys; `refresh` reads the active source before queuing; `deleteSource` can wait on a long guide refresh (needs a busy state in the UI).
- App API: a guide that cannot be read is reported like a network failure, so the offline badge shows.
- App API: the offline badge shows for parse/stall errors (an unreadable list or guide, or a stalled body, is a status-less `SourceNetworkError`).
- Player supervisor: events without `attemptId` are accepted.
- Player: extensionless HLS URLs (mpegts.js → HLS retry): retry covered by unit tests only; not verified end to end.
- Dev proxy: security checks (same-origin, header strip) untested; path constants duplicated; DNS-rebinding protection relies on Vite `allowedHosts`.
- HTML5 player: hls.js teardown is not wrapped in try/catch.
- Shell: overlays are not screen-scoped; document a cleanup rule.
- Input: `captureTextInput` and `unwrapDevProxyResponse` untested.
- Home: preview panel flickers after the debounce; "No information" gap rows never expire; `stopPreview` naming.
- Player screen: jump-guard wiring covered only by helper tests; a focus hint outside the remembered group falls back to memory.
- Search: real-TV timing of keystroke-to-paint and heap with the title index loaded (Tizen dev build).
- Search: import overhead of the title index on device. The spec target is < 5 % of the real guide import (parse plus IndexedDB writes); measure it on a Tizen dev build with a large synthetic guide. On desktop, `packages/core/perf/search.perf.ts` replaced the parse-only ratio test with an absolute builder budget (add + build < 1 µs per pre-parsed programme, median of 5) and a retained-heap check after an import (< 30 MB at 2000 × 270 programmes).
- Home search bar: one Down in the groups column while searching ends the search (choosing a group); consider requiring Ok. Typing during cold start skips the last-channel resume. A remote `layoutChanged` does not re-run the open query. `Home.tsx` (~1100 lines) should get a `useHomeSearch` controller plus an integration test.
- Home search bar: hosted TV targets (Titan OS, Vidaa) may send Backspace for the remote's Back; the focused bar consumes Backspace, so confirm what they send before shipping them.
- Pointer: on an LG webOS device or emulator, check that Magic Remote Ok does not send both a click and Enter (if it does, ignore a logical Ok within ~50 ms of a pointer click), and check `cursorStateChange`.
- Pointer: confirm in Chrome and WebView2 (Tauri) that the mouse back/forward buttons never navigate history.
- Pointer: browser checks still to do by mouse: add a whole source, wheel zapping in the Player, Manage on phone, and the search bar's ⌨ button.
- Pointer: `pointer.ts` has no DOM-level tests (fake-window harness); hit rects ignore node `scale`; the ⋯ hit zone is larger than the drawn pill.

## Follow-ups from the v1.1 merge review
- Source switch can push two full states. Call `companionStale()` once after `activate()` in the source operations.
- Home `dismissAll()` on remote `sourcesChanged` should only run when the active source actually changed.
- Background guide/playlist refresh pushes up to two full states to a connected phone; consider a delta or coalescing across both.
- `getCompanionState` should capture `activeSourceId` together with the index.
- Tests: an op interleaved with an in-flight `setActiveSource`; `pushState` across a link drop and reconnect; latest-wins guard in `followSources`.
