# Architecture decisions

Short records of the decisions that shape this codebase. Each one says what was decided, what forced it, why
this option won, and what it costs. The hard rules behind several of them are in [GUARDRAILS.md](GUARDRAILS.md);
the TV stack details are in [apps/tv/STACK.md](../apps/tv/STACK.md).

## 1. The TV UI renders with Lightning 3 and SolidJS on a WebGL canvas, not the DOM

- **Decision:** `apps/tv` uses `@lightningtv/solid` on `@lightningjs/renderer` (WebGL). The canvas clears to
  transparent and the video plays underneath it; the UI leaves a hole where the picture shows.
- **Context:** the target is a remote-first player that stays smooth with 50k+ channels on low-end TV hardware, and
  Tizen 6.0 (Chromium 76) is the floor.
- **Why:** Lightning was built for memory-constrained set-top boxes and draws only on change (0 frames in 5 idle
  seconds on Home). Solid's fine-grained signals update single nodes, with no virtual DOM diff per key press.
- **Trade-offs:**
  - A canvas has no accessibility tree, so TV screen readers see nothing. A hidden DOM mirror of the focused
    element is the planned answer and is not built yet.
  - Layout is manual. A node without an explicit size inherits its parent's, and the renderer stops updating
    anything it marks out of bounds (see the Start rows entry in [LESSONS.md](LESSONS.md)).
  - `@lightningtv/solid` is marked deprecated in favour of a fork on a different renderer. Moving is a separate,
    deliberate decision.

## 2. Parsing, indexing and storage run in a Web Worker behind a typed RPC

- **Decision:** `@iptv/core`, `@iptv/storage` and `@iptv/app-api` run in one worker. The UI calls `api.method(...)`
  through `wrap<AppApi>(worker)` ([rpc.ts](../packages/app-api/src/rpc.ts)) and listens to typed events.
- **Context:** M3U lists of 50k channels, XMLTV guides of hundreds of MB and VOD catalogues of 180k titles must never
  block a key press.
- **Why:** one boundary for everything heavy. The `Remote<T>` type keeps the UI and the worker in step at compile
  time. `expose()` serves only an explicit method list, and errors cross as name, message, status and code only.
  In the production build the core lives only in the worker chunk.
- **Trade-offs:**
  - Every call is async and its arguments are copied. The UI keeps windowed slices, never whole lists.
  - A single worker serialises long jobs: a first guide import may hold the API for up to 150 ms (budgeted in
    `guideImport.perf.ts`). A second worker for background jobs is a known follow-up.

## 3. Client-only media: our servers never touch streams, playlists or guides

- **Decision:** every stream, playlist and guide request goes from the device straight to the user's source. Nothing
  we run proxies, relays, transcodes or caches them ([GUARDRAILS.md](GUARDRAILS.md) rule 6).
- **Context:** the app is a neutral player for the user's own sources. A server in the media path would make us a
  party to what flows through it, would see the user's credentials, and would cost bandwidth per viewer.
- **Why:** legal neutrality, privacy (credentials never leave the device) and a running cost that does not grow with
  viewing.
- **Trade-offs:**
  - Most sources send no CORS headers, so a plain browser tab cannot reach them. The dev proxy in
    `apps/tv/vite.proxy.ts` exists only inside `vite dev`, refuses to run in production or on a LAN address, and
    sends no CORS headers. The browser build is a developer tool; a desktop shell is the planned PC product.
  - We cannot fix a broken source server side. All robustness (retries, cooldowns, failover) has to live in the
    client.

## 4. The phone companion pairs end to end through a relay that stores nothing

- **Decision:** the phone page and the TV talk through a Cloudflare Worker with one Durable Object per pairing
  session ([services/relay](../services/relay/README.md)). It forwards opaque binary frames and keeps no storage. There
  is no account system and no sync backend.
- **Context:** typing playlist URLs and passwords with a remote is the worst part of setup. The guardrails forbid us
  from ever reading credentials.
- **Why:** pairing secrets come from a QR code or a typed code stretched with PBKDF2 (200,000 iterations). Frames are
  AES-GCM with replay protection. The relay only ever sees ciphertext, so a breach of it leaks nothing useful.
- **Trade-offs:**
  - No cloud backup or multi-device sync. Any future sync must be end-to-end encrypted too.
  - Abuse control without identities: per-session frame, byte and lifetime limits, plus a new-session limit keyed on
    an HMAC of the IP prefix and shared across isolates through the Workers Rate Limiting binding.
  - Sessions are short-lived (15 minutes unpaired, 60 minutes paired), so the companion is a setup tool, not a
    remote control that stays connected.

## 5. Native player pipeline first; hls.js and mpegts.js only as fallbacks

- **Decision:** on Tizen the app plays through AVPlay. On other TVs the `<video>` element plays HLS natively when it
  can. hls.js and mpegts.js are used only where the platform has no native path, and load as a separate chunk
  (about 856 kB minified) only when needed.
- **Context:** live sources serve HLS and raw MPEG-TS, often HEVC with AC-3 or E-AC-3 sound. Platform demuxers and
  hardware decoders handle these; MSE in JavaScript handles only part of them
  ([live-latency R2](research/live-latency-2026-10/r2-tizen-webos.md)).
- **Why:** native pipelines decode what browsers cannot, use the TV's hardware path and spend no UI-thread time on
  demuxing. Keeping the MSE engines out of the start bundle saves Samsung devices parsing code they never run.
- **Trade-offs:**
  - Two player implementations behind one `Player` interface, each with its own error mapping. The
    `PlaybackSupervisor` in `@iptv/player` keeps reconnect and stall logic shared.
  - On desktop Chrome some files play without sound or without a track list; the app can only say so (see
    [LESSONS.md](LESSONS.md)). The planned fix there is a native player (libmpv), not more JavaScript.

## 6. A pure TypeScript core, tested against synthetic data only

- **Decision:** parsers, the Xtream client, the channel index, search, folding and settings live in `packages/*` with
  no UI or platform code. They are written test-first against hand-made fixtures, and a local fake provider
  (`tools/fake-xtream`) serves synthetic channels, guides, movies and series.
- **Context:** the product ships no content, and test data must not point at real channels or sources
  ([GUARDRAILS.md](GUARDRAILS.md) rule 1).
- **Why:** the same core will back the planned Android, Apple and desktop shells. Synthetic fixtures can be shaped
  for edge cases real data rarely shows (broken charsets, guides without stop times, special usernames for expired
  or slow accounts) and can be published.
- **Trade-offs:**
  - Synthetic data misses real-world volume and quirks. Several problems only showed up with a real source on a
    real device (see [LESSONS.md](LESSONS.md)), so the fake provider grew modes for each one found.
  - The TV's old Chromium is enforced by a test that scans the sources for APIs newer than Chromium 76, not by the
    type checker.

## 7. Performance budgets are tests, and parsers stream

- **Decision:** `pnpm test:perf` runs budgets on generated data: a 50k-channel M3U parsed, indexed and searched in
  under 2 s, a ~100 MB XMLTV guide streamed with bounded heap growth, folding, search, catch-up and a 54k-channel guide
  import while the API keeps answering. The XMLTV parser consumes a byte stream and yields programmes as it goes.
- **Context:** "speed is the feature" is a product rule with numbers (1 s cached start, 100 ms key response), and
  guides can be larger than a TV's free memory if read whole.
- **Why:** a budget that fails in a test catches a regression before a device does. Streaming keeps peak memory
  flat whatever the guide size, and the first programme arrives after a few input chunks.
- **Trade-offs:**
  - Timings depend on the machine. CI runs the budgets as a signal (`continue-on-error`), not a gate, and some
    bounds are set to what is measured rather than to the target, with a comment saying so.
  - The device targets (300 MB guide on 1 GB of RAM, 1 s cold start) are still unmeasured.

## 8. Rare screens load lazily, and a build check guards the start bundle

- **Decision:** Settings, Multiview, the movie player, the countries screen and the QR code load on demand behind a
  route table with idle preload and a "Try again" view. [chunkCheck.mjs](../tools/build/chunkCheck.mjs) reads the
  build's source maps and fails when a lazy-only module reaches the entry chunk or anything it imports statically.
- **Context:** the first profile on the Samsung device showed a cold first start of about 4.4 s to first paint.
  Every byte in the start bundle is parsed and compiled on each launch on a 32-bit TV CPU.
- **Why:** a code-split is easy to undo by accident with one static import. A check that names the offending module
  keeps the split in place.
- **Gap:** the check runs by hand on a `vite build --sourcemap` build; only its unit tests run in CI.
- **Trade-offs:** a lazy screen has to claim focus while it loads, or key presses reach the screen left behind
  (fixed twice: `1d097ad`, `be905fb`). A failed chunk load needs its own recovery path.
