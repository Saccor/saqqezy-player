import { subtitleText } from '@iptv/core';

/**
 * Native HLS for a stream, or hls.js. Live keeps the platform preference. A VOD title uses native HLS only where the
 * element exposes `audioTracks`: elsewhere (desktop Chromium's built-in HLS) its alternate audio and subtitle
 * renditions cannot be listed or switched, while hls.js can.
 */
export function nativeHlsPreferred(s: { prefer: boolean; live: boolean; audioTrackApi: boolean }): boolean {
  return s.prefer && (s.live || s.audioTrackApi);
}

/**
 * The text of a track's active cues for the app to draw: markup removed and line breaks kept (`subtitleText`), one
 * cue after another. Null when nothing is left.
 */
export function cueTextOf(cues: ArrayLike<{ text?: string }> | null | undefined): string | null {
  if (!cues) return null;
  const lines: string[] = [];
  for (let i = 0; i < cues.length; i++) {
    const raw = cues[i]?.text;
    if (!raw) continue;
    const text = subtitleText(raw);
    if (text) lines.push(text);
  }
  return lines.length ? lines.join('\n') : null;
}
