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
- `worker.format: 'es'`.
- `tsconfig.json` uses `"jsx": "preserve", "jsxImportSource": "@lightningtv/solid"`.

## Renderer creation (`src/main.tsx`)

```ts
import { Config, createRenderer, registerDefaultShaders } from '@lightningtv/solid';
import { WebGlRenderer } from '@lightningjs/renderer/webgl';
import { CanvasTextRenderer } from '@lightningjs/renderer/canvas';

Config.fontSettings = { fontFamily: 'sans-serif', fontSize: 32, color: 0xe8eaf0ff };
const { render, renderer } = createRenderer({
  appWidth: 1920, appHeight: 1080,
  deviceLogicalPixelRatio: designScale(),   // min(innerWidth/1920, innerHeight/1080)
  clearColor: 0x00000000,                   // fully transparent: video shows through
  renderEngine: WebGlRenderer,
  fontEngines: [CanvasTextRenderer],
}, document.getElementById('app')!);
registerDefaultShaders((renderer as RendererMain).stage.shManager);   // needed for borderRadius / border / shadow
window.addEventListener('resize', () => (renderer as RendererMain).setOptions({ deviceLogicalPixelRatio: designScale() }));
render(() => <App />);
```

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

## Image loading

- Use `<View width={64} height={64} src={url} />`. The renderer fetches the image and decodes it with `createImageBitmap`.
- The spike uses a runtime-generated PNG `data:` URL. Remote images (channel logos) need CORS or the dev proxy on desktop. TVs fetch directly.
- The renderer retries failed textures according to `maxRetryCount`.

## Worker / RPC

- `src/api.ts` does `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`, then `export const { api, on: onEvent } = wrap<AppApi>(worker)`.
- `src/worker.ts` builds `IdbStorage` → `withTimeout(fetch via rawViaDevProxy)` → `SourceService` → `AppApi`, then calls `expose(api, self, APP_API_METHODS)`. `emit` forwards `AppEvent`s as `(e.type, e)`.
- In the production build, `@iptv/core` ends up only in the worker chunk.

## Dev proxy

- `vite.proxy.ts` is used by `vite dev` only (`apply: 'serve'`) and throws if `NODE_ENV=production`. The pure rewrite logic lives in `src/dev/rewriteHls.ts` (unit-tested).
- Two routes, `GET`/`HEAD` only:
  - `/__proxy/raw?u=<encoded url>` never rewrites anything. The worker uses it (`rawViaDevProxy`) for playlist, EPG and API fetches, so IPTV channel lists (M3U) come through byte for byte. `Range` is forwarded.
  - `/__proxy/hls/<file name>?u=<encoded url>` rewrites HLS playlists. `Html5Player` uses it (`hlsViaDevProxy`) for player URLs only. The file-name segment is cosmetic (only `u` is read) but native HLS in desktop Chrome sniffs the URL extension of playlists and segments. A body is rewritten only if the response is 2xx and contains `#EXT-X-`; only `http(s)` URIs are wrapped (`data:`, `skd:` stay), relative URIs are resolved against the final URL. Rewritten playlists are served as `application/vnd.apple.mpegurl`; `Range` is not forwarded for playlists.
- Security rules (the proxy is a local convenience, not a public relay):
  - No CORS headers at all (no `Access-Control-Allow-Origin`): it is same-origin only, so other sites cannot read through it.
  - 403 when `Sec-Fetch-Site` is present and is neither `same-origin` nor `none`, or when `Origin` is present and is not the dev server's own origin (host compared with the `Host` header). Same-origin page, worker and `<video>` requests pass.
  - `configureServer` throws if `server.host` is set to anything other than `localhost`, `127.0.0.1` or `::1` ("refuses to run when exposed to the LAN"). Do not use `--host`.
- Compressed upstream bodies: Node's fetch has already decoded them, so when upstream sends `content-encoding` the proxy forwards neither `content-encoding`, `content-length`, `content-range` nor `accept-ranges` (otherwise the browser truncates the body).
- `src/net/devProxy.ts`: `rawViaDevProxy(url)` and `hlsViaDevProxy(url)` are the identity in production (`import.meta.env.DEV`). In dev they also skip same-origin URLs and the fake provider at `127.0.0.1:8899`.

## Player

- `src/video/Html5Player.ts` implements `Player`:
  - `.m3u8` plays natively when `canPlayType('application/vnd.apple.mpegurl')`, otherwise through hls.js.
  - `.ts` plays through mpegts.js with `isLive: true`.
  - In dev, `?hlsjs` forces the hls.js path on browsers that have native HLS.
- Each `open()` creates a session. `stop()` kills it, removes its listeners, and destroys the hls.js or mpegts instance. It then calls `removeAttribute('src')` and `load()`. Events from a dead session are dropped, and `detail.attemptId` is echoed on every event.
- Error mapping: `<video>` MediaError 4 is `NETWORK` (retryable) while `readyState === 0` (HAVE_NOTHING: the load itself failed, e.g. 404, refused, dropped) and `UNSUPPORTED` only once metadata has loaded (`readyState >= 1`). MediaError 2 is `NETWORK`, 3 is `DECODE`, the rest `MEDIA`. hls.js errors are reported only when fatal, or for `MANIFEST_INCOMPATIBLE_CODECS_ERROR`; codec errors map to `UNSUPPORTED`, other network errors to `NETWORK`. mpegts codec/format errors map to `UNSUPPORTED`.
- mpegts teardown wraps each call (`pause`, `unload`, `detachMediaElement`, `destroy`) in its own try/catch so the element reset always runs.
- `installKeys` ignores key events whose target is an `<input>`, `<textarea>` or contenteditable element (no mapping, `preventDefault` or `stopImmediatePropagation`), so future DOM text entry works.
- Desktop autoplay policy: if `play()` is rejected with `NotAllowedError`, the player retries muted.

## App shell (Task 5)

- `src/shell/router.ts` (pure, unit-tested) holds the screen stack (`push`, `replace`, `reset`, `back`, `current`) and the overlay stack (`pushOverlay(id, onClose)` returns a remover that does not call `onClose`). `App.tsx` mirrors it into a signal and renders the current entry with `<Show when={current()} keyed>`, so each push/pop re-creates the screen.
- Layered Back: the shell root `View` has `onBack`, so any Back no focused node handled bubbles there and calls `router.back()`: top overlay first, then the screen, and on the root screen the "Exit the app?" `ConfirmDialog` (No focused by default). Screens and overlays should not swallow Back unless they mean to; to make something Back-closable, register it with `router.pushOverlay`. Toasts and the exit dialog do this. The debug HUD is deliberately not a Back layer.
- After a modal closes, the shell restores focus to the element that had it (`activeElement()` saved before opening), or to the screen host.
- `src/state/appState.ts` owns `InitState`, the offline flag, the startup metric (`markStartup()`, called by Home once its cached list is on screen), the supervisor status (`setSupervisorStatus`, for the player screens) and `platformId`. It imports `@iptv/core` as types only, so core stays in the worker chunk.
- `onUnmappedKey(fn)` in `src/input/keys.ts` observes keydowns that map to no logical key (used for F12 → debug HUD in the browser). It does not `preventDefault`.
- Dev-only console handle: `window.__iptv = { player, layer, playback, api, router, showToast }` (in `main.tsx`, `import.meta.env.DEV` only). For example `await __iptv.api.addSource({ kind: 'xtream', name: 'Test', server: 'http://127.0.0.1:8899', username: 'test', password: 'test' })`.

## Text entry (Task 6)

- `captureTextInput(fn)` in `src/input/keys.ts`: while a field is being edited, `fn` sees every raw keydown first. If it returns true the key was typed (prevented, not mapped, its keyup swallowed), so `m`, `i`, digits, Space and Backspace type instead of acting as Menu, Info, Digit, PlayPause or Back. Keys it declines (arrows, Enter, Escape, F1–F4) stay remote keys, so Escape still closes the keyboard. One capture at a time; `Keyboard.tsx` holds it while mounted.
- `src/components/keyboardLogic.ts` (unit-tested) holds the layout, cursor movement, editing and the physical-key classifier. `Keyboard.tsx`, `TextField.tsx` and `Button.tsx` only draw.
- The on-screen keyboard is a `router.pushOverlay('keyboard', …)` layer: Back closes it and keeps the text. Screens with their own `onBack` return `false` while `router.topOverlay()` is set, so the shell closes the layer first.
- Secrets: `TextField`/`Keyboard` render `maskSecret(value)` unless `revealed` (Yellow toggles it); the raw value is never given to a `Text` node otherwise.
- Dev proxy: when the upstream is unreachable it answers 502 with `x-dev-proxy-unreachable: 1`; the worker's dev fetch (`unwrapDevProxyResponse`) turns that back into a thrown `TypeError`, so core reports "Could not reach the provider." as on a TV.

## Home and playback (Task 7)

- `src/playback/playback.ts` is the only owner of the player: one `<video>` layer, one `Html5Player`, one `PlaybackSupervisor`, wrapped by the `playback` controller (`createPlaybackController`, unit-tested). Screens never call `player.open`/`supervisor.play` directly; they use `playback.playChannel`, `stop`, `setRect`, `status` and `current`. The Home preview and the fullscreen Player share it, so going fullscreen is a rect change and never reconnects.
- Stale answers: anything that awaits before playing (e.g. `api.getPlayable`) takes `const t = playback.begin()` first and plays only if `playback.isLatest(t)`. A later `begin()` or `playback.stop()` supersedes it. Home begins a request when it schedules a preview, when it starts one, on Ok (watch) and when it stops the preview (menu, group change, unmount).
- `previewHold.set()` (Player, after a sleep-timer stop) tells the next Home not to resume or auto-preview until the user moves. It is cleared only by Home's mount (`previewHold.take()`): if something other than Home is shown next, the hold stays set until Home mounts.
- Player modal isolation: while the "Still watching?" dialog or the options menu is open, the Player root ignores zap, digit, Red, Menu, LongOk and Info keys (`isModalOpen`); `OptionsMenu` also swallows digits. Every `jumpTo` and zap press bumps one token (`createJumpGuard`); a stale jump result is dropped. After a sleep stop the Player calls `router.back({ focusChannelId })` and Home consumes that one-shot param as a focus candidate (after the playing channel). DEV only: `?sleepTest=1` scales sleep choices x0.05.
- Slice cache (`src/screens/sliceCache.ts`, unit-tested): pages of 40 rows from `getChannelSlice`.
  - Per group, at most 6 pages in LRU order; each `ensure` marks its window's pages as most recent.
  - Only the current group and the previous one are kept; older groups are dropped on group change, and answers for a dropped group are ignored.
  - A page expires once a row's `now` programme that was still running when the page was fetched has ended (injected clock). On Home's 30 s tick, `invalidateStale` marks the visible pages that rolled over and `ensure` refetches them; the old rows stay on screen until the fresh page arrives. A provider that still answers with an ended programme is not refetched in a loop.
  - `invalidate()` drops everything (refresh, favourite/hide changes).
- Home focus restore order (single place, `openGroup` + `resolveFocus`): the playing channel if it is in the group (if it is not, Home opens "All" instead), then the remembered channel, then `lastChannelId` from init, then the remembered row, then the first row. Only the latest `openGroup` call writes the selection.
- Preview: a 700 ms debounce keyed on the focused channel id (page loads do not restart it). The preview panel shows the playing (or failed) channel's info; while a preview is pending it shows the focused channel with a muted "Starting…".
- Decision (accepted for v1): the preview keeps playing behind non-player screens (Search, Guide, Settings) that Home pushes. Those screens are opaque, so it is not visible; it avoids a reconnect when the user comes back. Revisit if bandwidth matters.


## Guide (Task 9)

- `src/screens/guideLogic.ts` (pure, unit-tested) holds the time math: 480 px/h, a 3 h view that opens at the half hour before now, a fixed window of now −6 h..+48 h (half-hour aligned), `buildBlocks` ("No information" fillers for gaps inside the loaded ranges only), and `stepLeft`/`stepRight`. Focus is a row plus an `anchor` time; the focused block is the one containing the anchor, so Up/Down keep the time position and late data never loses focus. A block running more than an hour past the view edge scrolls 1 h per press instead of jumping past it.
- `src/screens/epgCache.ts` (unit-tested) mirrors `SliceCache`: entries are 20 channels x one 3 h-aligned chunk, at most 24 in LRU order, one group at a time (switching or `invalidate()` drops everything and ignores answers in flight), refetched after 15 min. The Guide loads the visible 3 h first, then 3 h either side; it invalidates on `refreshed`.
- `EpgGrid` draws only visible rows ±2 and only the blocks overlapping the view; block objects are reused across rebuilds so their nodes survive page loads.
- The mini window is `playback.setRect` 480x270 at the top-left on mount; the Guide never starts playback except on Ok (on-air block, or the channel column), which goes fullscreen and pushes the Player like Home's watch. Home and the Player set their own rect on mount, so nothing is restored on cleanup.

## Search (Task 10)

- `src/screens/searchLogic.ts` (pure, unit-tested): `createSearcher` debounces `api.search` by 150 ms, drops stale answers with a sequence counter, and `resultsMessage` gives the empty/idle texts ("No channels match "xyz"").
- The `Keyboard` is used inline (no overlay): Back is not captured, so it leaves the screen. `onEdgeRight` moves focus to the results when Right is pressed on the rightmost key; `hint` overrides the footer text. `ChannelList` takes `showNext` to append the next programme.
- Query and focused row are kept in module memory so Back from the Player returns to the same results (list focused); Ok plays with `groupId: 'all'`.
