# apps/tv UI stack (decided in the Plan 2 Task 4 spike)

Tasks 5–11 follow these versions and idioms. Change them only on purpose, and update this file in the same commit.

## Versions (exact pins in `apps/tv/package.json`)

| Package | Version | Role |
|---|---|---|
| `@lightningtv/solid` | 3.2.5 | Solid universal renderer for Lightning 3, plus primitives (`Row`, `Column`, `useFocusManager`, ...) |
| `@lightningjs/renderer` | 3.7.0 | Lightning 3 WebGL renderer |
| `solid-js` | 1.9.17 | Reactivity |
| `@solidjs/router` | 0.15.4 | Peer dependency of `@lightningtv/solid` (its primitives import it) |
| `hls.js` | 1.7.3 | HLS where the platform has no native HLS |
| `mpegts.js` | 1.8.2 | Live MPEG-TS (`.ts`) over MSE |
| `vite` | 8.3.4 | Dev server and build |
| `vite-plugin-solid` | 2.11.14 | JSX compile, universal mode |

Notes:
- npm marks `@lightningtv/solid` as deprecated ("Moved to `@solidtv/solid`"). The successor (`@solidtv/solid` 1.x) targets a forked renderer (`@solidtv/renderer`), not `@lightningjs/renderer`. We stay on `@lightningtv/solid` 3.2.5 + `@lightningjs/renderer` 3.x as planned. Migrating is a separate decision.
- `@lightningjs/renderer` 3.7.0 declares `engines: node >= 22.13, pnpm >= 10.17`. The repo currently runs on Node 22.12 / pnpm 10.10. That only produces warnings, and it builds and runs fine.

## Build setup (`vite.config.ts`)

- `vite-plugin-solid` with `{ solid: { moduleName: '@lightningtv/solid', generate: 'universal', builtIns: [] } }`.
- `resolve.dedupe: ['solid-js', '@lightningtv/solid', '@lightningtv/solid/primitives']`. This keeps a single Solid and a single Lightning core.
- `optimizeDeps.exclude: ['@lightningtv/solid', '@lightningtv/solid/primitives']`. These packages ship untranspiled `.jsx`, which must go through the Solid plugin.
- `base: './'`, so the build works from a file URL.
- `worker.format: 'iife'` (classic worker in the build, since module workers need Chromium 80+; dev still uses a module worker).
- `IPTV_DEV_STABLE=1` (set by `pnpm dev:stable`): `server.hmr: false, ws: false`. Vite 8 still watches and invalidates changed modules, so F5 serves new code, but it never pushes an update or reload (and no "server restarted" reload, because there is no client socket). Plain `pnpm dev` is unchanged: saving a core, app-api or worker file reloads the whole page.
- `tsconfig.json` uses `"jsx": "preserve", "jsxImportSource": "@lightningtv/solid"`.

## Renderer creation (`src/main.tsx`)

```ts
import { Config, createRenderer, registerDefaultShaders } from '@lightningtv/solid';
import { WebGlRenderer } from '@lightningjs/renderer/webgl';
import { CanvasTextRenderer } from '@lightningjs/renderer/canvas';

Config.fontSettings = { fontFamily: 'sans-serif', fontSize: TYPE.body, color: COLORS.text };   // tokens from shell/theme.ts
const { render, renderer } = createRenderer({
  appWidth: 1920, appHeight: 1080,
  deviceLogicalPixelRatio: ratios.logical,   // designScale(): min(innerWidth/1920, innerHeight/1080)
  devicePhysicalPixelRatio: ratios.physical, // TVs: buffer capped at 1920x1080 (renderPixelRatios)
  clearColor: COLORS.transparent,            // fully transparent: video shows through
  renderEngine: WebGlRenderer,
  fontEngines: [CanvasTextRenderer],
}, document.getElementById('app')!);
registerDefaultShaders((renderer as RendererMain).stage.shManager);   // needed for borderRadius / border / shadow
window.addEventListener('resize', () => (renderer as RendererMain).setOptions({ /* renderPixelRatios(platformId) */ }));
render(() => <App />);
```

- Render resolution: `video/renderScale.ts` `renderPixelRatios(platform)`. The canvas always fills the viewport in CSS pixels. On TVs (Tizen, webOS) the drawing buffer is capped at 1920x1080 and the compositor upscales it; a smaller viewport is never supersampled. Desktop and browser keep `devicePixelRatio` for sharp text. Without the cap, a 1440p graphics plane (likely the Odyssey G9) or a 4K one fills 1.8x or 4x the pixels per frame and rasterises every text texture larger. Settings > Diagnostics (Render line) and the debug HUD show the buffer size. Research: `docs/research/g9-performance-2026-10.md`.

- Without `registerDefaultShaders`, every `borderRadius` or `border` logs "ShaderType not found" and draws square corners.
- `createRenderer` returns `RendererMain | DOMRendererMain`. Cast it to `RendererMain` for `stage` and `setOptions`.

## Video under the canvas

- `index.html` contains `#video-layer`, absolutely positioned at `z-index: 0`, holding `.video-box > <video>`. It also contains `#app` (the canvas) at `z-index: 1`.
- `videoLayer.ts` maps a design-space `Rect` to CSS pixels with the same `designScale()` the renderer uses, and exposes `setRect(rect | 'fullscreen')`, `setAspect`, `relayout`.
- To show video, draw nothing over the region. A "hole" is the absence of nodes, because the canvas clears to transparent. Semi-transparent nodes (`0x0b0d12e6`, scrims at `...a0`) blend over the video correctly.
- Aspect: `auto` uses object-fit `contain`, `stretch` uses `fill`, `zoom` uses `cover`. `16:9` and `4:3` use a fixed-ratio box, contained in the rect, with the video set to `fill`.

## Components: `View` / `Text`

```tsx
import { View, Text, For, Show } from '@lightningtv/solid';
import { createSignal, onMount, onCleanup } from 'solid-js';      // Solid primitives come from solid-js

<View x={96} y={54} width={240} height={135} color={0x151a24ff} borderRadius={12}
      border={{ width: 4, color: 0x4f8cffff }} scale={1.06} />
<Text x={20} y={48} fontSize={30} color={0xe8eaf0ff}>{`Last key: ${k()}`}</Text>
```

- Nodes are absolutely positioned (`x`, `y`, `width`, `height`). Always give containers explicit sizes.
- Colours are `0xRRGGBBAA` numbers (or `'#rrggbbaa'` strings). There is no CSS, no `style` string and no `class`.
- Give `Text` a single string child. The spike always builds it with a template literal; mixed static and dynamic children were not tested.

## Focus and keys

- Call `useFocusManager(LIGHTNING_KEY_MAP)` once, in the root component. It comes from `@lightningtv/solid/primitives`.
- `src/input/keys.ts` (`installKeys()`) is the only raw key listener. It listens on `window` with `capture: true` and stops raw events, so Lightning never sees device keys. It maps each key through `@iptv/platform` `mapKey(detectPlatform(...))` and re-dispatches a synthetic `KeyboardEvent` whose `key` is the logical name on `document`. Lightning's focus manager listens there.
- `LIGHTNING_KEY_MAP` maps each logical name to itself, except Ok, which maps to Lightning's `Enter`. Handlers on focused nodes are:
  - `onUp`, `onDown`, `onLeft`, `onRight`
  - `onEnter` (Ok), `onLongOk`, `onBack`, `onMenu`, `onInfo`
  - `onChannelUp`, `onChannelDown`, `onPlayPause`
  - `onPlay`, `onPause`, `onStop`, `onFastForward`, `onRewind` (media keys). A handler that treats Stop as leaving the player does it through `sendKey('Back')`, so the layered Back logic runs.
  - `onRed`, `onGreen`, `onYellow`, `onBlue`
  - `onDigit0` through `onDigit9`
  - `on<Key>Release` for key-up

  Return `true` to stop bubbling up the focus path.
- `onLogicalKey(fn)` registers global observers. They are called for every logical key, after the focus path has had it.
- **Ok is decided on release.** A release before 600 ms gives `Ok` (`onEnter`). Holding for 600 ms gives `LongOk` (`onLongOk`), and no `Ok` follows. Key repeats and repeated keydowns without `repeat` are ignored while Ok is held.
- Focus visuals: `onFocusChanged={setFocused}`, with a per-item signal driving `color` and `scale`. `autofocus` goes on exactly one element per screen. `forwardFocus` passes focus to children.

## Row / Column

```tsx
import { Row, Column } from '@lightningtv/solid/primitives';
<Column x={96} y={180} width={1032} height={460} gap={24} scroll="none" autofocus>
  <For each={rows}>{(row) =>
    <Row width={1032} height={135} gap={24} scroll="none" selected={col()} onSelectedChanged={setCol}>
      <For each={row}>{(t) => <Tile .../>}</For>
    </Row>}
  </For>
</Column>
```

- `Row` handles Left/Right and `Column` handles Up/Down. Both are flex containers (default `gap` 30) and forward focus to `selected`.
- A Column moving into a Row focuses that Row's own `selected`. For grid-like column memory, share one `selected` signal across rows as shown above, or use the `Grid` / `VirtualGrid` primitives.
- Lists over about 20 items should use `VirtualGrid` / `Virtual` (constraint: visible rows plus a ~10-item buffer).

## Fonts

- The engine is `CanvasTextRenderer`, using the platform's built-in `sans-serif` face. The renderer registers it by default. No font files are bundled.
- To add a web font later, call `renderer.stage.loadFont('canvas', { fontFamily, fontUrl })` directly. `loadFonts()` from `@lightningtv/solid` skips canvas fonts when the renderer is WebGL.
- SDF (`SdfTextRenderer` from `@lightningjs/renderer/webgl` plus msdf/ssdf atlases) is faster for large amounts of text, but needs generated atlas assets. Defer it until text performance on a TV demands it.
- When a `Text` node's content changes, it is blank for a frame or two while the canvas texture is regenerated.
- Never put two spaces in a row in `Text` content. The canvas text layout measures runs of spaces as one, so the texture is too narrow and the last glyphs are clipped (`"Next: Programme 13"` drew as `"Programme 1"`). Use a single space or a separator such as ` · `.
- Semibold: `STRONG` in `shell/theme.ts` (spread on `<Text>`). `fontWeight` is not used: @lightningtv/solid appends it to the family name. The weight travels in `fontStyle` ("normal 600"), which the canvas renderer puts first in its CSS font string ("normal 600 26px Unknown, sans-serif"). Re-check on each TV model: if text turns tiny or changes face, set `STRONG = {}`.

## Image loading

- Use `<View width={64} height={64} src={url} />`. The renderer fetches the image and decodes it with `createImageBitmap`.
- The spike uses a runtime-generated PNG `data:` URL. Remote images (channel logos) need CORS or the dev proxy on desktop. TVs fetch directly.
- The renderer retries failed textures according to `maxRetryCount`.
- SVG URLs (`.svg`) take another path: the renderer draws them through an `<img>` onto a 2D canvas and reads them back with `getImageData`. Stock renderer 3.7 never sets `crossOrigin` there, so any cross-origin SVG (the fake provider's posters, SVG channel logos) tainted the canvas and threw a `SecurityError` even with `Access-Control-Allow-Origin: *`. `main.tsx` passes `platform: CorsWebPlatform` (`shell/corsPlatform.ts`), the stock `WebPlatform` whose `loadSvg` sets `crossOrigin = 'anonymous'` first (`shell/svgLoad.ts`, unit-tested). A CORS-enabled server now draws; when the CORS load fails, the image is loaded once more without `crossOrigin` (as before): packaged TV apps may draw it untainted, elsewhere the read throws and the fallback shows. Raster images are unchanged.
- Logo tiles (`components/logoKey.ts`) key their texture on the logo URL, never on the row object, so a refetched page, a re-used row while scrolling or a guide chunk load keeps the texture; a failed URL is remembered per tile and shows the fallback.

## Worker / RPC

- `src/api.ts` does `import CoreWorker from './worker.ts?worker'; const worker = new CoreWorker()`, then `export const { api, on: onEvent } = wrap<AppApi>(worker)`. Vite makes it a module worker in dev and a classic worker in the build (`worker.format: 'iife'`); the built URL is relative to the chunk (`new URL('worker-<hash>.js', import.meta.url)`).
- `src/worker.ts` builds `IdbStorage` → `withTimeout(routedFetch(fetch, rawViaDevProxy), 15 s)` → `SourceService` → `AppApi` (core asks for 90 s to first byte on playlist/XMLTV downloads and aborts a body after 30 s without data), then calls `expose(api, self, APP_API_METHODS)`. `emit` forwards `AppEvent`s as `(e.type, e)`.
- In the production build, `@iptv/core` ends up only in the worker chunk.

## Dev proxy

- `vite.proxy.ts` is used by `vite dev` only (`apply: 'serve'`) and throws if `NODE_ENV=production`. The pure rewrite logic lives in `src/dev/rewriteHls.ts` (unit-tested).
- Two routes, `GET`/`HEAD` only:
  - Upstream requests carry our own `DEV_USER_AGENT` (some providers reject Node's default) plus `range` where allowed; nothing from the browser (`src/dev/proxyHeaders.ts`, unit-tested).
  - Source headers: both routes read `&ua=` and `&ref=` after `u` (`src/net/headerParams.ts`): `ua` replaces the default user-agent, `ref` is sent as `referer`; a value with a control character or over 512 characters gets 400. They are secrets like `u`: never logged. The hls route carries the same `ua`/`ref` into every rewritten child URL. Without them nothing changes. The worker's `routedFetch` turns core's `FetchInit.sourceHeaders` into these parameters; `Html5Player` passes `OpenOptions.headers`.
  - `/__proxy/raw?u=<encoded url>` never rewrites anything. The worker uses it (`rawViaDevProxy`) for playlist, EPG and API fetches, so IPTV channel lists (M3U) come through byte for byte. `Range` is forwarded.
  - `/__proxy/hls/<file name>?u=<encoded url>` rewrites HLS playlists. `Html5Player` uses it (`hlsViaDevProxy`) for player URLs only. The file-name segment is cosmetic (only `u` is read) but native HLS in desktop Chrome sniffs the URL extension of playlists and segments. A body is rewritten only if the response is 2xx and contains `#EXT-X-`; only `http(s)` URIs are wrapped (`data:`, `skd:` stay), relative URIs are resolved against the final URL. Rewritten playlists are served as `application/vnd.apple.mpegurl`; `Range` is not forwarded for playlists.
- Security rules (the proxy is a local convenience, not a public relay):
  - No CORS headers at all (no `Access-Control-Allow-Origin`): it is same-origin only, so other sites cannot read through it.
  - 403 when `Sec-Fetch-Site` is present and is neither `same-origin` nor `none`, or when `Origin` is present and is not the dev server's own origin (host compared with the `Host` header). Same-origin page, worker and `<video>` requests pass.
  - `configureServer` throws if `server.host` is set to anything other than `localhost`, `127.0.0.1` or `::1` ("refuses to run when exposed to the LAN"). Do not use `--host`.
- Compressed upstream bodies: Node's fetch has already decoded them, so when upstream sends `content-encoding` the proxy forwards neither `content-encoding`, `content-length`, `content-range` nor `accept-ranges` (otherwise the browser truncates the body).
- `src/net/devProxy.ts`: `rawViaDevProxy(url)` and `hlsViaDevProxy(url)` are the identity in production (`import.meta.env.DEV`). In dev they also skip same-origin URLs and the fake provider at `127.0.0.1:8899` (unless the request has source headers: only the proxy can send them).

## Player

- `src/video/Html5Player.ts` implements `Player`:
  - `.m3u8`: natively on TVs when `canPlayType('application/vnd.apple.mpegurl')`; elsewhere through hls.js, native only when hls.js is unsupported. Desktop Chrome reports native HLS but its built-in player plays HEVC-in-TS (UHD channels) as sound over a black picture with no error, so desktop never prefers it.
  - `.ts` plays through mpegts.js with `isLive: true`.
  - Extensionless URLs (e.g. the Xtream short form `/{user}/{pass}/{id}`): the element only when `canPlayType('video/mp2t')` is non-empty, switching to mpegts.js if it fails before metadata (`readyState 0`); otherwise mpegts.js. Pure choice in `video/engineChoice.ts` (unit-tested). Core's `alternateStreamUrl` maps the short form to the canonical live path in the other format (extensionless or `.ts` to `/live/{user}/{pass}/{id}.m3u8`, `.m3u8` to `.ts`).
  - mpegts.js → HLS retry: when mpegts.js rejects an extensionless URL with a format error (`MEDIA_FORMAT_ERROR` / `MEDIA_FORMAT_UNSUPPORTED`) before metadata, the same URL is retried once as HLS, natively when the element plays HLS, else through hls.js (`nextEngineAfterFailure`, unit-tested). The mpegts.js instance is detached from the session inside its ERROR callback (its later errors are ignored); the teardown and the engine switch run in a `setTimeout(0)` after the callback has returned, never inside mpegts.js's call stack. A `stop()` in between still tears the old instance down and starts nothing. If hls.js then cannot parse the manifest, the error is `UNSUPPORTED` (neither engine fits). Covered by unit tests only (`Html5Player.test.ts` with mocked engines); not verified end to end.
  - In dev, `?hlsjs` forces the hls.js path on browsers that have native HLS.
- hls.js and mpegts.js live in their own chunk (`video/mseEngines.ts`, about 856 kB of minified code). `Html5Player` starts `loadMseEngines()` when it is created and `open()` waits for it before choosing an engine (later opens start synchronously), so AVPlay platforms never load it. A failed chunk load reports `MEDIA` (`detail: 'engineLoad'`) and the next `open()` retries.
- Each `open()` creates a session. `stop()` kills it, removes its listeners, and destroys the hls.js or mpegts instance. It then calls `removeAttribute('src')` and `load()`. Events from a dead session are dropped, and `detail.attemptId` is echoed on every event.
- Error mapping: `<video>` MediaError 4 is `NETWORK` (retryable) while `readyState === 0` (HAVE_NOTHING: the load itself failed, e.g. 404, refused, dropped) and `UNSUPPORTED` only once metadata has loaded (`readyState >= 1`). MediaError 2 is `NETWORK`, 3 is `DECODE`, the rest `MEDIA`. hls.js errors are reported only when fatal, or for `MANIFEST_INCOMPATIBLE_CODECS_ERROR`; codec errors map to `UNSUPPORTED`, other network errors to `NETWORK`. mpegts codec/format errors map to `UNSUPPORTED`. HTTP statuses: refusals (401, 403, 429, 458, 503, 509) are `AUTH` on both engines; **410 is not a refusal** (an expired stream starts no cooldown). A manifest or media-playlist load (`MANIFEST_LOAD_ERROR`, `LEVEL_LOAD_ERROR`) answered 400, 404, 410 or 5xx is `NETWORK` with `httpStatus` at once, without the in-place reload; other statuses ride on `NETWORK` as `httpStatus` too (mpegts.js `HttpStatusCodeInvalid`, hls.js after the in-place reload). The supervisor ends a VOD/catch-up play that has not played yet as `gone` on a 404/410 from the engine, exactly as on the probe's answer (the catch-up alternate first, and the alternate may be probed once more); live keeps the `NETWORK` path. An mpegts.js `MediaMSEError` for the audio SourceBuffer only (e.g. AC-3/E-AC-3 in desktop Chrome) is not an error: the video plays on silently and stream info marks the audio codec "(not supported here)".
- Sound the device cannot decode: desktop Chrome plays a file with AC-3 / E-AC-3 sound (common in films) as a silent picture with no error. `soundUndecodable()` is true when mpegts.js was refused the audio codec, or (computers only, never TVs, whose hardware decoders may not count) when the element decoded 0 audio bytes during 3 s of played picture (`webkitAudioDecodedByteCount`). VodPlay then shows "No sound: this device can't play this video's audio format." once. The real fix is a player that decodes it (TVs, Media3, libmpv). Test title: `node tools/fake-xtream/scripts/make-ac3.mjs` makes fake movie 2 an `.mkv` with AC-3 sound.
- **Audio tracks:** `vod/tracks.ts` holds the helpers both players share: `trackKey` (`<language>:<label>`, what a remembered choice stores), `findTrack`, `trackLabels` (bare language codes become English names, the codec family follows in parentheses, repeats get " (2)"), `trackRows` (the VOD picker), `preferredTrack` and `pickAudioTrack` (the remembered choice, else the first track in the Settings language, else nothing: the engine's default stays). `vodPlayerLogic.ts` and `subtitleLogic.ts` re-export what moved out of them.
  - **Preferred language:** Settings → Playback → Audio language (`AppSettings.audioLanguage`, 'auto' = "Stream default", or a language from the subtitle list). VodPlay's `applyTracks` and the live Player apply it once a stream plays; a language pick is applied but not remembered as the user's choice, so changing the setting later still takes effect.
  - **Live choice:** the live Player's Options → Audio track remembers the pick per channel as a `trackKey` through the worker (`api.setLiveAudio` / `getLiveAudio`: `liveAudio:<sourceId>` in the meta store, the latest 200 channels, cleared with the source), read once per channel per session. The page lists `trackLabels`; with one track it says "Only one audio track", with none "No audio track list for this stream".
  - **Codec in the label:** `TrackInfo.codec` is the family name (`codecFamily`: AC-3, E-AC-3, AAC, DTS, TrueHD, MP3, Opus) from an hls.js rendition's `audioCodec` or AVPlay's `extra_info.fourCC`; the native element gives none. The key never includes it.
  - **Fixture:** `node tools/fake-xtream/scripts/make-multiaudio.mjs` makes fake movie 3 a two-AAC-track title (English default, Svenska) as `.mkv`, `.mp4` and a `.ts` with two audio PIDs; the stream URL's extension picks the container. Desktop Chrome lists no tracks for mkv/mp4 (no `audioTracks` API) and mpegts.js keeps the first PID, so the picker shows "No audio track list" there; the HLS title from `make-multitrack.mjs` (movie 1) shows both. See `tools/fake-xtream/README.md`.
- mpegts teardown wraps each call (`pause`, `unload`, `detachMediaElement`, `destroy`) in its own try/catch so the element reset always runs.
- `installKeys` ignores key events whose target is an `<input>`, `<textarea>` or contenteditable element (no mapping, `preventDefault` or `stopImmediatePropagation`), so future DOM text entry works.
- Desktop autoplay policy: if `play()` is rejected with `NotAllowedError`, the player retries muted and remembers that the mute is its own (`video/autoMute.ts`, unit-tested). `onUserGesture` in `input/keys.ts` (every real keydown) calls `player.unmuteIfAutoMuted()`, which drops the mute only when `navigator.userActivation.isActive` is true at that keydown (or the engine has no `userActivation`): Esc and similar keys do not activate the page, and unmuting then would make the browser pause the preview. `open()` drops the mute when `navigator.userActivation.hasBeenActive`.
- Playback journal: `PlaybackSupervisor` gets `journal` (a `PlaybackJournal` from `@iptv/player`, created in `playback/playback.ts`) and writes one event per decision (play, open, playing, stall, ladder, error, reconnect, alternate, drift, failed, give-up retry, stop). `playback.ts` adds page load (with the navigation type, so dev reloads show), hidden and visible. Stored in `localStorage` `iptv.playbackJournal` (200 events, saves throttled to 1 s, flushed on `pagehide`); never URLs or credentials. Shown in Settings → Diagnostics → Playback log; `window.__playbackLog()` in dev.

## Catch-up (provider archive)

The URL is built in the worker (never logged; `/timeshift/` paths are masked) and played directly.

- **Data:** `Channel.cu = { mode, days, tpl?, corrMin? }` (two letters: the key is on every stored channel record, spec §8) (core `catchup/`): M3U `catchup*` attributes (the `#EXTM3U` line gives defaults), Xtream `tv_archive`. Templates are interned per source (`catchupTemplates:<id>` meta); equal catch-up records share one object so structured clone stays small. Rows carry `archiveDays`; the UI computes marks with `archiveStateOf` (`vod/catchupLogic.ts`, a mirror of core's `archiveState`).
- **Zone:** `pickZone` (core `catchup/zone.ts`): the source's Catch-up time, the playlist's `catchup-correction`, the Xtream `server_info.timezone` (when `Intl` passes the Stockholm check), its clock offset, else UTC. An M3U with `xc` channels probes `player_api.php` once per refresh (Auto only).
- **Guide:** history to the largest archive (max 7 days, `api.catchupDays()`). Ingest stores past programmes for catch-up channels only, within a budget the catch-up channels share (core `catchupBackLimits`: 30 h per channel of the source, so at most about 1.6× the programmes of a source without catch-up; with every channel on catch-up each keeps 36 h, and a focused Xtream row's older days come from `refineArchive`). The Guide also shows the archive glyph (`iconTexture('archive')`), the details line, Ok on an available past block opens VodPlay in catch-up mode, Menu offers From the start and Go to day. A focus resting 600 ms on a past catch-up row calls `api.refineArchive` (Xtream `get_simple_data_table`, once per channel per 30 min, through the short-EPG slot); `archiveRefined` makes the Guide refetch that page (`EpgCache.stalePage`).
- **Player:** `router.push('vodPlay', { catchup })`. VodPlay plays a stand-in title (`catchupVodPlayable`, id `vod:catchup:…`): programme timeline, position = `openedAtMs` + engine time, seek in place when the open stream covers the target else a re-open (`getCatchupPlayable(channel, start, offset)`, 2 s apart), live-edge marker for an on-air programme, end card (Next, Watch live, Back), Not available card (marks the programme for 30 min in memory, journal `catchupMissing`). Nothing is saved. The Xtream php form is the alternate (`vodAlternate`: tried once before a frame). xc URLs use the live format that plays on the source.
- **Entry points:** Guide, Player Options → From the start, Start's channel and event menus, the event picker's Menu.
- **Fake source:** `tools/fake-xtream` README, "Catch-up".
- A missing archive (404/410 on both URL forms) shows Not available in about 3 s on hls.js and mpegts.js (the engine's status, then the alternate), and on the native element through the status probe, which runs again on the alternate. With custom headers there is no probe: the VOD reopens (1, 2 and 4 s apart) run out on each URL form first.

## Subtitles (movies and series)

- **Preferred language:** Settings → Playback → Subtitle language (`AppSettings.subtitleLanguage`, ISO 639-1 or `off`; the list is core's `SUBTITLE_LANGUAGES`, mirrored in `vod/subtitleLogic.ts` with a parity test). When a title has no choice of its own, `pickSubtitle` turns on the stream's track in that language (by language tag, else by label; a full track wins over a forced one). A remembered choice always wins.
- **Load from a link or a file:** "Audio & subtitles" has "Load subtitles from a link…" (on-screen keyboard) and, on computers only (`!isTvPlatform`), "Load subtitles from a file…" (a hidden `<input type=file>` opened from the key press). The worker's `SubtitleService` (core) fetches the link with the app's fetch (dev proxy in `vite dev`), decodes it (BOM, UTF-8, else Windows-1252), parses SRT/WebVTT into plain-text cues, and keeps them per title in the `meta` store (`subtitles:<sourceId>:<itemId>`, the last 20 titles). Nothing goes through our servers.
- **Drawing:** a loaded file is chosen as `VodTracks.subtitle = 'ext'`; VodPlay turns the stream's tracks off, looks the cue up from the playhead every 250 ms (`cueAt`, binary search) and draws it in its own subtitle layer, like the engines' cues. An episode without a loaded file falls back to the preferred language.
- **Find subtitles online:** "Audio & subtitles" → "Find subtitles online…" opens "Subtitles online": one row per language (the Settings language first), and a click downloads that language's best file (trusted, then human-translated, then not hearing-impaired, then most downloaded) and turns it on like a loaded file. The worker's `OpenSubtitlesClient` (core) calls OpenSubtitles.com REST v1 straight from the device; `VodController.subtitleSearch` asks by the TMDB id that Xtream sends (`tmdb_id` / `tmdb`; episodes: the series id plus season and episode), else by the cleaned title (`searchTitle`). The picker shows "Subtitles provided by OpenSubtitles.com" (the free plan asks for it).
  - **Key:** the row shows only with `VITE_OPENSUBTITLES_API_KEY` in `apps/tv/.env.local` (git-ignored, `*.local`). `VITE_OPENSUBTITLES_URL` points at another server with the same API: the fake provider has one at `http://127.0.0.1:8899/opensubtitles/api/v1` (key `fake-key`; synthetic subtitles in five languages for every title; file id 999 answers like a spent quota).
  - The API calls skip the dev proxy (it forwards GET only; the API answers CORS itself); the file behind the download link goes through the app's fetch.
  - Without a user sign-in the free key allows 5 downloads per day per IP. A download happens only on a click, and the file is then kept for the title.
- **Keeping them in sync:**
  - **Subtitle delay:** a row in Audio & subtitles while a loaded file shows; Left/Right move the cues 0.1 s (pointer mode adds ±0.5 s rows). VodPlay looks the cue up at `playhead − delay`. It is kept with that title's file (`SubtitleService.setDelay`, ±60 s, saved 400 ms after the last press and on leaving); a newly loaded file starts at 0.
  - **Exact match:** Settings → Playback → Exact-match subtitles (off by default). When on, the worker reads the VOD file's OpenSubtitles hash (`fetchMovieHash`: two 64 KB range requests over the app's fetch, aborted at once if the server ignores ranges; nothing for playlists) and sends it with the search; files made for that exact release rank first and their language reads "· matches this file". It costs one short extra provider connection while the title plays, which one-connection accounts may refuse (the search then goes without it). Not verified against a real provider.
- **Staying in sync (frame rate, versions, speed):** a subtitle timed for 25 fps on a 23.976 fps video drifts about 4.3% of elapsed time, which no fixed delay fixes. So the file choice and a speed correction handle the frame rate.
  - **Ranking:** OpenSubtitles results carry `fps` and `release`. `rankSubtitles(list, videoFps)` orders by hash match first, then frame rate equal to the video's (when known), then trusted, human-translated, not hearing-impaired, and most downloaded. `findSubtitlesOnline` rows carry `release` and `fps` too.
  - **Versions per language:** `AppApi.subtitleVersions(itemId, language, seriesId, videoFps)` lists every version of one language, best first, with at most 2 searches (page 2 only when page 1 says there is more). The list is cached per item (a reopen asks nothing; a failed search is not kept), keyed with the stream URL and the exact-match setting when exact match is on, because a picked version under the same id is another file. It is cleared on a source switch. Only the version the user picks is downloaded.
  - **Hash with the stream's headers:** the movie hash is read with the stream's headers (source headers merged with the item's), cached per stream URL (least recently used out), and cleared on a source switch. A failed read is remembered for 10 minutes (`MOVIE_HASH_RETRY_MS`) so a refusing server is not asked at every search.
  - **Speed row** (Audio & subtitles, next to Delay, while a loaded file shows): Normal, 25 → 23.976, 23.976 → 25; Left/Right or Ok steps, wrapping. The cue is looked up at `(playhead − delay) × speed` (`subtitleTime`). The speed is saved with the loaded file (`setSubtitleSpeed`).
  - **Automatic speed:** `autoSpeed(subFps, videoFps)` picks a speed only for the 24/25 pairs (the video/subtitle rate ratio within 0.5% of 23.976/25 or 25/23.976); the same rate or any other pair stays Normal. It is applied once, when the file has no saved speed and both rates are known (VodPlay waits a few ticks for the engine's rate), with one combined toast. A saved speed is never overridden.
  - **The video's frame rate** (`StreamInfo.fps`): from hls.js and mpegts.js metadata; on the plain `<video>` element `Html5Player` measures it with `requestVideoFrameCallback` over about 1 s (the median step of single-frame callbacks, snapped to a common rate by `fpsFromSamples`), kept per opened URL. A window with fewer than 15 callbacks and no rate (callbacks stop while paused or hidden) is not remembered, so the next `streamInfo()` measures again. Tizen AVPlay reads it from the track's `extra_info` (keys `fps`, `frame_rate`, `FrameRate` and similar): unverified on a device.
  - **Version list:** "Try another <language> version…" opens a list; each row reads "release · fps · exact match" (parts left out when unknown) and the full release name is the row's help line. The list picker's footer shows the row help on line 1 and the hint or attribution on line 2.
- Not yet: OpenSubtitles user sign-in (20 downloads a day), automatic sync from the audio (PC app), Tizen USB files.

## Trending rows (Start)

- **What:** Start's "Trending movies" and "Trending series" rows show only titles the library has, in the order of a
  public feed (the Worker is `services/trending`).
- **Feed address:** `VITE_TRENDING_URL` (the base, e.g. `https://trending.example.com/trending`; files are
  `<base>/v1/{movie,series}.<lang>.json`). In `vite dev`, unset means the fake provider's synthetic feed
  `http://127.0.0.1:8899/__trending`; a production build without it has no trending rows and never asks
  (`src/net/trendingConfig.ts`, unit-tested).
- **Worker side:** `worker.ts` passes `trending: { baseUrl, fetch }` to `AppApi`, which builds app-api's
  `TrendingService`: a bare GET (`credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, no headers, no conditional
  request) straight from the device with a 15 s timeout, not through the dev proxy (the feed answers CORS). The last
  copy per kind and language is in meta (`trending:<kind>:<lang>`), refreshed at most every 6 h, failures back off
  (1 min … 6 h). Language: the device language's primary subtag (the UI has no language setting yet); a 404 falls back
  to `en` for 24 h (`trending:missing`).
- **Matching:** `VodController.snapStart` matches the resident catalogue with core's `matchTrending` (grouping keys:
  `t:<tmdb>`, `y:<base>|<year>` ±1, `n:<base>` for unambiguous names), one tile per title, so the rows follow the
  other VOD rows' caching: a kind that is not resident keeps its last snapshot, and the Start cache keeps the row.
  The index is built once per catalogue (about 50 ms at 60k titles); a match takes under 1 ms.
- **Rows:** after "Sports in your guide", before "Recently added movies"; at least 4 tiles, at most 20, no View all.
- **About:** Settings → About credits Wikimedia and Wikidata whenever trending is on, and TMDB ("This product uses the
  TMDB API but is not endorsed or certified by TMDB.") when the build sets `VITE_TMDB_ATTRIBUTION=1`
  (`apps/tv/.env.development` sets it for dev).
- **Try it:** `pnpm dev`, add the fake source, open Movies and Series once each (so each catalogue has been resident),
  then Start. The fake feed lists two titles that are not in the catalogue ("Synthetic Absent Film/Series"); they
  must never show.

## App shell (Task 5)

- `src/shell/router.ts` (pure, unit-tested) holds the screen stack (`push`, `replace`, `reset`, `back`, `current`, `below`: the screen a pop reveals; `below(2)` the one under that) and the overlay stack (`pushOverlay(id, onClose)` returns a remover that does not call `onClose`). `App.tsx` mirrors it into a signal and renders the current entry with `<Show when={current()} keyed>`, so each push/pop re-creates the screen.
- Layered Back: the shell root `View` has `onBack`, so any Back no focused node handled bubbles there and calls `router.back()`: top overlay first, then the screen, and on the root screen the "Exit the app?" `ConfirmDialog` (No focused by default). Screens and overlays should not swallow Back unless they mean to; to make something Back-closable, register it with `router.pushOverlay`. Toasts and the exit dialog do this. The debug HUD is deliberately not a Back layer.
- After a modal closes, the shell restores focus to the element that had it (`activeElement()` saved before opening), or to the screen host.
- `screenOverlayOpen()` in `src/shell/logic.ts` is the one test for "an overlay is open": every overlay but the toast (a Back layer with no focus, which would otherwise swallow Ok and the arrows for 4 s). Screens gate their keys and focus moves on it (`router.topOverlay() !== undefined` is only for `onBack` handlers that let the shell close the top layer first); the shell hides its chrome on it. `fullscreenVideoRoute()` keeps the clock and the offline badge off the Player and VodPlay.
- `src/state/appState.ts` owns `InitState`, the offline flag, the startup metric (`markStartup()`, called by Home once its cached list is on screen), the supervisor status (`setSupervisorStatus`, for the player screens) and `platformId`. It imports `@iptv/core` as types only, so core stays in the worker chunk.
- Source changes from the phone: `AppApi` emits `sourcesChanged { activeSourceId?, origin }` after every add, edit, delete and set-active (`origin: 'remote'` when `CompanionHost` made the call, like `applyLayoutOps`). `wireEvents` (given `api`, `router`, `playing`, `stopPlayback` by `App.tsx`) reacts only to `remote` ones through the pure `sourcesReaction` in `state/events.ts`: toast "Updated from your phone", re-run `api.init()` + apply, stop a stream whose source is gone or no longer active, reset to Add source when no source is left, leave the Player or an empty Add source root for Home. Home, the Guide and Settings > Sources re-read themselves on the same event. `local` events are ignored there: Settings and Add source already apply their own results.
- Screen timers use `src/shell/visibleInterval.ts` (`visibleInterval(fn, ms)`: a `setInterval` that skips ticks while `document.hidden` and runs once on return): Home's 30 s page tick, the Player's clock, info and pill ticks and the status spinner, the Guide's minute tick, Search's clock. The pointer's 250 ms tick (`input/pointer.ts`) runs only while pointer mode is on.
- `onUnmappedKey(fn)` in `src/input/keys.ts` observes keydowns that map to no logical key (used for F12 → debug HUD in the browser). It does not `preventDefault`.
- Dev-only console handle: `window.__iptv = { player, layer, playback, api, router, showToast }` (in `main.tsx`, `import.meta.env.DEV` only). For example `await __iptv.api.addSource({ kind: 'xtream', name: 'Test', server: 'http://127.0.0.1:8899', username: 'test', password: 'test' })`.

## Text entry (Task 6)

- `captureTextInput(fn)` in `src/input/keys.ts`: while a field is being edited, `fn` sees every raw keydown first. If it returns true the key was typed (prevented, not mapped, its keyup swallowed), so `m`, `i`, digits, Space and Backspace type instead of acting as Menu, Info, Digit, PlayPause or Back. Keys it declines (arrows, Enter, Escape, F1–F4) stay remote keys, so Escape still closes the keyboard. One capture at a time; `Keyboard.tsx` holds it while mounted.
- `src/components/keyboardLogic.ts` (unit-tested) holds the layout, cursor movement, editing and the physical-key classifier. `Keyboard.tsx`, `TextField.tsx` and `Button.tsx` only draw.
- The on-screen keyboard is a `router.pushOverlay('keyboard', …)` layer: Back closes it and keeps the text. Screens with their own `onBack` return `false` while `router.topOverlay()` is set, so the shell closes the layer first.
- Secrets: `TextField`/`Keyboard` render `maskSecret(value)` unless `revealed` (Yellow toggles it); the raw value is never given to a `Text` node otherwise.
- Dev proxy: when the upstream is unreachable it answers 502 with `x-dev-proxy-unreachable: 1`; the worker's dev fetch (`unwrapDevProxyResponse`) turns that back into a thrown `TypeError`, so core reports "Could not reach the provider." as on a TV.

## Home and playback (Task 7)

> Superseded in part by phase 2 (see "Live TV (revamp phase 2)"): `screens/Home.tsx`, its channel list, preview panel and inline search are gone. Playback, short-EPG and resume rules below still apply; "Home" now means the Live TV screen (route id `home`).

- `src/playback/playback.ts` is the only owner of the player: one `<video>` layer, one `Html5Player`, one `PlaybackSupervisor`, wrapped by the `playback` controller (`createPlaybackController`, unit-tested). Screens never call `player.open`/`supervisor.play` directly; they use `playback.playChannel`, `stop`, `setRect`, `status` and `current`. The Home preview and the fullscreen Player share it, so going fullscreen is a rect change and never reconnects.
- Stale answers: anything that awaits before playing (e.g. `api.getPlayable`) takes `const t = playback.begin()` first and plays only if `playback.isLatest(t)`. A later `begin()` or `playback.stop()` supersedes it. Home begins a request when it schedules a preview, when it starts one, on Ok (watch) and when it stops the preview (menu, group change, unmount).
- `parkLiveForScreen()` (`src/playback/parkLiveForScreen.ts`, pure part `parkLive.ts` unit-tested) is what a screen does with live playback on mount: `'stop'` for a full screen (Start, StartSports, Movies, Series: remembers a playing channel in `liveReturn`, then stops), `{ preview }` for Search (parks a fullscreen video in Home's preview window).
- Start re-reads its rows every 30 s and StartSports its clock every 60 s through `visibleInterval` (`src/shell/visibleInterval.ts`): the tick sleeps while the page is hidden and runs once when it becomes visible again.
- `previewHold.set()` (Player, after a sleep-timer stop) tells the next Home not to resume the last channel on mount (browsing never plays anyway; only Ok does). It is cleared only by Home's mount (`previewHold.take()`): if something other than Home is shown next, the hold stays set until Home mounts.
- Player modal isolation: while the "Still watching?" dialog or the options menu is open, the Player root ignores zap, digit, Red, Menu, LongOk and Info keys (`isModalOpen`); `OptionsMenu` also swallows digits. Every `jumpTo` and zap press bumps one token (`createJumpGuard`); a stale jump result is dropped. After a sleep stop the Player calls `router.back({ focusChannelId })` and Home consumes that one-shot param as a focus candidate (after the playing channel); `playerLeave()` passes it, and sets the hold, only when Home is the screen below (Start, Search or the Guide get neither). DEV only: `?sleepTest=1` scales sleep choices x0.05.
- The sleep timer is the app's (`sleepTimer` in `playback/playback.ts`, `createSharedSleepTimer` unit-tested): it survives Player remounts (Guide, Home and back). The Player `attach`es on mount, gets the current state at once (minutes, or the open question), and arms the Settings default only when nothing is running. An expiry with no Player attached stops playback.
- `src/copy.ts` holds UI strings several screens share (`FAV_COPY`, `favToggleLabel`, `favChangedToast`): one spelling of the favourites labels and toasts on Home, the Player, Start, the VOD screens and the poster menu.
- `nowNextLine()` / `nowLine()` / `nextLine()` in `screens/homeLogic.ts`: the Player's info banner and Start's hero describe a channel's now/next with the same copy (`NO_GUIDE_INFO` when nothing is on).
  - Now/next never waits on the network: the worker answers rows from stored programmes only and runs the Xtream short EPG in the background only for the focused or the playing channel when it has nothing stored (see the policy below). When answers arrive it emits `nowNextUpdated { channelIds }`; Home calls `invalidateRows(ids)` and reloads the visible window. The Guide ignores the event.
- Short-EPG policy (core `SourceService.shortEpgFor` + `AppApi.startShortEpg`, unit-tested):
  - `focusChannel` and `getPlayable` decide from memory first (`wantShortEpg`): a non-Xtream source, a channel in the guide coverage or a fresh now/next answer costs no storage read; only an uncovered Xtream channel without a fresh answer reads the stored guide once and then asks. `getEpgRows` rows are lite (no now/next: the Guide draws its own programmes).
  - Rows never ask for it: `getChannelSlice`, `search` and `getEpgRows` read stored programmes and cached answers only. Only two channels are looked up: the focused one (a browse focus resting `FOCUS_REST_MS` makes Home call `focusChannel`, which only asks for now/next and never plays) and the playing one (`getPlayable`, `neighbour`, `byNumber`). No lookup runs while a guide refresh of the source runs.
  - 1 request in flight across all sources, at least 2 s between two requests to the same source (`shortEpgGapMs`), at most 4 waiting; when the queue is full the oldest waiter is dropped (it resolves to nothing).
  - Right before each request (after it got a slot) a lookup is skipped as stale when the now/next generation changed (settings, refresh, source switch), the active source changed, the source was deleted, or the channel is neither the focused nor the playing one.
  - Answers are cached in memory per source and channel (`ShortEpgCache`): until the programme on now ends, else until the next one starts (at most 15 min); nothing found, or a failed request, is kept 15 min.
  - The Xtream client is built per request from the source config stored at that moment, so edited credentials are used. Its JSON bodies have the same 30 s idle timeout as playlist and guide bodies ("The provider stopped sending data."), so a stalled answer frees its slot (and, on add or refresh, the source lock).
  - Outside the list rows: on `nowNextUpdated` for the playing channel, Home re-reads the preview panel's info (unless that row is focused, which the slice cache refreshes), and the Player re-reads the banner's now/next while the banner is visible and shows the playing channel.
- Home focus restore order (single place, `openGroup` + `resolveFocus`): the playing channel if it is in the group (if it is not, Home opens "All" instead), then the remembered channel, then `lastChannelId` from init, then the remembered row, then the first row. Only the latest `openGroup` call writes the selection.
- Preview: browsing never connects. Moving the focus (D-pad, page keys, wheel) or hovering plays nothing; Ok on a channel that is not playing plays it in the small video (Home stays), and Ok again on the playing or loading channel goes fullscreen (`okAction`; clicks follow `rowPointerAction`). The preview panel shows the playing (or failed) channel's info; while a request is pending it shows that channel with a muted "Starting…".
- Dev resume gate (`src/playback/devResume.ts`, dev builds only): after a page load Home does not auto-resume the last channel from a remote source; the preview box says "Paused after reload: press OK to play". The local fake source (`127.0.0.1:8899`) still resumes, and production builds always resume. The hold ends when the user starts a channel anywhere (Home, Guide, Search, the Player's jumps).
- Stream format memo: on each first frame the TV reports which format played (`notePlayed`); the worker stores the format name only (no URL, no credentials) per source under `streamFormat:<sourceId>` and tries it first on the next `getPlayable`, unless the preferred-format setting changed since. Deleting the source deletes it.
- Supervisor format rule: one format per `play()`. It switches to the alternate only before the first frame (on UNSUPPORTED, or after two failures); every reconnect after a first frame keeps the format that played. Trade-off: if format A dies after playing, there is no switch to B within that play; the memo covers the next play.
- Decision (accepted for v1): the preview keeps playing behind non-player screens (Search, Guide, Settings) that Home pushes. Those screens are opaque, so it is not visible; it avoids a reconnect when the user comes back. Revisit if bandwidth matters.


## Guide (Task 9)

> Superseded by "Live TV (revamp phase 2)": the `guide` route and `screens/Guide.tsx` are removed. `guideLogic.ts`, `epgCache.ts` and `EpgGrid` remain, with the phase 2 geometry (682 px/h, 2 h view) described there.

- `src/screens/guideLogic.ts` (pure, unit-tested) holds the time math: 480 px/h, a 3 h view that opens at the half hour before now, a fixed window of now −6 h..+48 h (half-hour aligned), `buildBlocks` ("No information" fillers for gaps inside the loaded ranges only), and `stepLeft`/`stepRight`. Focus is a row plus an `anchor` time; the focused block is the one containing the anchor, so Up/Down keep the time position and late data never loses focus. A block running more than an hour past the view edge scrolls 1 h per press instead of jumping past it.
- `src/screens/epgCache.ts` (unit-tested): entries are 20 channels x one 3 h-aligned chunk, at most 24 in LRU order, one group at a time (switching or `invalidate()` drops everything and ignores answers in flight), refetched after 15 min. The Guide loads the visible 3 h first, then 3 h either side; it invalidates on `refreshed`.
- `EpgGrid` draws only visible rows ±2 and only the blocks overlapping the view; block objects are reused across rebuilds so their nodes survive page loads.
- The mini window is `playback.setRect` 480x270 at the top-left on mount; the Guide never starts playback except on Ok (on-air block, or the channel column), which goes fullscreen and pushes the Player like Home's watch, or, when the Player is the screen below (its `▦ Guide` button), goes back to it with the new channel id (`guidePlayAction`), so the stack never holds two Players. Home and the Player set their own rect on mount, so nothing is restored on cleanup.

## Live TV (revamp phase 2)

- One screen replaces Home and the Guide. Route id stays `home` (boot, Player return, live resume and the startup metric are unchanged); the `guide` route is removed. Hand-offs use `router.backTo('home', params)`: the Player's `▦ Guide` passes `focusChannelId`, Search's later rows pass `channelId` + `at`.
- Files in `src/screens/live/`: `LiveTv.tsx` (the screen), `LiveInfo.tsx` (info block), `LiveVideo.tsx` (the video hole), `livePreview.ts` (play, resume, fullscreen, retry), `liveMenu.tsx` (menu, list picker, rename keyboard, day choice), `liveCatchup.ts`, `livePointer.ts` (pointer mode and the typing hand-off) and `liveLogic.ts` (pure, unit-tested: layout constants, `liveKey`, `liveOkAction`, `timeLeftLabel`, `liveMenuItems`, `locateFocus`, `LIVE_POINTER_LABELS`, `liveTypedChar`, `liveEmptyText`).
- `LIVE_PREVIEW_RECT` is 416x234 at (160, 54): the playback layer's rect while Live TV is shown, and the area the screen leaves transparent. Search uses the same rect when it parks a fullscreen video. The info block starts at x 620, is 764 px wide and ends at x 1380, left of the offline badge; the phone badge sits at (1680, 54); the wordmark is off (`home` is in `NO_WORDMARK`). The description is 3 lines when expanded so it clears the ruler; an account-limit refusal uses a compact text that fits the 416x234 window (`MESSAGE_BOXES.live`).
- Guide geometry (`EpgGrid`, `guideLogic.ts`): the grid starts at y 312 with a 44 px ruler row (the group `DropdownHeader` "All channels" in the channel column, half-hour ticks); rows are 56 px + 4 gap (`EPG_ROW_H` 60), 11 visible (`EPG_VIEW_ROWS`), 10 in pointer mode (`EPG_POINTER_ROWS`) so the grid ends above the pointer bar. Channel column 300 px (number, 40 px logo, name), timeline 1364 px = 2 h at `PX_PER_HOUR` 682 (`VIEW_SPAN` 2 h). The now line is a 2 px `COLORS.accent` line. Cells: `surface`; airing now `surfaceRaised`; others `muted`; focused `focus` fill with `onFocus` text, no scale. Only visible rows plus 2 buffer rows are drawn.
- Focus model: one place at a time, `rail | groups | channels | grid`, plus a row and an anchor time in the grid (Up/Down keep the time position). `liveKey(place, key, ctx)` decides where a key leads: `move` (the place handles it), another place, or `exit` (Back on the rail bubbles to the shell's "Exit the app?"). Back from the grid or channel column goes to the rail; the group dropdown's Back goes to the grid. Left at the grid's time edge hands over to the channel column (`stepLeft`).
- OK (`liveOkAction`): an airing programme previews in the mini window; OK again on the playing or requested channel goes fullscreen (Home's rule). A past programme with catch-up opens catch-up; anything else toggles details. The channel cell previews or goes fullscreen by the same rule. In pointer mode a click on a cell focuses it and acts at once (`sameCell`).
- One menu (Menu key, long OK, right click), built by `liveMenuItems`: programme items first ("From the start" for an on-air programme with catch-up, "Go to day..."), then the channel items (Favourite, Add to list..., Remove from list, Hide or Show, Rename..., Cancel).
- Search hand-off: there is no inline search bar. Yellow, the rail's Search, or typing a letter or digit opens Search seeded with the key (`liveTypedChar`); `m` and `i` stay Menu and Info on desktop keyboards. Search takes a `query` seed. The hint line is removed; the pointer bar stays.
- Memory and startup: `EpgCache` is the only cache and gained `staleAll` / `stalePage` / `staleChannels` so a refresh, the 30 s tick and `nowNextUpdated` refresh only what rolled over. Every stale mark starts a new stale epoch: a request in flight from before it is not shared by the next `ensure`, and its answer is stored stale (fetched again), never over a newer one. A remote switch to another source calls `invalidate()`. Startup: `locateFocus` usually needs one `indexOf` (the focused channel in the group) before the first page loads; on the page's first mount `startResume` runs its own `indexOf` (init's last channel in All) in parallel, so a cold start costs up to two lookups at once. When the remembered channel left the remembered group, the remembered row (clamped to the group's count) is the fallback. The first visible 2 h are fetched before any prefetch. `markStartup()` fires on the first rendered channel row. Resume runs in parallel with the guide load, and nothing waits on the guide before the UI shows. A failed first read of the groups is not "no live channels": the info block says "Could not read the channels. Trying again…" and the read runs again (2 s doubling, at most a minute; `groupsRetryMs`) until it or a `refreshed` re-read succeeds.
- Short EPG on the guide: a focus resting `FOCUS_REST_MS` (700 ms) on a row calls `focusChannel` (no play). `getEpgRows` shows a channel's cached short-EPG answer (never a new request) when it has no stored programmes in the window, bounded to the window; `nowNextUpdated` marks the pages holding those channels stale and refetches them. The info block shows the day before the time range when a programme does not start today (`infoTimeLine`); on the channel cell it shows the row's programme on air now.
- Deferred: the Compact guide density (14 rows at 48 px).

## Search (Task 10)

- Current layout and focus: see "UI system (revamp phase 3)" below.
- `src/screens/searchLogic.ts` (pure, unit-tested): `createSearcher` debounces `api.search` by 150 ms and drops stale answers with a sequence counter; `resultsMessage` gives the idle and empty texts ("Nothing matches "xyz"", with a pending note when an index is still being prepared).
- The `Keyboard` is used inline (no overlay): Back is not captured, so it leaves the screen.
- The query and the focused cell are kept in module memory (`createSearchMemory`), so Back from the Player or a detail screen returns to the same results.

## Settings (Task 11)

- Current layout (rail, menu at x 160, 72/80 px rows, no hint bar): see "UI system (revamp phase 3)" below.
- `src/screens/Settings.tsx`: a left menu (one focusable node, Up/Down picks a page, Right/Ok enters it) and the page on the right. Back on a page returns to the menu; Back on the menu leaves; Left on the menu goes to the rail. The open page and whether it had focus are kept in module memory, so Edit/Add source return to the same place.
- Pages live in `src/screens/settings/*.tsx` and draw with `components/SettingsList.tsx` (one focusable node, virtual rows, Left/Right go to `onAdjust`; an unhandled Left returns to the menu; a focused adjustable row shows a `‹ value ›` stepper). Settings owns the shared modals and hands them to pages through `PageProps`: `confirm` (ConfirmDialog), `choose` (OptionsMenu) and `busy` (a key-swallowing panel, used while deleting/switching/clearing). Confirm and choose are `router.pushOverlay` layers.
- Pure logic in `src/screens/settingsLogic.ts` (unit-tested): `stepOffset` (0.5 h, ±12 h), `cycleOption`, labels, and `diagnosticsLines`, which reads only whitelisted fields (never ids, servers, URLs or logins) and runs free text through `stripUrls`.
- Settings are reactive through `appState.settings()`: `saveSetting` patches it optimistically, then with the worker's sanitised answer. Clock, Player (default sleep timer, clock) read it directly; Home and the Guide get the EPG offset and stream format through the worker on their next mount. Changing the format stops playback, so Home's resume plays with the new extension. `applyInitState` takes the `InitState` returned by set active / delete / clear cache.
- AddSource edit mode: `params.sourceId` prefills the form of the source's kind from `api.getSource` (no type step), saves with `api.updateSource`, and Back returns to Settings. A toast is a Back layer, so call `router.back()` before `showToast`, not after.
- `DebugOverlay` visibility is a module signal (`debugOverlayVisible` / `setDebugOverlayVisible`), toggled by Settings > Diagnostics as well as Info x3 / F12.
- Dev handle: `__iptv.renderer` is exposed too (walk `renderer.root` for `.text` to search rendered text).

## Tizen (Task 12)

Installed and profiled on one Samsung Tizen device (an Odyssey G9 monitor); other models are untested. Packaging: `pnpm build:tizen` (`tools/tizen/build-wgt.mjs`, see `tools/tizen/README.md`); user guide `docs/install-on-samsung.md`.

- **Minimum: Tizen 6.0 (2021 models, Chromium 76).** Tizen 5.0 (Chromium 63) lacks `import.meta`; 5.5 (Chromium 69) lacks `queueMicrotask`, `globalThis` and `Object.fromEntries`, which the app and libraries use. `config.xml` sets `required_version="6.0"`, so older TVs refuse to install it.
- Runtime APIs newer than Chromium 76 must be avoided or feature-detected: no `Object.hasOwn` (93), `String.prototype.replaceAll` (85), `structuredClone` (98, tests/MemoryStorage only), `TextDecoderStream` (core decodes with `TextDecoder`), module workers (80). `DecompressionStream` (80) is feature-detected: without it a gzip list fails with "This device cannot read compressed lists".
- **API-floor guard:** `packages/core/test/tvApiFloor.test.ts` scans every non-test `*.ts`/`*.tsx` under `packages/*/src`, `apps/tv/src` and `services/*/src` and fails (file and line) on `structuredClone(`, `Object.hasOwn(`, `.replaceAll(`, `.findLast(`/`.findLastIndex(`, `.at(`, `.toSorted(`/`.toReversed(`/`.toSpliced(`/`.with(`, `AbortSignal.any(`/`.timeout(`, `Promise.any(`, `WeakRef`, `Object.groupBy(`, `crypto.randomUUID(` (92) and `TextDecoderStream`. Comments (line and block, also across lines) are stripped before matching, so prose may name banned APIs; a guard test checks that stripping never swallows code. Allow a reviewed exception with a `// tv-floor-ok` comment on the line. Skipped: `packages/storage/src/memoryStorage.ts`, `apps/tv/src/dev/`, `apps/companion` and `services/relay` (they never run on a TV). Use `Object.prototype.hasOwnProperty.call` and plain copies instead.
- `tools/tizen/build-wgt.mjs` injects `<script src="$WEBAPIS/webapis/webapis.js"></script>` before the module script of `dist-tizen/index.html` (Tizen package only; `index.html` and `dist/` for the browser are unchanged) and fails if it is missing. Without it `webapis` does not exist on the TV and the app silently falls back to HTML5.
- `playback.playerKind()` ("AVPlay" | "HTML5") is shown in Settings > Diagnostics.
- `src/playback/playback.ts` picks `AvplayPlayer(webapis.avplay)` when `platformId === 'tizen'` and `webapis.avplay` exists, else `Html5Player`. On Tizen, `mountAvplayObject` puts one `<object type="application/avplayer">` in `#video-layer` and makes html, body and the layer transparent (AVPlay draws on a plane beneath the page).
- `src/video/AvplayPlayer.ts` has no DOM or global access (`AvplayLike` injected; unit-tested with a fake):
  - `open` = `stop()` old, `avplay.open`, `setListener`, display, `prepareAsync` → `play` → `playing`. `onbufferingstart` → `buffering`; `onbufferingcomplete` → `playing` (only once started); `onerror` → `error`; `onstreamcompleted` → `error` `NETWORK` (a live stream ended: reconnect). Session objects drop late events after `stop()`/`open()`; `attemptId` is echoed.
  - `stop()` = `avplay.stop()` then `avplay.close()`, each guarded. Every AVPlay call is in try/catch; a throw becomes `error`. Messages are always "Playback error" (no URLs).
  - Errors (`mapAvplayError`): `NOT_SUPPORTED*` / DRM → `UNSUPPORTED`; `INVALID_STATE`, `INVALID_OPERATION`, `INVALID_PARAMETER`, `SEEK_FAILED`, `GENEREIC` → `MEDIA`; everything else (connection, URI, timeouts, unknown) → `NETWORK`.
  - `position()` polls `getCurrentTime()` (`oncurrentplaytime` only updates the fallback value); audio tracks from `getTotalTrackInfo` (`setSelectTrack('AUDIO', index)`), active track and stream info from `getCurrentStreamInfo` (`extra_info` JSON).
  - Display (`avplayDisplay`): `auto` → `AUTO_ASPECT_RATIO`; `stretch` → `FULL_SCREEN`; `16:9`/`4:3` → `FULL_SCREEN` in a contained box of that ratio; `zoom` → in full screen, `LETTER_BOX` in a box of the source ratio covering the screen (overflow cropped by the screen edge); in a smaller rect (preview) it falls back to `auto`. Rects are converted from design space to `AVPLAY_DISPLAY_SPACE` (1920x1080, Samsung's fixed AVPlay coordinate space).
- `src/platform/tizen.ts`: `registerKeys()` (`registerKeyBatch(TIZEN_KEYS_TO_REGISTER)`, falling back to one `registerKey` per key) is called from `main.tsx` on Tizen; `exit()` is what `exitApp('tizen')` calls. Ambient `tizen` / `webapis` types: `src/types/tizen.d.ts` (read them via `globalThis`).

## Brand wordmark

- `src/shell/Wordmark.tsx`: "SAQQEZY" (900 weight, theme text colour) arched along the quadratic curve `M40,95 Q150,10 260,95` of a 300x130 design box, with "PLAYER" (13 px, spacing 12, muted) straight underneath. Lightning cannot set text on a path, so it is drawn once to an offscreen 2D canvas at 2x (transparent background) and shown as an image texture, like `QrCode.tsx`. Glyph positions and tangent angles come from the pure, unit-tested `shell/wordmarkLayout.ts`; letter spacing is applied per glyph because canvas `letterSpacing` is newer than Chromium 76. Only the inked band of the box is drawn: 300x92 at the top centre of the safe area (`WORDMARK_X`/`WORDMARK_Y`, bottom `WORDMARK_BOTTOM` = 146, right edge plus a gap `WORDMARK_RIGHT`). The shell renders it once, above the screen host and below badges, toasts, dialogs and the debug HUD. It hides in the Player, whenever the video is full screen, and while a screen overlay (keyboard, menu, picker, dialog) is on the router's overlay stack (`showWordmark`). The canvas is drawn only after Home marks the startup metric (or at most 2 s after the shell mounts; at once on screens that never mark it), on the next animation frame, and fades in (`deferWordmark`).
- Top-row placement rule (screens that still show the wordmark, such as Add source): content that crosses the centre starts at or below `WORDMARK_BOTTOM` (the Add-source keyboard) or sits right of `WORDMARK_RIGHT`. The redesigned screens (`NO_WORDMARK`: Live TV, Start, browse, grid, details, Search, Settings, Player) have no wordmark and no such rule. Badges stay outside `WORDMARK_ZONE_X`..`+WORDMARK_ZONE_W` (Home's phone badge sits left of it).
- Visibility is `showWordmark(route, playback.rectIsFullscreen())` in `shell/logic.ts` (unit-tested): hidden in the Player and whenever the video rect covers the screen. It fades over 200 ms.
- Search parks a fullscreen video (left by Back from the Player) at `LIVE_PREVIEW_RECT` on mount; Search has no wordmark (`NO_WORDMARK`).
- The `transition` prop does not work with renderer 3.7 (`@lightningtv/solid` calls `lng.animateProp`, which the renderer lacks): animate with `node.animate({...}, settings).start()` instead.
- Bold text: `fontStyle={'bold' as 'normal'}`. The canvas engine uses `${fontStyle} ${fontSize}px …` as the CSS font for measuring and drawing; `fontWeight` renames the family instead and `richText` is not forwarded by `@lightningtv/solid`.

## UI system (revamp phase 1)

- Tokens: `shell/theme.ts` (`COLORS`, `TYPE`, `SPACE`, `LAYOUT`, `FOCUS`, `MOTION`, `STRONG`). The legacy `FONT` is gone (phase 3).
  `shell/tokenLint.test.ts` fails when a file gains colour, fontSize or focus-scale literals; see "UI system (revamp phase 3)".
- Focus: cards use `FocusRing` + `FOCUS.scale`; rows, cells and buttons use a `COLORS.focus` fill with `COLORS.onFocus`.
  `COLORS.accent` is for progress and position marks only.
- Shared pieces: `shell/Rail.tsx` (+ `railLogic.ts`, `railNav.ts`), `components/InfoStrip.tsx` (feed it from
  `shell/dwell.ts` `dwellSignal`), `vod/Backdrop.tsx` (`strip` / `detail`), `components/DropdownHeader.tsx` with
  `ListPicker` for categories, sorts and seasons, `components/ScrollIndicator.tsx`.
- Back: from content to the rail on Start, Movies/Series browse and the library grid; on the rail, the screen's previous
  Back. Live TV keeps its old Back chain (rail, list, exit question) until phase 2.
- Back to Live TV (Back on the rail of Start/Movies/Series, or Live TV on their rail) passes `fromVod`: the channel that
  was stopped resumes and focus lands on it in the channel list (you return to what you were watching), not on the rail.
  Only a source without live channels lands on the rail.
- The library grid is pushed over browse or Start: its rail highlights that screen's tab, and a tab choice pops the grid
  first, then moves as that screen would (`railFromNested`, `goRailNested`).
- Clock and wordmark: the clock is drawn in the rail on rail screens (`railRoute` in `shell/logic.ts`) and by the shell
  clock elsewhere. The wordmark is hidden on the redesigned screens (`showWordmark`).
- Poster size: Settings → Display → Poster size (Standard 8 / Compact 10 per row), resolved by `gridLayout` in
  `vod/gridLogic.ts`.
- Play/Resume is the first item of the poster menu (`createPosterMenu`) on browse, grid and details.
- Memory: grids render visible rows + the peek row only. Posters still decode at natural size (no resize in renderer
  3.7), so Compact (up to 40 posters drawn) is the density ceiling until a decode-time resize lands.

## UI system (revamp phase 3)

- All screens are on tokens. Legacy `FONT` is removed: `FONT.heading` sites became `TYPE.title` (screen titles) or `TYPE.body` + `STRONG` (panel, dialog and overlay titles).
- Token lint is at zero: `tokenLint.baseline.json` is `{}` and a test asserts it, so any new colour, fontSize or focus-scale literal fails `pnpm test`. The regex counts every numeric literal inside `fontSize={...}`, and the object form too (`fontSize: 32`, `scale: 1.08`, e.g. `Config.fontSettings`). `QrCode` is in `SKIP`. Use a token or add one to `theme.ts`.
- New tokens: `COLORS.buffered`, `scrubAhead`, `scrubBack`, `subtitleOutline`, `imageTrack`, and `TITLE_CARD_COLOURS`.
- One focus style everywhere: fills, no borders. Pills go through `Button`. The `ManageOnPhone` rows look like `Button` but keep their single-node focus.
- Live banner (`components/InfoBanner.tsx`): `BANNER_H` 210, no panel; the `banner` fade in `vod/scrim.ts`. Logo 96 px with a monogram fallback. Line 1 is number + name + clock; the title is `TYPE.playerTitle`; the progress track is full width. `bannerNextLine` gives "Next · 21:00 Title"; the Next line sits in a keyed `Show` (it clipped when not keyed). `VolumeOsd` sits below `NumberEntry`.
- Search (`screens/Search.tsx`, `searchLogic.ts`): the rail is visible (`goRailFrom`); the keyboard starts at x 160. Two rows: "Movies & series" (`PosterRow`, 4 visible) and "Live & guide" (`WideRow`, 2 visible; programme cells with a progress bar; channel numbers are shown on Search only). `searchRows`, `moveSearch` and `settleFocus` decide focus. A "Searching…" note shows while a query is in flight. Rows are keyed by area strings so they keep their nodes while typing.
- Settings: the rail is visible (`goRailFrom`); the menu starts at x 160 with 72 px rows; list rows are 80 px (label y 10, help y 42); there is no hint bar. `shellBackX('settings')` is `contentX`.
- Rail: `active: RailId`, so Search and Settings can be the current item. `railFromNested` handles them: the rail's own id does nothing (`[]`), Search to Settings and back use `replaceScreen`, and a tab pops the screen and navigates from below. `railBelow(router.below(1), router.below(2))` says what is below: a tab's screen, or the library grid with the tab under it (`{ overGrid }`); over the grid a tab pops Search/Settings and the grid, then moves as the screen under the grid would.
- z-order: the rail is zIndex 50; `ConfirmDialog` and `ContextMenu` scrims are 60, so they cover it.
- Message boxes (`components/messageFit.ts`): every failure box draws body text (26) on 32 px lines; the Player's box and VodPlay's card fit about 0.55 em a character of their width (71 and 64 per line, 3 lines). The banner's progress fill is `COLORS.accent`.
