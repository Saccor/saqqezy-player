// Builds a synthetic movie file whose sound is AC-3 (the Dolby codec many films carry) for the fake provider:
// a test pattern and a 440 Hz tone in Matroska. Desktop Chrome plays it as a silent picture, which is what the
// app's "No sound" message is for; TVs decode it. No real content. Needs ffmpeg on PATH.
// Output: tools/fake-xtream/media/ac3/film.mkv (git-ignored). Movie 2 plays it once it exists.
//   node tools/fake-xtream/scripts/make-ac3.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECONDS = 120;
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'media', 'ac3');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const r = spawnSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=25:duration=${SECONDS}`,
  '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${SECONDS}`,
  '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '400k', '-pix_fmt', 'yuv420p',
  '-c:a', 'ac3', '-ac', '2', '-b:a', '192k',
  'film.mkv',
], { cwd: out, encoding: 'utf8' });
if (r.status !== 0) {
  console.error(`ffmpeg failed (is it installed and on PATH?)\n${r.stderr}`);
  process.exit(1);
}
console.log(`AC-3 test movie written to ${join(out, 'film.mkv')}`);
