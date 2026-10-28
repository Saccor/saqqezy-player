# Performance on the Samsung Odyssey OLED G9 (<model>, Tizen)

Research date: 2026-10-19. Branch `claude/g9-perf-27cd15`, based on `feat/tizen-g9-beta` (a4a4624).

## What the user reported

- Slow in every area: cold start, moving focus, opening screens (Guide, Movies), and channel switch / first frame.
- Sources: over 100,000 items in total (live channels plus movies and series).
- The app shows a letterboxed 16:9 picture that looks "like a 27 inch" screen in the middle of the 49-inch panel. On a 5120×1440 panel, a 16:9 area that high is 2560×1440 physical pixels. The user wants the full width later.
- No Diagnostics numbers (viewport, pixel ratio) yet. They are the first thing to read on the next install.

## Bottom line

On a PC with a 6× slower CPU, the app does not look slow. Focus moves cost no long tasks and 4 frames per key press. Cold start is busy for about 0.7 s. So the G9 slowness most likely comes from things a PC does not reproduce:

1. A drawing buffer larger than 1080p, on a TV-class GPU.
2. Real-world data volume and images: 100k items, real logos and posters.
3. A slower CPU and storage than 6× throttling models.

Three fixes are in this branch: the render cap, the measurement lines, and lazy engines. Data and image costs need numbers from the device first.

## Causes, ranked by likely impact

Confidence: **High** = measured or read from code. **Medium** = inference from code plus a measurement elsewhere. **Low** = reasoning only.

### 1. The canvas draws more than 1920×1080 pixels (likely; fixed)

- `main.tsx` sets `deviceLogicalPixelRatio = designScale()` and leaves `devicePhysicalPixelRatio` at its default, `window.devicePixelRatio` (renderer 3.7, `Renderer.js`). The canvas buffer is `1920 × logical × physical` wide. (High, from code)
- If the G9 presents the 16:9 app area at 2560×1440, it does so in one of two ways: a 1920×1080 viewport with pixel ratio 1.33, or a 2560×1440 viewport (design scale 1.33). Either way the buffer becomes 2560×1440, which is 1.78× the pixels. Emulating both in Chrome gave canvas buffers of 2559×1439 and 2560×1440. (High for the arithmetic; Medium that the G9 is in that state, from the "27 inch" description)
- Cost: every frame fills 1.78× the pixels, through rounded-corner and border shaders. Every text texture (CanvasTextRenderer uses `devicePhysicalPixelRatio`) is rasterised and uploaded at 1.78× the size. TV GPUs are sized for 1080p UIs. A desktop GPU hides this, so the PC frame times did not change (4 ms either way). (Medium)
- **Fix (commit 58306dc):** `video/renderScale.ts` `renderPixelRatios(platform)`. On Tizen and webOS the buffer is capped at 1920×1080 and the compositor upscales it. The canvas still fills the viewport in CSS pixels. Smaller viewports are never supersampled. Desktop and browser are unchanged. This is the standard TV-app practice.
- **G9 check:** Settings > Diagnostics should now show `Render 1920×1080`, whatever the Viewport and Screen lines say. Compare the debug HUD's "slowest frame" while scrolling, before and after.

### 2. Data volume on a TV CPU and storage (likely for "opening Movies/Guide" and cold start; not fixed)

- All parsing and indexing runs in the worker, and lists are windowed (`components/virtualWindow.ts`, `screens/sliceCache.ts`). So the UI thread stays free, but content arrives late. (High, from code)
- Numbers from `pnpm test:perf` on this PC (60k movies in 80 categories): 13.2 MB stored, about 31 MB resident heap, 107 ms for the first sorts. The VOD search index takes 300–600 ms to build. The title index for 540k programmes takes about 490 ms. A TV core is often 5–15× slower than a desktop core, and its IndexedDB sits on eMMC. So the first open of Movies could take seconds on the G9. (Medium: scaled from PC numbers)
- 50k channels with guide data started instantly here. Worker busy time at start was about 80 ms at 6× throttling. Live TV cold start is probably not dominated by the worker. (High here, Medium on the TV)
- **Next:** read `Startup` in the debug HUD on the G9. Time the first and second opens of Movies. If the first is slow, the candidates are a leaner stored catalogue format (no full JSON parse of 13 MB) and building the search index later or incrementally.

### 3. Images: logos and posters decoded at full size (likely for focus moves and poster scrolling; not fixed)

- `main.tsx` already documents that renderer 3.7 decodes images at natural size. A 600×900 poster costs about 2 MB of GPU memory even when shown at 188×282. Provider artwork is often larger (1000×1500 and up). The texture budget is 100 MB (`criticalThreshold`), so a Movies screen plus prefetch can hit it. The renderer then frees off-screen textures, and scrolling back decodes them again. (Medium)
- Every new channel row that scrolls into view loads its logo: a network fetch plus a decode in the image worker. (High from code; cost unmeasured)
- The synthetic test source has no logos and only SVG posters, so this was **not** measured here.
- **Next:** check the HUD's slowest frame while scrolling posters on the G9. The real fix is a decode-time resize (`createImageBitmap` with `resizeWidth`/`resizeHeight`, which the renderer's image worker does not pass), already planned as Plan 4/5.

### 4. 1.5 MB of JavaScript parsed at every start (measured; fixed for Samsung)

- The production bundle was 1,556 kB minified, a single chunk. hls.js and mpegts.js made up 858 kB of it. On Samsung they are never used, because AVPlay plays everything. (High)
- With a 6× throttled CPU (median of 5 runs, Chrome, same data), stubbing the engines moved first paint from 280 ms to 236 ms (−16%) and "main thread busy until" from 728 ms to 662 ms (−9%). Packaged apps load from a file URL and likely get no V8 code cache, so the TV pays the full compile on every start. (High for the measurement; Medium for code caching)
- **Fix (commit 1aa1e0a):** the engines are now a separate chunk (`video/mseEngines.ts`, 856 kB). `Html5Player` loads it when created, and `open()` waits for it. The main chunk is now 701 kB. Samsung never loads the engine chunk. Browsers still load it right after start (first paint at 6× went from 280 to 256 ms).

### 5. Draw calls and text textures per frame (unlikely to matter alone)

- Home draws about 110 WebGL draw calls per frame. One focus move renders 4 frames. Scrolling the channel list re-rasterises about 10 text textures (about 93 KB) per key press. At 6× CPU throttling, none of this produced a long task: p95 frame 4 ms, worst 17 ms. (High on PC)
- On a weak GPU, 110 draw calls with SDF-style corner shaders add up. With cause 1 at 1.78×, it adds up more. SDF text (deferred in `STACK.md`) stays deferred until the HUD shows text-bound frames.

### 6. Channel switch and first frame (device and stream bound; not measured)

- Switching goes through AVPlay's `open`/`prepareAsync`, whose time depends on the stream and the TV's demuxer. Our UI side was not measured on the device. Nothing in the code blocks the UI on it. (Low)
- **Next:** on the G9, compare zap time on the same stream in another player app. If ours is clearly slower, profile the AVPlay path (prepare, buffering settings) separately.

### Ruled out

- **Source maps and dev code:** none in the build (`sourceMappingURL` count 0). The `__iptv` debug handle and dev-proxy routes are behind `import.meta.env.DEV`. (High)
- **Idle redraws:** 0 frames and 0 draw calls in 5 idle seconds on Home. The renderer only draws on change. (High)
- **Non-virtualised lists:** the channel list, Guide, VOD grids and settings lists use windowed rendering. (High, from code)
- **Parsing on the main thread:** M3U, Xtream and XMLTV parsing, plus indexing, run in `worker.ts`. (High)

## Remote debugging on the G9

- Apps2Samsung (`C:\Program Files\Apps2Samsung`) is a self-contained .NET app. It ships no `sdb` binary and offers no inspector. (High, from the folder listing)
- A real trace on the device needs Samsung's `sdb`, from the Tizen Studio CLI. You launch the app in debug mode (`sdb shell 0 debug IptvPlyr01.IptvPlayer`), which prints a port, then open Chrome DevTools at `http://<tv-ip>:<port>`. That needs Tizen Studio installed, and the app signed with a matching certificate. It was **not** installed: the brief says to ask first. (Medium, from Samsung's docs on Web Inspector debugging)
- Until then, the on-device numbers are Settings > Diagnostics (Viewport, Screen, Render) and the debug HUD (Info ×3, or Settings > Diagnostics > Show debug overlay): startup ms, FPS, slowest frame of the last second, render size, JS heap. (Commit 68a2516)

## Method (reproducible, tools kept outside the repo)

- Synthetic source: `startFakeXtream({ channels: 50000, epgChannels: 3000, movies: 55000, series: 3000 })`.
- Chrome profile with web security off (the fake server sends no CORS headers; Tizen allows any origin through `config.xml`). Seeded through the dev build's `__iptv.api.addSource`. The production build was then served on the same origin, so it reads the same IndexedDB.
- A small CDP driver over Node 22's built-in `WebSocket`, with no new packages. It sets device metrics (1920×1080 at DPR 1 and 1.33, and 2560×1440), CPU throttling 6×, a long-task observer, a rAF frame log, and WebGL call counters, and sends key presses.
- `pnpm test:perf` for the core numbers.

## Follow-ups

1. **On the G9:** reinstall, then read Diagnostics (Viewport, Screen, Render) and the HUD while (a) starting, (b) scrolling channels, (c) opening Movies twice, (d) scrolling posters. These numbers decide whether 2 or 3 comes next.
2. Image decode-time resize, which fixes poster scrolling and texture memory (Plan 4/5).
3. A lighter stored VOD catalogue, or a lazy index, if the first Movies open is slow on the device.
4. Full-width 32:9 mode (`base_screen_resolution = extensive`). With the render cap, a 3840×1080 viewport would still draw a 1920-wide design area. A responsive layout is needed first.
5. Optional: Tizen Studio CLI for real traces, if the user approves installing it.
