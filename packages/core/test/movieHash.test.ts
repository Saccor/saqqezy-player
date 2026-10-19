import { describe, expect, test } from 'vitest';
import { HASH_CHUNK, fetchMovieHash, openSubtitlesHash } from '../src/subtitles/movieHash.ts';
import type { FetchFn } from '../src/types.ts';

describe('openSubtitlesHash', () => {
  test('the file size plus every 64-bit little-endian word of the first and last 64 KB, mod 2^64', () => {
    const zeros = new Uint8Array(HASH_CHUNK);
    expect(openSubtitlesHash(2 * HASH_CHUNK, zeros, zeros)).toBe('0000000000020000');
    const head = new Uint8Array(HASH_CHUNK);
    head[0] = 1; // +1
    head[8] = 0x00; head[9] = 0x01; // +256
    expect(openSubtitlesHash(2 * HASH_CHUNK, head, zeros)).toBe('0000000000020101');
  });

  test('wraps at 2^64', () => {
    const tail = new Uint8Array(HASH_CHUNK);
    tail.fill(0xff, 0, 8); // + (2^64 - 1)
    const head = new Uint8Array(HASH_CHUNK);
    head[0] = 1;
    expect(openSubtitlesHash(2 * HASH_CHUNK, head, tail)).toBe('0000000000020000');
  });
});

describe('fetchMovieHash', () => {
  const SIZE = 3 * HASH_CHUNK;
  const file = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i++) file[i] = (i * 7) % 256;

  function rangeServer(opts: { ignoreRange?: boolean; status?: number } = {}) {
    const asked: string[] = [];
    let aborted = 0;
    const f: FetchFn = async (_url, init) => {
      const range = new Headers(init?.headers).get('range') ?? '';
      asked.push(range);
      init?.signal?.addEventListener('abort', () => { aborted++; });
      if (opts.status) return new Response('', { status: opts.status });
      if (opts.ignoreRange) return new Response(file, { status: 200 });
      const m = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const from = Number(m[1]);
      const to = Math.min(Number(m[2]), SIZE - 1);
      return new Response(file.slice(from, to + 1), { status: 206, headers: { 'content-range': `bytes ${from}-${to}/${SIZE}` } });
    };
    return { f, asked, aborted: () => aborted };
  }

  test('two range requests: the head (which gives the size) and the tail', async () => {
    const s = rangeServer();
    const hash = await fetchMovieHash(s.f, 'http://p.test/movie/u/p/1.mkv');
    expect(hash).toBe(openSubtitlesHash(SIZE, file.slice(0, HASH_CHUNK), file.slice(SIZE - HASH_CHUNK)));
    expect(s.asked).toEqual([`bytes=0-${HASH_CHUNK - 1}`, `bytes=${SIZE - HASH_CHUNK}-${SIZE - 1}`]);
  });

  test('a server that ignores the range: aborted at once (never downloads the film), no hash', async () => {
    const s = rangeServer({ ignoreRange: true });
    expect(await fetchMovieHash(s.f, 'http://p.test/1.mkv')).toBeUndefined();
    expect(s.asked).toHaveLength(1);
    expect(s.aborted()).toBe(1);
  });

  test('refused, unreachable, too small or a playlist: no hash, no error', async () => {
    expect(await fetchMovieHash(rangeServer({ status: 403 }).f, 'http://p.test/1.mkv')).toBeUndefined();
    expect(await fetchMovieHash(async () => { throw new TypeError('Failed to fetch'); }, 'http://p.test/1.mkv')).toBeUndefined();
    const small: FetchFn = async () => new Response(new Uint8Array(100), { status: 206, headers: { 'content-range': 'bytes 0-99/100' } });
    expect(await fetchMovieHash(small, 'http://p.test/1.mkv')).toBeUndefined();
    const s = rangeServer();
    expect(await fetchMovieHash(s.f, 'http://p.test/movie/u/p/1.m3u8')).toBeUndefined();
    expect(s.asked).toEqual([]);
  });
});
