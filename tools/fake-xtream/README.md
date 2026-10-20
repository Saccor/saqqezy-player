# Fake Xtream provider

A local Xtream-style server with synthetic channels, guide, movies and series for developing and testing the app.
Nothing in it is real content: channel and title names are made up, and every video request redirects to a licensed
public test stream or to a file generated on your machine from test patterns and sine tones.

- Start: `pnpm fake-xtream` (port 8899) or `pnpm dev` (with the TV app). Login `test` / `test`.
- Options through the environment: `PORT`, `CHANNELS` (default 200), `FAKE_VOD_VERSIONS=1` (each title listed as three
  language and quality variants), `SPORTS=0`.
- Special usernames: `expired`, `slow`, `error500`, and the refusal set `refuse403`, `limit429`, `gone404`, `down500`.
  `GET /__control/refuse?on=1` makes every answer a 403 until `on=0`.
- The source works as Xtream (server `http://127.0.0.1:8899`) or as an M3U link (`/get.php?...&type=m3u_plus` with
  `/xmltv.php?...` as the guide).

## Generated test media

The scripts in `scripts/` need `ffmpeg` (and `ffprobe` for the HLS one) on PATH. They write to `media/`, which is
git-ignored, and the server picks the files up on the next request: no restart.

| Script | Makes | Served as |
|---|---|---|
| `node tools/fake-xtream/scripts/make-multitrack.mjs` | An HLS title with two audio renditions (440 Hz "English", 880 Hz "Svenska") and two WebVTT subtitle tracks | Movie 1 (`.m3u8`) |
| `node tools/fake-xtream/scripts/make-ac3.mjs` | A Matroska file whose sound is AC-3 | Movie 2 (listed as `.mkv`) |
| `node tools/fake-xtream/scripts/make-multiaudio.mjs` | A title with two AAC tracks ("English", the default, and "Svenska") as `film.mkv`, `film.mp4` and `film.ts` (two audio PIDs) | Movie 3 (listed as `.mkv`; the stream URL's extension picks the container, so `/movie/test/test/3.mp4` and `3.ts` serve the others) |

### What the two-audio title shows

Open Movies → movie 3 and press OK on the player's "Audio & subtitles" (Live TV: Options → Audio track for a channel):

- **Desktop Chrome or Edge** (the dev server): the `.mkv` and `.mp4` play through the `<video>` element, which has no
  `audioTracks` API without a browser flag, and the `.ts` through mpegts.js, which keeps the first audio PID. The
  picker lists no audio rows ("No audio track list for this stream" in Live TV): this is the gap the PC app with
  libmpv closes. Movie 1 (HLS) is the comparison: hls.js lists both renditions, with "(AAC)" after the names, and
  Settings → Playback → Audio language picks one of them when a title has no remembered choice.
- **A TV** (Samsung AVPlay, LG `<video>`): the engine lists both tracks by language ("English", "Swedish", with the codec
  family where the firmware reports it), the picker switches between the 440 Hz and 880 Hz tones, the choice is
  remembered per title (per channel for Live TV), and the Audio language setting picks "Svenska" on first play when
  set to Swedish.

Delete `media/` to go back to the shared test stream for every title.
