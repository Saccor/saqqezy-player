// Builds a synthetic HLS title with two audio tracks and two subtitle tracks for the fake provider:
// a test pattern, a 440 Hz tone (English) and an 880 Hz tone (Swedish), and numbered WebVTT cues at an irregular,
// speech-like rhythm. Also `subs_eng_late.srt`: the English cues 3 s late, which the fake lists as the movie's own
// subtitle file (automatic sync should move it back).
// No real content. Needs ffmpeg and ffprobe on PATH. Output: tools/fake-xtream/media/multitrack/ (git-ignored).
//   node tools/fake-xtream/scripts/make-multitrack.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECONDS = 300;
const SEG_S = 4;
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'media', 'multitrack');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: out, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`${cmd} failed (is it installed and on PATH?)\n${r.stderr}`);
    process.exit(1);
  }
  return r.stdout;
}

/** One HLS media playlist from one lavfi source (same mux settings, so all renditions share their timestamps). */
function rendition(name, input, codec) {
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', input, ...codec,
    '-f', 'hls', '-hls_time', String(SEG_S), '-hls_playlist_type', 'vod',
    '-hls_segment_filename', `${name}_%03d.ts`, `${name}.m3u8`,
  ]);
}

rendition('video', `testsrc2=size=640x360:rate=25:duration=${SECONDS}`,
  ['-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '400k', '-g', String(25 * SEG_S)]);
rendition('audio_eng', `sine=frequency=440:duration=${SECONDS}`, ['-c:a', 'aac', '-b:a', '64k']);
rendition('audio_swe', `sine=frequency=880:duration=${SECONDS}`, ['-c:a', 'aac', '-b:a', '64k']);

// WebVTT cues are timed from the media's start: map LOCAL 0 to the first video PTS (90 kHz).
const startS = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'csv=p=0', 'video_000.ts']).trim());
const mpegts = Math.round(startS * 90_000);
const clock = (ms, sep = '.') => {
  const m = Math.floor(ms / 60_000);
  const s = Math.floor(ms / 1000) % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(ms % 1000).padStart(3, '0')}`;
};
// Lines of 1.5–3.9 s with gaps of 0.5–4.4 s (deterministic): an irregular rhythm, like dialogue.
const cues = [];
for (let i = 0, t = 1000; t < (SECONDS - 5) * 1000; i++) {
  const dur = 1500 + ((i * 37) % 25) * 100;
  cues.push([t, t + dur]);
  t += dur + 500 + ((i * 53) % 40) * 100;
}
const LATE_MS = 3000;
writeFileSync(join(out, 'subs_eng_late.srt'), cues.map(([a, b], i) =>
  `${i + 1}\n00:${clock(a + LATE_MS, ',')} --> 00:${clock(b + LATE_MS, ',')}\nEnglish subtitle ${i + 1}\n`).join('\n'));
for (const [lang, text] of [['eng', 'English subtitle'], ['swe', 'Svensk undertext']]) {
  let vtt = `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${mpegts},LOCAL:00:00:00.000\n\n`;
  cues.forEach(([a, b], i) => { vtt += `${clock(a)} --> ${clock(b)}\n${text} ${i + 1}\n\n`; });
  writeFileSync(join(out, `subs_${lang}.vtt`), vtt);
  writeFileSync(join(out, `subs_${lang}.m3u8`),
    `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${SECONDS}\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:${SECONDS}.0,\nsubs_${lang}.vtt\n#EXT-X-ENDLIST\n`);
}

writeFileSync(join(out, 'master.m3u8'), [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="eng",DEFAULT=YES,AUTOSELECT=YES,URI="audio_eng.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Svenska",LANGUAGE="swe",DEFAULT=NO,AUTOSELECT=YES,URI="audio_swe.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="eng",DEFAULT=NO,AUTOSELECT=YES,URI="subs_eng.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Svenska",LANGUAGE="swe",DEFAULT=NO,AUTOSELECT=YES,URI="subs_swe.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,AUDIO="aud",SUBTITLES="subs"',
  'video.m3u8',
  '',
].join('\n'));
console.log(`Multi-track test title written to ${out}`);
