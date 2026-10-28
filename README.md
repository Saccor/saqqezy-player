# IPTV Player

A fast, clean, neutral TV player for **your own** sources: M3U playlists, Xtream logins and XMLTV TV guides.
It ships with **no content**. v1 is a TV web app (Lightning 3 + SolidJS) that runs in a desktop browser for
development and packages for Samsung Tizen TVs.

v1 covers: a remote-first Channels screen with live preview, favourites, hidden channels and recently watched;
full-screen playback with zapping, number entry, previous channel, options and a sleep timer; a TV guide grid;
search; settings; and a cached start designed to reopen the last channel in under a second.

v1.1 adds organisation and a companion: your own lists (with Favourites), group order and hiding, channel renames
and sorting, "hide channels without TV guide", and **Phone and computer**: scan a QR code (or type a code)
on the TV and manage sources, lists and groups from a web page. The TV and the page talk through an end-to-end
encrypted relay that only passes ciphertext along and stores nothing.

After v1.1 (October 2026): a **Start** tab (Continue watching, Live now, Sports in your guide with Teams I follow,
Recently added); **Movies and series** from Xtream sources with resume, duplicate versions folded into one title,
audio and subtitle tracks, subtitles from a file, a link or OpenSubtitles with sync and delay, and a volume control;
a **search bar** on the Channels screen; **mouse and pointer** support on computers; gentle source retry with
refusal cooldowns; live delay and recovery; and a dev proxy that logs with credentials masked.

- **Try it:** [docs/try-v1.md](docs/try-v1.md) (install, start, keyboard map, test login)
- **Manage from your phone, local test:** [docs/try-v1.md](docs/try-v1.md#6-manage-from-your-phone-local-test)
- **Deploy the relay and the companion web app (Cloudflare):** [docs/deploy-companion.md](docs/deploy-companion.md)
- **Deploy the trending feed (Start page rows, Cloudflare):** [docs/deploy-trending.md](docs/deploy-trending.md)
- **Install on a Samsung TV:** [docs/install-on-samsung.md](docs/install-on-samsung.md). Installed and profiled on one
  Samsung Tizen device (an Odyssey G9 monitor); other models are untested.
- **What comes later:** [docs/backlog.md](docs/backlog.md)

## Guardrails (summary)

The full rules are in [docs/GUARDRAILS.md](docs/GUARDRAILS.md). In short:

- **No bundled content:** no default, demo or sample playlists, portals or guide URLs. Test data is synthetic.
- **No provider links or piracy-flavoured wording** anywhere (app, docs, store), and no broadcaster or league
  logos except the user's own playlist/guide data.
- **No reseller features**, no Stalker portal / MAC emulation.
- **Client-only media:** our servers never proxy, relay, transcode or cache streams, playlists or guides. The
  dev proxy in `apps/tv/vite.proxy.ts` runs only inside `vite dev` on the developer's machine and is never
  shipped.
- **Credentials stay on the device**, never in logs, error text or diagnostics. The companion sends them to the TV
  end-to-end encrypted; the relay sees only ciphertext and stores nothing. Any future sync must be end-to-end
  encrypted too.
- **Speed is the feature:** targets of a cached start under 1 s and a key response under 100 ms, parsing off the UI
  thread, virtualised lists for 50k+ channels.

## Package map

| Path | Package | What it is |
|---|---|---|
| `packages/core` | `@iptv/core` | Pure logic: M3U parser, Xtream client, streaming XMLTV parser, channel index, settings, `SourceService` |
| `packages/storage` | `@iptv/storage` | Storage abstraction: `IdbStorage` (TVs and browsers), `MemoryStorage` (tests) |
| `packages/app-api` | `@iptv/app-api` | The app's API over the core, run in a Web Worker, plus the typed RPC between UI and worker |
| `packages/platform` | `@iptv/platform` | Platform detection and remote key mapping (browser, Tizen, webOS) |
| `packages/player` | `@iptv/player` | Player interface and playback supervisor (reconnect, stall watchdog, TS ↔ HLS fallback) |
| `packages/companion-protocol` | `@iptv/companion-protocol` | Companion pairing (QR secrets, PBKDF2 codes), AES-GCM frames, chunking, replay protection, typed messages, `SecureChannel` and the relay WebSocket transport |
| `apps/tv` | `@iptv/tv` | The TV app: Lightning 3 + SolidJS screens, HTML5 and AVPlay players, dev proxy. Stack notes: `apps/tv/STACK.md` |
| `apps/companion` | `@iptv/companion` | The companion web app (SolidJS, Cloudflare Pages): pairing, sources, lists, groups, display |
| `services/relay` | `@iptv/relay` | Cloudflare Worker + Durable Object that forwards opaque encrypted frames between one TV and one phone; stores nothing. See `services/relay/README.md` |
| `services/trending` | `@iptv/trending` | Cloudflare Worker (cron every 6 h) that publishes the public trending feed from Wikimedia pageviews and Wikidata (CC0), TMDB as a beta-only booster; sees no user data. See `services/trending/README.md` |
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
| `pnpm relay:dev` | The companion relay, fully local (`wrangler dev`) on `127.0.0.1:8787`; never-paired sessions expire after 60 s |
| `pnpm relay:test:int` | Relay integration checks against the running `pnpm relay:dev` (takes about a minute) |
| `pnpm relay:deploy` | Deploys the relay to Cloudflare with the production settings (see [docs/deploy-companion.md](docs/deploy-companion.md)) |
| `pnpm trending:dev` | The trending Worker locally (`wrangler dev`, local R2) on `127.0.0.1:8788`; its cron calls Wikimedia for real, so pass `--var CONTACT:<url>`. Not needed for the TV: `pnpm dev` serves a synthetic feed |
| `pnpm trending:deploy` | Deploys the trending Worker (`--var CONTACT:<url>` required; see [docs/deploy-trending.md](docs/deploy-trending.md)) |
| `pnpm companion:dev` | The companion web app dev server (http://localhost:5174) |
| `pnpm build:companion` | Production build of the companion into `apps/companion/dist` (set `VITE_RELAY_URL`) |
| `pnpm fake-phone '<QR URL or code>'` | Dev tool: a fake companion that pairs with the TV through the dev relay |

Build variables for production: `VITE_RELAY_URL` (TV and companion) and `VITE_COMPANION_ORIGIN` (TV). See
[docs/deploy-companion.md](docs/deploy-companion.md#build-variables).
