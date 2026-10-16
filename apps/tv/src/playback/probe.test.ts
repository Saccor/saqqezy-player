import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROBE_TIMEOUT_MS, createStreamProbe } from './probe.ts';

const URL_A = 'http://example.test/live/u/p/1.ts';
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe('createStreamProbe', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends one GET with Range bytes=0-0 to the routed URL and returns the status', async () => {
    const fetchFn = vi.fn(async (_u: string, _i?: RequestInit) => response(206));
    const probe = createStreamProbe({ fetch: fetchFn, route: (u) => `/routed?u=${encodeURIComponent(u)}` });
    expect(await probe(URL_A, new AbortController().signal)).toEqual({ status: 206 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`/routed?u=${encodeURIComponent(URL_A)}`);
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.headers).toEqual({ Range: 'bytes=0-0' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts the request once the headers arrived (no body is read)', async () => {
    let seen: AbortSignal | undefined;
    const probe = createStreamProbe({ fetch: async (_u, i) => { seen = i?.signal ?? undefined; return response(200); } });
    await probe(URL_A, new AbortController().signal);
    expect(seen?.aborted).toBe(true);
  });

  it('reads Retry-After as delay-seconds or an HTTP date', async () => {
    const secs = createStreamProbe({ fetch: async () => response(429, { 'Retry-After': '90' }) });
    expect(await secs(URL_A, new AbortController().signal)).toEqual({ status: 429, retryAfterMs: 90_000 });
    const date = createStreamProbe({ fetch: async () => response(503, { 'Retry-After': new Date(NOW + 120_000).toUTCString() }) });
    expect(await date(URL_A, new AbortController().signal)).toEqual({ status: 503, retryAfterMs: 120_000 });
    const bad = createStreamProbe({ fetch: async () => response(403, { 'Retry-After': 'soon' }) });
    expect(await bad(URL_A, new AbortController().signal)).toEqual({ status: 403 });
  });

  it('returns {} when fetch throws, and never logs the URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const probe = createStreamProbe({ fetch: async () => { throw new TypeError(`Failed to fetch ${URL_A}`); } });
    expect(await probe(URL_A, new AbortController().signal)).toEqual({});
    for (const spy of [warn, log, error]) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain('example.test');
    }
    warn.mockRestore(); log.mockRestore(); error.mockRestore();
  });

  it('gives up after 5 s with {} and aborts the request', async () => {
    expect(PROBE_TIMEOUT_MS).toBe(5000);
    let seen: AbortSignal | undefined;
    const probe = createStreamProbe({
      fetch: (_u, i) => new Promise<Response>((_res, rej) => {
        seen = i?.signal ?? undefined;
        seen?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      }),
    });
    const out = probe(URL_A, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(4999);
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen?.aborted).toBe(true);
    expect(await out).toEqual({});
  });

  it("the caller's signal aborts the request and answers {}", async () => {
    let seen: AbortSignal | undefined;
    const probe = createStreamProbe({
      fetch: (_u, i) => new Promise<Response>((_res, rej) => {
        seen = i?.signal ?? undefined;
        seen?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      }),
    });
    const ctl = new AbortController();
    const out = probe(URL_A, ctl.signal);
    ctl.abort();
    expect(await out).toEqual({});
    expect(seen?.aborted).toBe(true);
    const pre = new AbortController();
    pre.abort();
    const fetchFn = vi.fn(async () => response(200));
    expect(await createStreamProbe({ fetch: fetchFn })(URL_A, pre.signal)).toEqual({});
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('a dev-proxy "unreachable" 502 counts as no answer', async () => {
    const probe = createStreamProbe({ fetch: async () => response(502, { 'x-dev-proxy-unreachable': '1' }), unwrap: () => { throw new TypeError('Failed to fetch'); } });
    expect(await probe(URL_A, new AbortController().signal)).toEqual({});
  });
});
