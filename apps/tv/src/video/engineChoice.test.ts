import { describe, expect, test } from 'vitest';
import { chooseEngine, nextEngineAfterFailure, type EngineCaps } from './engineChoice.ts';

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

  test('.m3u8: native HLS not preferred still beats nothing when hls.js is unsupported', () => {
    expect(chooseEngine('/live/u/p/1.m3u8', { ...safari, preferNativeHls: false, hlsJs: false })).toEqual({ engine: 'native' });
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

describe('nextEngineAfterFailure', () => {
  const caps = { nativeHls: false, hlsJs: true };
  test('extensionless URL: a format error in mpegts.js retries with hls.js once', () => {
    expect(nextEngineAfterFailure('', ['mpegts'], 'format', caps)).toBe('hls');
    expect(nextEngineAfterFailure('', ['mpegts', 'hls'], 'format', caps)).toBeUndefined();
  });
  test('uses native HLS when the element supports it', () => {
    expect(nextEngineAfterFailure('', ['mpegts'], 'format', { nativeHls: true, hlsJs: true })).toBe('native');
    expect(nextEngineAfterFailure('', ['mpegts', 'native'], 'format', { nativeHls: true, hlsJs: true })).toBeUndefined();
  });
  test('no retry for other error kinds, for URLs with an extension, or without an HLS engine', () => {
    expect(nextEngineAfterFailure('', ['mpegts'], 'other', caps)).toBeUndefined();
    expect(nextEngineAfterFailure('.ts', ['mpegts'], 'format', caps)).toBeUndefined();
    expect(nextEngineAfterFailure('', ['mpegts'], 'format', { nativeHls: false, hlsJs: false })).toBeUndefined();
  });
  test('only follows an mpegts attempt', () => {
    expect(nextEngineAfterFailure('', ['hls'], 'format', caps)).toBeUndefined();
  });
});
