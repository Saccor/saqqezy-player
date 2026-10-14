import { describe, expect, test } from 'vitest';
import { SourceNetworkError } from '../src/errors.ts';
import { alternateStreamUrl } from '../src/net/alternate.ts';
import { API_TIMEOUT_MS, BODY_IDLE_MS, DOWNLOAD_TIMEOUT_MS, withTimeout } from '../src/net/timeout.ts';
import type { FetchFn } from '../src/types.ts';

describe('withTimeout', () => {
  test('passes through a fast response', async () => {
    const f = withTimeout(async () => new Response('ok'), 50);
    expect(await (await f('http://example.test/a')).text()).toBe('ok');
  });

  test('aborts and rejects with SourceNetworkError when headers are late', async () => {
    let aborted = false;
    const slow: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const err = await withTimeout(slow, 20)('http://example.test/a').catch((e: Error) => e);
    expect(err).toBeInstanceOf(SourceNetworkError);
    expect((err as Error).message).toBe('The provider did not respond in time.');
    expect(aborted).toBe(true);
  });

  test('rejects even if the underlying fetch ignores the signal', async () => {
    const never: FetchFn = () => new Promise(() => {});
    await expect(withTimeout(never, 20)('http://example.test/a')).rejects.toBeInstanceOf(SourceNetworkError);
  });

  test('does not time out the body once headers have arrived', async () => {
    let inner: AbortSignal | undefined;
    const f: FetchFn = async (_url, init) => {
      inner = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          await new Promise((r) => setTimeout(r, 60));
          c.enqueue(new TextEncoder().encode('late'));
          c.close();
        },
      });
      return new Response(body);
    };
    const res = await withTimeout(f, 20)('http://example.test/a');
    await new Promise((r) => setTimeout(r, 50));
    expect(inner?.aborted).toBe(false);
    expect(await res.text()).toBe('late');
  });

  test('a caller abort after headers still aborts the inner signal', async () => {
    let inner: AbortSignal | undefined;
    const f: FetchFn = async (_url, init) => {
      inner = init?.signal ?? undefined;
      return new Response('ok');
    };
    const outer = new AbortController();
    await withTimeout(f, 20)('http://example.test/a', { signal: outer.signal });
    expect(inner?.aborted).toBe(false);
    outer.abort();
    expect(inner?.aborted).toBe(true);
  });

  test('a per-call timeoutMs overrides the default and is not passed on', async () => {
    const seen: (RequestInit | undefined)[] = [];
    const never: FetchFn = (_url, init) => { seen.push(init); return new Promise(() => {}); };
    const started = Date.now();
    await expect(withTimeout(never, 10_000)('http://example.test/a', { timeoutMs: 20 })).rejects.toBeInstanceOf(SourceNetworkError);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(seen[0]).not.toHaveProperty('timeoutMs');
    const late: FetchFn = () => new Promise((r) => setTimeout(() => r(new Response('ok')), 40));
    expect(await (await withTimeout(late, 10)('http://example.test/a', { timeoutMs: 1000 })).text()).toBe('ok');
  });

  test('timeouts fit real providers', () => {
    expect(API_TIMEOUT_MS).toBe(15_000);
    expect(DOWNLOAD_TIMEOUT_MS).toBe(90_000);
    expect(BODY_IDLE_MS).toBe(30_000);
  });

  test('other fetch errors pass through unchanged', async () => {
    const boom = new Error('boom');
    await expect(
      withTimeout(async () => { throw boom; }, 50)('http://example.test/a'),
    ).rejects.toBe(boom);
  });
});

describe('alternateStreamUrl', () => {
  test('swaps ts and m3u8 for live paths and keeps the query', () => {
    expect(alternateStreamUrl('http://example.test:80/live/u/p/12.ts')).toBe('http://example.test:80/live/u/p/12.m3u8');
    expect(alternateStreamUrl('http://example.test/live/u/p/12.m3u8')).toBe('http://example.test/live/u/p/12.ts');
    expect(alternateStreamUrl('http://example.test/live/u/p/12.ts?x=1&y=2')).toBe('http://example.test/live/u/p/12.m3u8?x=1&y=2');
  });

  test('maps the Xtream short form /{u}/{p}/{id} to the HLS live path', () => {
    expect(alternateStreamUrl('http://example.test:8080/u/p/123')).toBe('http://example.test:8080/live/u/p/123.m3u8');
    expect(alternateStreamUrl('http://example.test/u%40x/p%2Fq/9?token=1')).toBe('http://example.test/live/u%40x/p%2Fq/9.m3u8?token=1');
  });

  test('leaves other extensionless paths alone', () => {
    expect(alternateStreamUrl('http://example.test/u/p/abc')).toBeUndefined();
    expect(alternateStreamUrl('http://example.test/a/u/p/123')).toBeUndefined();
    expect(alternateStreamUrl('http://example.test/p/123')).toBeUndefined();
    expect(alternateStreamUrl('http://example.test/u/p/123/')).toBeUndefined();
    expect(alternateStreamUrl('http://example.test/u//123')).toBeUndefined();
  });

  test('returns undefined for anything else', () => {
    expect(alternateStreamUrl('http://example.test/movie/u/p/12.ts')).toBeUndefined();
    expect(alternateStreamUrl('http://example.test/live/u/12.ts')).toBeUndefined();
    expect(alternateStreamUrl('http://example.test/live/u/p/12.mp4')).toBeUndefined();
    expect(alternateStreamUrl('http://example.test/stream.m3u8')).toBeUndefined();
    expect(alternateStreamUrl('not a url')).toBeUndefined();
  });
});
