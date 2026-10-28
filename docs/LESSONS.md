# Lessons

Real incidents from building this app, what caused them and what changed. Commit hashes point at the fix in this
repository. Device numbers come from one Samsung Tizen device (an Odyssey G9 monitor), the only TV hardware the app
has been installed and profiled on.

## 1. My development PC got banned by a source

- **What happened:** after a day of development against my own source, its server answered HTTP 403 to every
  request from my PC: account API, live TS and live HLS, from the app, curl and anything else. Another player on a
  phone kept working.
- **Why:** the likely trigger was a flood rule keyed on the IP address. In a refusing state, each page reload sent
  about 35-40 requests within 1-3 s: playlist calls, a restarted guide download, about 30 short-EPG lookups per page
  and an auto-resume of the last channel. The dev server reloaded the page on every saved file, hundreds of times
  that day.
- **Fix:** a minimum gap and backoff between stream attempts and no retry storms (`9b9e9f7`), stop at once on a
  refusal (`2595f55`), a refusal cooldown and an open-rate cap (`c313ce6`), then per-host refusals, `Retry-After`, an
  unreachable breaker and refresh backoff (`00a03ce`).
- **What I do differently now:** requests to a source pass a refusal guard in the core with a cooldown ladder
  (2, 10, then 30 minutes), and failed refreshes are recorded so a reload cannot restart them. The rule for any retry
  change is to prevent bans without blocking more than needed, checked in both directions. Day-to-day development
  uses the local fake provider.

## 2. The "random refresh" was the dev server

- **What happened:** while watching a stream in the dev build, the page reloaded every so often and the channel
  restarted. On a source that allows one connection, the reopen could be refused.
- **Why:** core, app-api and worker modules have no hot-update boundary, so saving any of them makes Vite reload the
  whole page. It could not happen in a TV or production build. Reproduced and written up in
  [playback-robustness-2026-10.md](research/playback-robustness-2026-10.md).
- **Fix:** `pnpm dev:stable` serves new code on F5 but never pushes a reload (`e3b47c6`). Code changes happen in a
  separate checkout from the one the watching server serves.
- **What I do differently now:** before tuning playback for a symptom, I check the navigation type and rule out the
  tooling. The playback journal logs page loads with their navigation type for that reason.

## 3. Movies played without sound, and showed no audio tracks, in desktop Chrome

- **What happened:** movies and series played a picture with no sound and no error. Later, the audio track list was
  empty for `.mkv` and `.mp4` titles.
- **Why:** desktop Chrome cannot decode AC-3 or E-AC-3 sound, which is common in films. Measured with synthetic files:
  AAC decodes, AC-3 and E-AC-3 decode 0 audio bytes. It also has no `video.audioTracks`, so natively played files list
  no tracks and only the default one plays.
- **Fix:** the player detects undecodable sound (mpegts.js refusing the audio codec, or 0 decoded audio bytes over
  3 s of picture on computers) and says so once (`95b65ca`, merged in `e1432d7`; live channels in `65deca0`). The
  audio page says when the browser is the reason there is no list (`6fc4f4a`). The fake provider can make an AC-3
  test movie.
- **What I do differently now:** for a media symptom I build the smallest synthetic file that reproduces it before
  touching player code. Where the platform cannot decode, the app explains; the real fix is a native pipeline (AVPlay
  on TVs, libmpv on desktop), not a JavaScript decoder.

## 4. Rows vanished from Start after scrolling down

- **What happened:** on Start and the Movies and Series screens, rows went blank once the list had scrolled far
  enough.
- **Why:** the sliding row column had no height of its own, so it took the clip's height (904 px). Once it slid up
  by more than that, the renderer marked it out of bounds and stopped updating its children. Rows mounted after that
  never laid out their text or tiles.
- **Fix:** the column gets its full height and each row its own height (`01c96c4`, merged in `0af43c3`).
- **What I do differently now:** any container that slides gets an explicit size that covers all of its children. In
  Lightning a missing width or height is inherited, not computed from the content.

## 5. A guide clean-up held the channel list hostage

- **What happened:** Live TV rows stayed on "Loading..." in every open tab of the app.
- **Why:** clearing an old guide generation of a big source deleted millions of programmes in one IndexedDB
  transaction, which locked the programmes store for minutes. Every channel row waited on that store for its
  now/next. Another tab doing the clear was enough to block this one.
- **Fix:** programmes are deleted in transactions of 2,000 rows so reads get in between, and rows wait at most
  400 ms for now/next, then go out without it and update when the answer arrives (`1b866e3`, merged in `342f75e`).
  Checked in the app with a forced 6 s lock: rows appeared in 401 ms.
- **What I do differently now:** long writes are sliced, and primary content never waits on secondary data. When
  rows look empty, I check for other tabs holding the database before blaming the data.

## 6. Storage filled up on the TV and Series was never saved

- **What happened:** on the Samsung device, Series downloaded from the source on every visit (20-30 s), and
  Diagnostics showed blank or vague storage errors. The playlist and guide had not been saved for days.
- **Why:** the app's storage quota there was 83.9 MB. Each catalogue was one uncompressed record: about 47 MB for
  the movie list and 16 MB for the channels. Replacing a record needs room for the old and the new value in the same
  transaction, so even a refresh that would have fit failed. Errors from IndexedDB also reached the log without
  their names.
- **Fix:** errors keep their names and only a real quota error is reported as storage full (`1b2cf6a`, `f85bf93`).
  Catalogues are now stored as packed gzip chunks with a plain fallback (`fa63592`), and the thumbnail cache is capped
  at 15 MB (`93d4594`). On the device, total use went from 79.7 to 50 MB with the full guide now saved; Series reads in
  0.61 s and Movies in 2.6 s, down from 5.0 s.
- **What I do differently now:** I size stored records against the smallest quota a target device gives, measure on
  the device with the real data volume, and treat a blank error message as a bug in itself.

## 7. Profiling on a PC predicted the wrong hot spots for the TV

- **What happened:** the app felt slow on the Samsung device. PC profiling with 6x CPU throttling looked fine, and my
  top suspect was a canvas buffer larger than 1080p, which I capped (`58306dc`). The first remote profile on the
  device then showed a 1920x1080 viewport at pixel ratio 1, so the cap changed nothing there.
- **Why:** the real costs did not exist on the PC. Encoding small poster copies and decoding images on the UI thread
  took about 1.1 s per 25 s of browsing, and each AVPlay `stop()` blocked the UI for 140-190 ms per channel switch.
  The cold first start was about 4.4 s to first paint.
- **Fix:** posters and logos decode in a thumbnail worker (`46ef738`) and AVPlay teardown runs after the key-press
  frame (merged in `fcd09ab`). Movies browsing went from 51 % to 28-33 % UI-thread busy (the 15 % target was missed;
  the rest is renderer and Solid work). Calling `close()` alone to save time was measured on the device, cost the
  same ~190 ms, and was reverted (`7fe688d`).
- **What I do differently now:** I profile on the device over remote DevTools before choosing fixes, and I write the
  measured result, including misses, into the plan. See [g9-performance-2026-10.md](research/g9-performance-2026-10.md)
  for the PC-side analysis that came first.
