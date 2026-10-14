# tools/tizen

Samsung Tizen packaging for `apps/tv`. User-facing install steps: `docs/install-on-samsung.md`.
**Not yet verified on a real TV.**

| File | What it does |
|---|---|
| `build-wgt.mjs` | `pnpm build:tizen`. Runs `pnpm build:tv`, copies `apps/tv/dist` plus `apps/tv/tizen/config.xml` and `icon.png` into `dist-tizen/`, and strips `crossorigin` from `index.html`. If the Tizen CLI (`tizen`) is on PATH and `TIZEN_PROFILE` is set, it runs `tizen package -t wgt -s $TIZEN_PROFILE -- dist-tizen` and prints the install command. Otherwise it prints next steps and exits 0, leaving `dist-tizen/` unsigned. It refuses to sign while `config.xml` still has the `XXXXXXXXXX` placeholder package ID. |
| `make-icon.mjs` | `node tools/tizen/make-icon.mjs [out.png]` regenerates `apps/tv/tizen/icon.png` (512x512 PNG, plain Node + zlib, no assets). `build-wgt.mjs` uses it if the icon is missing. |

## Runtime pieces (in `apps/tv`)

- `tizen/config.xml`: privileges `internet`, `tv.inputdevice`, `avplay`; `access origin="*"`; landscape,
  `background-support="disable"`, `hwkey-event="enable"`.
- `src/platform/tizen.ts`: `registerKeys()` (registers `TIZEN_KEYS_TO_REGISTER`), `exit()`, `getAvplay()`,
  `mountAvplayObject()` and `AVPLAY_DISPLAY_SPACE`.
- `src/video/AvplayPlayer.ts`: the `Player` on `webapis.avplay` (no DOM or globals; unit-tested with a fake).
- `src/playback/playback.ts` picks `AvplayPlayer` when `detectPlatform` says `tizen` and `webapis.avplay`
  exists, else `Html5Player`.

## Compatibility (minimum Tizen 6.0 / 2021 models)

| Tizen | TV year | Chromium | Status |
|---|---|---|---|
| 5.0 | 2019 | 63 | Not supported: no `import.meta` (64) in module scripts. |
| 5.5 | 2020 | 69 | Not supported: no `queueMicrotask` / `globalThis` (71), `Object.fromEntries` (73). |
| 6.0 | 2021 | 76 | Minimum. Build target `chrome76`. |
| 6.5+ | 2022+ | 85+ | Supported. |

What the build does for Chromium 76:
- `build.target: 'chrome76'` lowers syntax (optional chaining, `??`, class fields).
- The core worker is a **classic** worker (`worker.format: 'iife'`, created via `import ... from './worker.ts?worker'`):
  module workers need Chromium 80.
- Gzip lists need `DecompressionStream` (Chromium 80, Tizen 6.5). On Tizen 6.0 a gzip list fails with a clear
  "cannot read compressed lists" error; plain lists work. Text is decoded with `TextDecoder` (no `TextDecoderStream`).
- `Object.hasOwn` and `String.prototype.replaceAll` were replaced in `@iptv/platform` / `@iptv/core`.

Known risks (unverified until tried on a TV):
- Module script and worker loaded from the widget's file URL. The worker URL in the build is relative
  (`new URL('worker-<hash>.js', import.meta.url)`), so it resolves inside the package. If an engine refuses
  a file-URL worker, the fallback would be a Blob worker or `worker.format: 'iife'` inlined (`?worker&inline`).
- `AVPLAY_DISPLAY_SPACE` is 1920x1080 (Samsung documents AVPlay display coordinates as fixed 1920x1080). If the
  picture is the wrong size on a UHD panel, change it there.
- Only remote keys in `TIZEN_KEYS_TO_REGISTER` are registered; Back (10009) and arrows/OK always arrive.
