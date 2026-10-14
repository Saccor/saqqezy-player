# IPTV Player

A fast, clean, neutral TV player for **your own** sources: M3U playlists, Xtream logins and XMLTV TV guides.
It ships with **no content**. v1 is a TV web app (Lightning 3 + SolidJS) that runs in a desktop browser for
development and packages for Samsung Tizen TVs.

v1 covers: a remote-first Channels screen with live preview, favourites, hidden channels and recently watched;
full-screen playback with zapping, number entry, previous channel, options and a sleep timer; a TV guide grid;
search; settings; and a cached start that reopens the last channel in under a second.

- **Try it:** [docs/try-v1.md](docs/try-v1.md) (install, start, keyboard map, test login)
- **Install on a Samsung TV:** [docs/install-on-samsung.md](docs/install-on-samsung.md). The Samsung build has
  not yet been verified on a real TV.
- **What comes later:** [docs/backlog.md](docs/backlog.md)

## Guardrails (summary)

The full rules are in [CLAUDE.md](CLAUDE.md). In short:

- **No bundled content:** no default, demo or sample playlists, portals or guide URLs. Test data is synthetic.
- **No provider links or piracy-flavoured wording** anywhere (app, docs, store), and no broadcaster or league
  logos except the user's own playlist/guide data.
- **No reseller features**, no Stalker portal / MAC emulation.
- **Client-only media:** our servers never proxy, relay, transcode or cache streams, playlists or guides. The
  dev proxy in `apps/tv/vite.proxy.ts` runs only inside `vite dev` on the developer's machine and is never
  shipped.
- **Credentials stay on the device**, never in logs, error text or diagnostics. Any future sync must be
  end-to-end encrypted.
- **Speed is the feature:** cached start under 1 s, key response under 100 ms, parsing off the UI thread,
  virtualised lists for 50k+ channels.

## Package map

| Path | Package | What it is |
|---|---|---|
| `packages/core` | `@iptv/core` | Pure logic: M3U parser, Xtream client, streaming XMLTV parser, channel index, settings, `SourceService` |
| `packages/storage` | `@iptv/storage` | Storage abstraction: `IdbStorage` (TVs and browsers), `MemoryStorage` (tests) |
| `packages/app-api` | `@iptv/app-api` | The app's API over the core, run in a Web Worker, plus the typed RPC between UI and worker |
| `packages/platform` | `@iptv/platform` | Platform detection and remote key mapping (browser, Tizen, webOS) |
| `packages/player` | `@iptv/player` | Player interface and playback supervisor (reconnect, stall watchdog, TS ↔ HLS fallback) |
| `apps/tv` | `@iptv/tv` | The TV app: Lightning 3 + SolidJS screens, HTML5 and AVPlay players, dev proxy. Stack notes: `apps/tv/STACK.md` |
| `tools/fake-xtream` | `@iptv/fake-xtream` | Local fake provider with synthetic channels and guide at `http://127.0.0.1:8899` (`test` / `test`) |
| `tools/tizen` | — | Samsung `.wgt` packaging (`build-wgt.mjs`, icon generator). See `tools/tizen/README.md` |

Developer notes for the core: [docs/dev/core.md](docs/dev/core.md).

## Scripts

Requires Node 22+ and pnpm 10 (`corepack enable`). Run `pnpm install` first.

| Command | What it does |
|---|---|
| `pnpm dev` | Starts the fake provider (port 8899) and the TV app dev server (http://localhost:5173) |
| `pnpm test` | Unit and integration tests (Vitest) |
| `pnpm test:watch` | Tests in watch mode |
| `pnpm test:perf` | Performance budgets (large M3U and XMLTV) |
| `pnpm typecheck` | Strict TypeScript over every package |
| `pnpm fake-xtream` | Only the fake provider |
| `pnpm build:tv` | Production build of the TV app into `apps/tv/dist` |
| `pnpm build:tizen` | Builds the app and prepares the Samsung package in `dist-tizen/` (signs it when the Tizen CLI is set up) |
