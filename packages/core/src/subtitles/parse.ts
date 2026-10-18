/** One subtitle cue: plain text (tags stripped), lines separated by '\n'. */
export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

/** Larger files are refused: a subtitle is 30–200 KB, so this is a wrong file (a video, a page). */
export const SUBTITLE_MAX_BYTES = 5 * 1024 * 1024;

// [hh:]mm:ss[,.]fff (WebVTT drops the hours; some SRT writers use '.' or fewer digits).
const TIME = String.raw`(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?`;
const TIMING = new RegExp(String.raw`^\s*${TIME}\s*-->\s*${TIME}`);

function ms(h: string | undefined, m: string, s: string, f: string | undefined): number {
  const frac = f ? Number(f.padEnd(3, '0')) : 0;
  return ((Number(h ?? 0) * 60 + Number(m)) * 60 + Number(s)) * 1000 + frac;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };

/** Markup out: HTML-like tags (<i>, <font>, <v Name>), SSA overrides ({\an8}), entities decoded. */
function plain(line: string): string {
  return line
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&(#\d+|[a-z]+);/gi, (all, name: string) => {
      if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
      return ENTITIES[name.toLowerCase()] ?? all;
    })
    .trim();
}

/**
 * SRT and WebVTT into cues sorted by start. Any block with a `-->` timing line is a cue; everything else (the
 * WEBVTT header, NOTE, STYLE, REGION, numbers, junk) is skipped. Cues with no text or that end before they start
 * are dropped.
 */
export function parseSubtitles(text: string): SubtitleCue[] {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const cues: SubtitleCue[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = TIMING.exec(lines[i] ?? '');
    i++;
    if (!m) continue;
    const startMs = ms(m[1], m[2] ?? '0', m[3] ?? '0', m[4]);
    const endMs = ms(m[5], m[6] ?? '0', m[7] ?? '0', m[8]);
    const body: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '') {
      // A missing blank line before the next cue: stop at its timing line.
      if (TIMING.test(lines[i] ?? '')) break;
      const p = plain(lines[i] ?? '');
      if (p) body.push(p);
      i++;
    }
    if (body.length > 0 && endMs > startMs) cues.push({ startMs, endMs, text: body.join('\n') });
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

/** How far back from the last started cue to look for long cues that still show (overlaps are rare and short). */
const OVERLAP_SCAN = 8;

/** The text on screen at `atMs` ('' for none): every cue showing then, in start order. `cues` sorted by start. */
export function cueAt(cues: readonly SubtitleCue[], atMs: number): string {
  // The last cue that has started.
  let lo = 0;
  let hi = cues.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((cues[mid]?.startMs ?? 0) <= atMs) {
      last = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const out: string[] = [];
  for (let k = last; k >= 0 && k > last - OVERLAP_SCAN; k--) {
    const c = cues[k];
    if (c && c.endMs > atMs) out.push(c.text);
  }
  return out.reverse().join('\n');
}

/**
 * Subtitle bytes to text: a BOM (UTF-8, UTF-16) wins; otherwise UTF-8 when the bytes are valid UTF-8, else
 * Windows-1252, the usual legacy encoding of Western subtitles.
 */
export function decodeSubtitle(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
