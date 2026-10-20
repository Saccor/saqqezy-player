// Builds a synthetic movie with two audio tracks for the fake provider: a test pattern with a 440 Hz tone
// ("English", the default track) and an 880 Hz tone ("Svenska"), both AAC, written three ways: Matroska (film.mkv),
// MP4 (film.mp4) and MPEG-TS with two audio PIDs (film.ts). No real content. Needs ffmpeg on PATH.
// Output: tools/fake-xtream/media/multiaudio/ (git-ignored). Movie 3 plays it once it exists, as the container the
// stream URL asks for (.mkv, .mp4 or .ts; the listing says mkv).
//   node tools/fake-xtream/scripts/make-multiaudio.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECONDS = 120;
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'media', 'multiaudio');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/** The shared inputs and encoders: picture, then the two tones mapped as audio streams 0 and 1 with language tags. */
const common = [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=25:duration=${SECONDS}`,
  '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${SECONDS}`,
  '-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${SECONDS}`,
  '-map', '0:v', '-map', '1:a', '-map', '2:a',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '400k', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-ac', '2', '-b:a', '96k',
  '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English',
  '-metadata:s:a:1', 'language=swe', '-metadata:s:a:1', 'title=Svenska',
  '-disposition:a:0', 'default', '-disposition:a:1', '0',
];

function make(file, extra = []) {
  const r = spawnSync('ffmpeg', [...common, ...extra, file], { cwd: out, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`ffmpeg failed for ${file} (is it installed and on PATH?)\n${r.stderr}`);
    process.exit(1);
  }
}

make('film.mkv');
make('film.mp4', ['-movflags', '+faststart']);
// MPEG-TS: each audio stream gets its own PID; the language tags land in the PMT's ISO 639 descriptors.
make('film.ts', ['-f', 'mpegts', '-mpegts_flags', '+initial_discontinuity']);
console.log(`Two-audio test movie written to ${out} (film.mkv, film.mp4, film.ts)`);
