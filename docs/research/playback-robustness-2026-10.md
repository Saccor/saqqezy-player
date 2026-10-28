# Playback robustness: why the channel freezes, stops or "refreshes" (2026-10-14)

**Question (user).** How do we make the channel being watched as robust as possible: no freezes, stops or refreshes? Do we need more delay? Do we need another tech stack? Also: why does the site refresh, seemingly at certain times?

**Where it was seen.** Desktop browser, `pnpm dev` (Chrome, dev proxy, hls.js / mpegts.js).

**Builds on.** The live-latency reports in [live-latency-2026-10/](live-latency-2026-10/) (R1-R5) and an earlier source-friendliness report (B1-B3). Their P0 + P1 recovery work is already implemented (commits `0c540f7` … `5e876c5`: 250 ms stall ladder, immediate reconnect, rolling budget, Low / Balanced / Stable presets, AVPlay buffering, last-frame hold). This note covers what is still missing after that work and does not repeat those reports.

---

## 0. Short answers

1. **The "refresh" is Vite's dev reload, not the app.** Saving any core, app-api or worker file makes the dev server reload the whole page. Other Claude sessions are committing to this same checkout while the dev server runs, and you see a reload each time they save. Every reload also drops the stream and reopens it, which a source with a one-connection limit may refuse. **This cannot happen in a TV or production build** (no HMR there). Verified, §1.
2. **More delay helps only one kind of freeze.** A bigger buffer absorbs network jitter. It does nothing for server-side drops, connection limits, reloads or decoder errors. The **Stable** preset already gives 10 s (HLS) / 6 s (TS) and is a free experiment today. Raising the default without data would trade closeness to live for little gain (§3).
3. **On TVs the stack is right. On PC the browser is the weak link.** Samsung AVPlay, webOS native and Android Media3 are native pipelines with proper demuxers, and the browser build can never match them. For a robust PC player, the answer stays **Tauri + libmpv** (B3). The browser build stays a developer tool (§4).
4. **The real gap is evidence.** Diagnostics only shows counters (stalls, reconnects), which reset on every reload. Nobody can tell *why* a given freeze happened, so tuning thresholds now would be guessing (§2).

---

## 1. Finding A: the periodic "site refresh" (verified)

**Reproduction** (built-in browser on `localhost:5173`, own empty storage, so no source and no stream):

| Step | Result |
|---|---|
| Set `window.__marker`, then `touch packages/core/src/index.ts` (mtime only, no content change) | Marker gone; `performance.getEntriesByType('navigation')[0].type === 'reload'`. **Full page reload.** |
| Set marker again, then `touch apps/tv/src/screens/Guide.tsx` | Marker kept. Solid component hot-swapped, no reload. |

**Why.** Core, app-api and worker modules have no HMR boundary, so Vite falls back to a full reload. The worker file is rebuilt whenever anything it imports changes.

**Why it feels periodic.** Your `pnpm dev` (Vite + fake-xtream) has run since 21:19. Since then the search session has made 7 commits in this checkout (`6f0bece` 21:20 … `f9e5596` 22:09), with many more saves between them. Each save to `packages/core` or `packages/app-api` reloads your tab. Bursts of saves look like "refreshes at certain times".

**What one reload costs.**
- The player is destroyed mid-stream, and the media connection is closed.
- Auto-resume (`Home.tsx` `playById(resume)`) opens the channel again within about a second.
- On a source that counts connections, the old one may still be counted. The reopen can then be refused or kick the old one, and our refusal handling stops playback ("Your source refused this stream"). This is the "stop" after a "refresh". It is also one of the triggers in B1/B2 for the test account block.

**Not the cause** (checked):
- No app code calls `location.reload()`.
- The dev proxy streams without a total timeout (Node `fetch` body timeout is per chunk) and aborts upstream on close.
- Timers in `Home` / `Player` / `Guide` only re-read data.

**Fix options (dev only):**
1. **Stable dev mode:** `pnpm dev:stable` sets `server.hmr: false` (and no file watching), so nothing reloads while you watch. Code changes then need a manual F5. Recommended for watching sessions.
2. **Agent sessions in their own worktrees,** so their saves never touch the checkout your dev server serves. Recommended either way; this is a session-setup habit, not code.
3. B2 item 9 (already designed, not built): no auto-resume right after a reload, and a clean player and worker teardown on hot updates.

---

## 2. Finding B: no record of why playback froze

- `supervisor.liveInfo()` exposes `stalls`, `reconnects`, `targetS` and behind-live. There is no event list.
- The live-delay spec's "last 10 recovery events `{t, level, reason}`" is not in the code.
- All of it lives in memory, so the reload in §1 erases it.

So after a freeze we cannot answer:
- Was it a gap jump, an edge seek, no bytes, an empty buffer, frozen video, the 8 s backstop, EOS from the server, AUTH, or a drift reopen?
- Which engine was in use (native / hls.js / mpegts.js)?
- How much was buffered?
- Did it recover?

**Proposal: a playback journal.**
- A local ring buffer of about 200 events: open, playing, stall start/end, each ladder decision with reason, engine errors with code, reconnect, give-up, drift action, buffer-ahead at the time, and engine.
- No URLs, no credentials (rules 6-7).
- Kept in `sessionStorage` in dev and `localStorage` on TV, so it survives a reload.
- Shown in Diagnostics, with a "copy diagnostics" action as the only way out.
- It also delivers part of sub-project 3 (metrics) cheaply.

This is the prerequisite for every other robustness change. With a few sessions of journal data we can see which rung fires and tune that rung, instead of guessing.

---

## 3. Finding C: does more delay (buffer) help?

| Freeze cause | Bigger buffer helps? | What actually helps (status) |
|---|---|---|
| Wi-Fi / network jitter, slow segments | **Yes** | Stable preset (exists); adaptive raise after each stall (exists) |
| Server closes the connection on a timer | Partly (plays out the remaining buffer while reconnecting) | EOS → immediate reconnect (exists) |
| Half-open TCP (no bytes) | Partly | 2.5 s no-bytes reconnect (exists on mpegts.js / hls.js) |
| Connection limit / refusal on reopen | No | No reopen storms; reconnect gap and cooldown (partly exists, B2 guard not built) |
| Page reload in dev | No | §1 |
| Decoder or codec errors (HEVC, AC-3 in Chrome) | No | Native pipeline (§4) |
| Drift reopen when far behind live | No (it causes them) | Journal shows if this fires too often; then widen its threshold |

**Recommendation:** keep **Balanced** as the default. Try **Stable** on your setup now: if freezes drop clearly, that points to network jitter and the journal will confirm it. Do not change the defaults before the journal shows the cause.

---

## 4. Finding D: stack per platform

| Platform | Engine today | Verdict |
|---|---|---|
| Samsung Tizen | AVPlay (native) | Keep. Native demux and decode, hardware pipeline. Remaining work is the real-TV checks (live-latency §10) |
| LG webOS | native `<video>` (HLS), mpegts.js (TS) | Keep; mpegts.js is required for TS there |
| Android TV / Fire OS | Media3 (planned) | Keep plan |
| **PC (browser, dev)** | hls.js / mpegts.js over MSE, through the dev proxy | **Not a robust product path** (B3): JavaScript transmuxing on the UI thread, no AC-3 / E-AC-3, HEVC only with hardware support, a proxy hop for CORS, one shared tab with HMR |
| **PC (product)** | — | **Tauri + libmpv** (B3): FFmpeg demuxes any TS / HLS, all audio codecs, large demuxer cache, built-in reconnect options, no CORS or proxy, own User-Agent. About 2-3 weeks for a Windows MVP; needs an LGPL licence check |

So: **no stack change for the TV apps.** For PC, the browser build is the wrong place to judge robustness. Freezes seen there say little about the TV, and the TV-specific problems don't show up there.

---

## 5. Proposed next steps (in order)

1. **Stable dev mode** (`pnpm dev:stable`, HMR off) and agent sessions in separate worktrees. Small; it stops the refreshes today.
2. **Playback journal** (§2), shown in Diagnostics and surviving reloads. Small to medium; it gives us the facts.
3. **Watch with the journal** on desktop dev and on the Odyssey G9 (Tizen build). Try Stable vs Balanced.
4. **Tune the ladder from the data,** or fix the specific cause it shows (for example the B2 request guard if refusals show up).
5. **Desktop Tauri + libmpv** as its own sub-project when PC becomes a product target.
6. `tools/live-lab` (sub-project 3) for repeatable fault tests once the journal names the faults worth reproducing.
