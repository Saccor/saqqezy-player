import { describe, expect, it } from 'vitest';
import { routedFetch } from './routedFetch.ts';

describe('routedFetch (the worker fetch)', () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const base = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response('');
  };
  const route = (url: string, h?: { userAgent?: string; referrer?: string }) =>
    h ? `/route?u=${encodeURIComponent(url)}&ua=${encodeURIComponent(h.userAgent ?? '')}` : `/route?u=${encodeURIComponent(url)}`;

  it('turns sourceHeaders into the route URL and strips the field before fetch', async () => {
    calls.length = 0;
    const ac = new AbortController();
    await routedFetch(base, route)('http://example.test/p.m3u', { sourceHeaders: { userAgent: 'A/1' }, signal: ac.signal });
    expect(calls[0]?.url).toBe('/route?u=http%3A%2F%2Fexample.test%2Fp.m3u&ua=A%2F1');
    expect(calls[0]?.init && 'sourceHeaders' in calls[0].init).toBe(false);
    expect(calls[0]?.init?.signal).toBe(ac.signal);
  });

  it('without headers the route gets none', async () => {
    calls.length = 0;
    await routedFetch(base, route)('http://example.test/p.m3u');
    expect(calls[0]?.url).toBe('/route?u=http%3A%2F%2Fexample.test%2Fp.m3u');
  });
});
