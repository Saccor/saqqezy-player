# Guardrails

Saqqezy Player is a fast, clean, neutral TV player for the user's **own** sources: M3U, Xtream, XMLTV EPG, and later Jellyfin, Plex and HDHomeRun. It ships with **no content**. The goal is a polished, remote-first player on every TV platform, with one license per account.

## Legal guardrails (hard rules; never break them, even if asked in passing)

These keep the product a neutral player under Swedish and EU law: the Copyright Act (*upphovsrättslagen*) 53 §, aiding and abetting (*medverkan*, brottsbalken 23:4), CJEU Filmspeler, GS Media and Ziggo, and the pending SOU 2025:100.

1. **No bundled content.** No default, demo, sample or "starter" playlists, portals or EPG URLs pointing at real channels. Test fixtures use synthetic data or clearly licensed or public-domain streams only.
2. **No links to providers or sellers** anywhere: app, website, docs, store listings, error messages, onboarding.
3. **No piracy-flavoured copy.** No "free channels", sports leagues, broadcaster names, or "cancel your subscription" wording, in UI text, marketing or ASO keywords.
4. **No broadcaster or league logos or trademarks** in screenshots, icons, mockups or store assets. Channel logos are shown only when they come from the user's own playlist or EPG data.
5. **No reseller features:** no white-label builds, bulk activation codes, reseller panels or provider partnerships.
6. **Client-only media.** Our servers never proxy, relay, transcode or cache streams, playlists or EPG.
7. **Credentials stay on the device.** Playlist URLs and Xtream username/password live in local storage only. Any sync must be end-to-end encrypted so our servers cannot read it. No MAC-address + web-portal playlist upload model.
8. **Stalker portal / MAC emulation is OFF the roadmap** until there is a written lawyer opinion. Do not implement it without explicit confirmation.
9. **Support and docs cover the app only.** Never write guidance for a specific provider.
10. Always surface **lawful use cases**: own media server, free-to-air, operator-provided M3U, HDHomeRun.

If a change conflicts with these rules, stop and flag it instead of implementing it.

## Product principles

- **Speed is the feature.** Targets:
  - Cold start to last channel playing: under 1 s, from cache.
  - Channel switch UI: under 100 ms. First frame depends on the stream; never block on our side.
  - Never block the UI on playlist or EPG loading (stale-while-revalidate).
- **Remote-first:** every screen fully usable with a D-pad plus OK and Back. Focus is always visible.
- **Clean and simple:** few screens, no settings sprawl, sensible defaults.
- **Scale:** must stay smooth with 50k+ channels and large XMLTV guides on low-end TVs. Use virtualised lists, streaming parsers, Web Workers and an LRU cache for logos.
  - **Tested** (`pnpm test:perf`, `packages/**/perf/*.perf.ts`): 50k-channel playlists (parse, index build, folding, search, zapping), a ~100 MB XMLTV guide streamed with bounded heap growth, and a 54k-channel guide import while the API stays responsive.
  - **Targets, not yet measured:** a 300 MB XMLTV guide on a TV with 1 GB of RAM, the 1 s cold start and the 100 ms channel switch above.

## Architecture

### Built

- **Shared core (TypeScript, `packages/*`):** M3U parser, Xtream client, XMLTV streaming parser, channel index, storage abstraction (`core`, `storage`), the app API that runs in a Web Worker (`app-api`), playback supervision (`player`), platform detection and keys (`platform`) and the companion protocol (`companion-protocol`). Pure logic with no UI, fully unit-tested.
- **TV web app (`apps/tv`):** Lightning 3 + SolidJS. Runs in a browser and as a Samsung Tizen `.wgt` package built by `tools/tizen`. Players: Tizen AVPlay and HTML5 `<video>`, with hls.js / mpegts.js as fallbacks.
- **Companion web app (`apps/companion`):** a phone page that pairs with the TV over an end-to-end encrypted channel to manage sources.
- **Cloudflare Workers:** `services/relay` forwards the companion's encrypted frames between TV and phone; `services/trending` builds a public trending feed from open data.

### Planned

- More TV web targets: LG webOS (`.ipk`), Hisense Vidaa, Titan OS (hosted).
- Desktop via Tauri + libmpv.
- Android TV / Fire OS: Kotlin + Media3.
- Apple: Swift.
- Roku is skipped.
- Players stay native-pipeline first on each platform (webOS `<video>`, Media3, libmpv), with hls.js / mpegts.js only as a fallback.
