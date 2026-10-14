import { describe, expect, test } from 'vitest';
import { chooseEngine, type EngineCaps } from './engineChoice.ts';

const chrome: EngineCaps = { nativeHls: false, nativeTs: false, hlsJs: true, mpegtsJs: true, preferNativeHls: true };
const safari: EngineCaps = { nativeHls: true, nativeTs: false, hlsJs: true, mpegtsJs: true, preferNativeHls: true };
const tsTv: EngineCaps = { nativeHls: true, nativeTs: true, hlsJs: false, mpegtsJs: false, preferNativeHls: true };

describe('chooseEngine', () => {
  test('.m3u8: native HLS when available and preferred, else hls.js, else none', () => {
    expect(chooseEngine('/live/u/p/1.m3u8', safari)).toEqual({ engine: 'native' });
    expect(chooseEngine('/live/u/p/1.m3u8', { ...safari, preferNativeHls: false })).toEqual({ engine: 'hls' });
    expect(chooseEngine('/live/u/p/1.m3u8', chrome)).toEqual({ engine: 'hls' });
    expect(chooseEngine('/live/u/p/1.m3u8', { ...chrome, hlsJs: false })).toEqual({ engine: 'none', reason: 'hls' });
  });

  test('.ts: mpegts.js, else none', () => {
    expect(chooseEngine('/live/u/p/1.ts', chrome)).toEqual({ engine: 'mpegts' });
    expect(chooseEngine('/live/u/p/1.ts', { ...chrome, mpegtsJs: false })).toEqual({ engine: 'none', reason: 'mpegts' });
  });

  test('other extensions go to the element', () => {
    expect(chooseEngine('/movie.mp4', chrome)).toEqual({ engine: 'native' });
    expect(chooseEngine('/a.b/stream.mkv', chrome)).toEqual({ engine: 'native' });
  });

  test('extensionless (Xtream short form): mpegts.js unless the element says it plays MPEG-TS', () => {
    expect(chooseEngine('/user/pass/123', chrome)).toEqual({ engine: 'mpegts' });
    expect(chooseEngine('/user/pass/123', safari)).toEqual({ engine: 'mpegts' });
    expect(chooseEngine('/user/pass/123', { ...chrome, nativeTs: true })).toEqual({ engine: 'native', fallback: 'mpegts' });
    expect(chooseEngine('/user/pass/123', tsTv)).toEqual({ engine: 'native' });
    expect(chooseEngine('/user/pass/123', { ...chrome, mpegtsJs: false })).toEqual({ engine: 'native' });
    expect(chooseEngine('/a.b/123', chrome)).toEqual({ engine: 'mpegts' });
    expect(chooseEngine('/', chrome)).toEqual({ engine: 'mpegts' });
  });
});
