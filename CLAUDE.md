# IPTV App: project rules

A fast, clean, neutral TV player for the user's **own** sources: M3U, Xtream, XMLTV EPG, and later Jellyfin, Plex and HDHomeRun. It ships with **no content**. The goal is TiviMate-level quality on every TV platform, with one license per account.

Background: `docs/market-research-2026-10.md`. Read it before making product, legal or architecture decisions.

## Legal guardrails (hard rules; never break them, even if asked in passing)

These keep the product a neutral player under Swedish and EU law: the Copyright Act (*upphovsrättslagen*) 53 §, aiding and abetting (*medverkan*, brottsbalken 23:4), CJEU Filmspeler, GS Media and Ziggo, and the pending SOU 2025:100.

1. **No bundled content.** No default, demo, sample or "starter" playlists, portals or EPG URLs pointing at real channels. Test fixtures use synthetic data or clearly licensed or public-domain streams only.
2. **No links to providers or sellers** anywhere: app, website, docs, store listings, error messages, onboarding.
3. **No piracy-flavoured copy.** No "free channels", sports leagues, broadcaster names, or "cancel your subscription" wording, in UI text, marketing or ASO keywords.
4. **No broadcaster or league logos or trademarks** in screenshots, icons, mockups or store assets. Channel logos are shown only when they come from the user's own playlist or EPG data.
5. **No reseller features:** no white-label builds, bulk activation codes, reseller panels or provider partnerships.
6. **Client-only media.** Our servers never proxy, relay, transcode or cache streams, playlists or EPG.
7. **Credentials stay on the device.** Playlist URLs and Xtream username/password live in local storage only. Any sync must be end-to-end encrypted so our servers cannot read it. No MAC-address + web-portal playlist upload model.
8. **Stalker portal / MAC emulation is OFF the roadmap** until the user has a written lawyer opinion. Do not implement it without explicit confirmation.
9. **Support and docs cover the app only.** Never write guidance for a specific provider.
10. Always surface **lawful use cases**: own media server, free-to-air, operator-provided M3U, HDHomeRun.

If a request conflicts with these rules, stop and flag it to the user instead of implementing it.

## Product principles

- **Speed is the feature.**
  - Cold start to last channel playing: under 1 s, from cache.
  - Channel switch UI: under 100 ms. First frame depends on the stream; never block on our side.
  - Never block the UI on playlist or EPG loading (stale-while-revalidate).
- **Remote-first:** every screen fully usable with a D-pad plus OK and Back. Focus is always visible.
- **Clean and simple:** few screens, no settings sprawl, sensible defaults.
- **Scale:** must stay smooth with 50k+ channels and 300 MB XMLTV on low-end TVs (1 GB RAM). Use virtualised lists, streaming parsers, Web Workers and an LRU cache for logos.

## Architecture (decided in research; refine in specs)

- **Shared core (TypeScript):** M3U parser, Xtream client, XMLTV streaming parser, channel index, storage abstraction. Pure logic with no UI, fully unit-tested.
- **TV web app:** Lightning 3 + SolidJS. Targets Samsung Tizen (.wgt), LG webOS (.ipk), Hisense Vidaa, Titan OS (hosted), and desktop via Tauri + libmpv.
- **Android TV / Fire OS:** Kotlin + Media3.
- **Apple later:** Swift.
- **Skip Roku.**
- **Players:** native pipeline first (Tizen AVPlay, webOS `<video>`, Media3, libmpv). hls.js / mpegts.js only as a fallback.

## Workflow

- Superpowers flow: brainstorm → spec (`docs/superpowers/specs/`) → plan (`docs/superpowers/plans/`) → TDD implementation → review.
- Write the core test-first. Parsers get fixture-based tests with synthetic playlists and EPG data.
- The user communicates in English and sometimes Swedish. Write code and docs in English.
