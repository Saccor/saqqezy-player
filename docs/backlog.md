# Backlog (after v1)

Items deliberately left out of v1. Evidence comes from the user-needs research,
[`research/user-needs-2026-10.md`](research/user-needs-2026-10.md) (section numbers below refer to it). Legal
guardrails in `CLAUDE.md` apply to every item: no bundled content, no provider links, client-only media,
credentials stay on the device.

## Features

| Item | Why | Evidence | Notes |
|---|---|---|---|
| **Parental PIN** (locked groups/channels) | Competitors ship it; a family-TV differentiator | Research §1 #18, §2; [Televizo changelog](https://apkmirror.com/apk/andrey-menscikov/televizo-iptv-player/televizo-iptv-player-1-9-2-3-release), [Airo IPTV PIN](https://github.com/zigorminsk-debug/IP-TV-player/pull/1) | PIN stored locally only |
| **User-Agent / Referer setting** applied to playlist, guide **and** stream requests | Header-gated lists load but fail in playback when only the list fetch sends them | Research §1 #8, §2, §5; [iptvnator #1221](https://github.com/4gray/iptvnator/issues/1221) | **Caveat:** limited on Tizen web apps (the web layer restricts headers; check AVPlay `setStreamingProperty` support first) |
| **Quality cap** (Auto / 720p / 1080p) | Weak TV chips overheat or stutter on high bitrates | Research §1 #23, §2; [StreamVault #263](https://github.com/Davidona/StreamVault-IPTV/issues/263) | |
| **Local XMLTV file** (and paste-a-URL, gz / double-gz tolerant) | Guide data is hosted in odd ways | Research §2; [iptvnator v0.24 notes](https://4gray.github.io/iptvnator/blog/v0-24-release-notes/) | Needs a file picker per platform |
| **Sort options** (provider order / A–Z / number) | Losing the provider's order is reported as a regression; v1 keeps provider order only | Research §1 #24, §2; [iptvnator v0.24 notes](https://4gray.github.io/iptvnator/blog/v0-24-release-notes/) | |
| **Catch-up / archive** | Strongest long-running demand | Research §1 #17, §3; [Kodi pvr.iptvsimple issues](https://github.com/kodi-pvr/pvr.iptvsimple/issues?q=is%3Aissue+sort%3Acomments-desc), [iptvnator #1562](https://github.com/4gray/iptvnator/issues/1562) | Start times must use the server's time zone |
| **Timeshift** (pause / restart live) | Frequently asked for | Research §1 #16, §3; [Kodi pvr.iptvsimple issues](https://github.com/kodi-pvr/pvr.iptvsimple/issues?q=is%3Aissue+sort%3Acomments-desc) | Tizen AVPlay cannot pause live ([note](https://github.com/muratcode/iptv-player-tizen)) |
| **Recording** | Asked for; competitors' versions are unreliable | Research §3 | Hard in TV web apps (storage, background) |
| **Multiview** | Premium feature in competitors | Research §3 (low confidence) | One-stream-at-a-time rule must be revisited |
| **VOD / series** | Dominant in competitor changelogs | Research §3 | Off-scope for v1 by design |
| **Phone QR setup** (type URLs and logins on the phone) | Typing long URLs with a remote is the stated pain | Research §1 #10, §3; [Tizen player notes](https://github.com/muratcode/iptv-player-tizen), [remote keyboard pain](https://github.com/Dead96/iptvplayer-tizen-tv) | Must not route credentials through our servers in readable form |
| **Sync** between devices | Same sources on every TV | Research §3 | End-to-end encrypted only (guardrail 7) |
| **Profiles** | Separate favourites / history per person | Research §3; [OTT Navigator changelog](https://www.apkmirror.com/?p=4127005) | |

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
