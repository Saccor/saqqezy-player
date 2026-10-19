import { describe, expect, test } from 'vitest';
import { maskUrl } from './maskUrl.ts';

describe('maskUrl (dev proxy log)', () => {
  test('masks Xtream credentials in the long live/movie/series/timeshift forms', () => {
    expect(maskUrl(new URL('http://h:8080/live/alice/s3cret/12.m3u8'))).toBe('http://h:8080/live/***/***/12.m3u8');
    expect(maskUrl(new URL('http://h/movie/alice/s3cret/7.mkv'))).toBe('http://h/movie/***/***/7.mkv');
    expect(maskUrl(new URL('http://h/series/alice/s3cret/9.mp4'))).toBe('http://h/series/***/***/9.mp4');
    expect(maskUrl(new URL('http://h/timeshift/alice/s3cret/60/2026-10-20:20-00/5.ts'))).toBe('http://h/timeshift/***/***/60/2026-10-20:20-00/5.ts');
  });

  test('masks the short form /{user}/{pass}/{id}', () => {
    expect(maskUrl(new URL('http://h/alice/s3cret/12'))).toBe('http://h/***/***/12');
    expect(maskUrl(new URL('http://h/alice/s3cret/12.ts'))).toBe('http://h/***/***/12.ts');
  });

  test('masks every query value, keeps the keys', () => {
    expect(maskUrl(new URL('http://h/get.php?username=alice&password=s3cret&type=m3u'))).toBe('http://h/get.php?username=***&password=***&type=***');
  });

  test('leaves ordinary paths alone', () => {
    expect(maskUrl(new URL('https://h/hls/stream/index.m3u8'))).toBe('https://h/hls/stream/index.m3u8');
    expect(maskUrl(new URL('https://h/a/b'))).toBe('https://h/a/b');
  });
});
