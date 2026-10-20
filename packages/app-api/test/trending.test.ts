import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryStorage } from '@iptv/storage';
import type { TrendingFeed } from '@iptv/core';
import { TRENDING_BACKOFF_MS, TRENDING_FRESH_MS, TrendingService } from '../src/trending.ts';

const BASE = 'https://feed.example.test/trending';
const HOUR = 3_600_000;

const feedOf = (kind: 'movie' | 'series', lang: string, wd = 'Q900001'): TrendingFeed =>
  ({ v: 1, kind, lang, at: '2026-10-20T00:00:00.000Z', items: [{ rank: 1, wd, year: 2025, titles: ['Synthetic Film'] }] });

interface Call { url: string; init: RequestInit | undefined }
let calls: Call[];
let t: number;
let storage: MemoryStorage;
/** Per URL: a status, a body, or a thrown error. Unlisted URLs answer with a valid feed of their kind and language. */
let answers: Map<string, { status?: number; body?: unknown; throws?: boolean }>;
let lang: string | undefined;

async function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
  calls.push({ url, init });
  const a = answers.get(url);
  if (a?.throws) throw new TypeError('fetch failed');
  if (a) return new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status ?? 200 });
  const m = /\/v1\/(movie|series)\.([a-z]+)\.json$/.exec(url)!;
  return new Response(JSON.stringify(feedOf(m[1] as 'movie' | 'series', m[2]!)), { status: 200 });
}

const make = () => new TrendingService({ baseUrl: BASE, fetch: fakeFetch, storage, now: () => t, language: () => lang });

beforeEach(() => {
  calls = []; t = Date.UTC(2026, 9, 20, 12); storage = new MemoryStorage(); answers = new Map(); lang = 'en-US';
});

describe('TrendingService', () => {
  test('nothing known at first: prime asks the network in the background; then the feed is there and kept in meta', async () => {
    const s = make();
    expect(s.feed('movie')).toBeUndefined();
    await s.prime();
    await s.idle();
    expect(calls.map((c) => c.url).sort()).toEqual([`${BASE}/v1/movie.en.json`, `${BASE}/v1/series.en.json`]);
    expect(s.feed('movie')?.items[0]?.wd).toBe('Q900001');
    expect(s.feed('series')?.kind).toBe('series');
    expect(await storage.getMeta('trending:movie:en')).toMatchObject({ fetchedAt: t, feed: { kind: 'movie' } });
  });

  test('the request carries nothing but the path: no credentials, no referrer, no headers', async () => {
    const s = make();
    await s.prime();
    await s.idle();
    for (const c of calls) {
      expect(c.init).toEqual({ credentials: 'omit', referrerPolicy: 'no-referrer' });
      expect(new URL(c.url).search).toBe('');
    }
  });

  test('cold start: the stored copy is served at once; a fresh copy asks nothing', async () => {
    await storage.setMeta('trending:movie:en', { feed: feedOf('movie', 'en', 'Q42'), fetchedAt: t - HOUR });
    await storage.setMeta('trending:series:en', { feed: feedOf('series', 'en', 'Q43'), fetchedAt: t - HOUR });
    const s = make();
    await s.prime();
    expect(s.feed('movie')?.items[0]?.wd).toBe('Q42');
    await s.idle();
    expect(calls).toEqual([]);
  });

  test('stale-while-revalidate: an old copy keeps serving while the refresh runs, then the new one replaces it', async () => {
    await storage.setMeta('trending:movie:en', { feed: feedOf('movie', 'en', 'Q42'), fetchedAt: t - TRENDING_FRESH_MS - 1 });
    const s = make();
    await s.prime();
    expect(s.feed('movie')?.items[0]?.wd).toBe('Q42');
    await s.idle();
    expect(s.feed('movie')?.items[0]?.wd).toBe('Q900001');
  });

  test('refreshes at most every 6 h', async () => {
    const s = make();
    await s.prime();
    await s.idle();
    calls = [];
    t += TRENDING_FRESH_MS - 1;
    s.feed('movie');
    await s.idle();
    expect(calls).toEqual([]);
    t += 2;
    s.feed('movie');
    await s.idle();
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/v1/movie.en.json`]);
  });

  test('failures back off, growing; a success resets the backoff; the old copy stays', async () => {
    await storage.setMeta('trending:movie:en', { feed: feedOf('movie', 'en', 'Q42'), fetchedAt: 0 });
    answers.set(`${BASE}/v1/movie.en.json`, { throws: true });
    const s = make();
    await s.prime();
    await s.idle();
    expect(calls.filter((c) => c.url.includes('movie'))).toHaveLength(1);
    const asked = () => calls.filter((c) => c.url.includes('movie')).length;

    t += TRENDING_BACKOFF_MS[0]! - 1;
    s.feed('movie'); await s.idle();
    expect(asked()).toBe(1);
    t += 1;
    s.feed('movie'); await s.idle();
    expect(asked()).toBe(2);
    t += TRENDING_BACKOFF_MS[0]!;
    s.feed('movie'); await s.idle();
    expect(asked()).toBe(2); // the second wait is longer
    t += TRENDING_BACKOFF_MS[1]!;
    answers.set(`${BASE}/v1/movie.en.json`, { status: 500 });
    s.feed('movie'); await s.idle();
    expect(asked()).toBe(3);
    expect(s.feed('movie')?.items[0]?.wd).toBe('Q42');

    answers.delete(`${BASE}/v1/movie.en.json`);
    t += TRENDING_BACKOFF_MS[2]!;
    s.feed('movie'); await s.idle();
    expect(s.feed('movie')?.items[0]?.wd).toBe('Q900001');
  });

  test('a bad body or another version is a failure, never installed', async () => {
    answers.set(`${BASE}/v1/movie.en.json`, { body: { v: 2, kind: 'movie', items: [] } });
    answers.set(`${BASE}/v1/series.en.json`, { body: 'not json at all' });
    const s = make();
    await s.prime();
    await s.idle();
    expect(s.feed('movie')).toBeUndefined();
    expect(s.feed('series')).toBeUndefined();
    expect(await storage.getMeta('trending:movie:en')).toBeUndefined();
  });

  test('the UI language first; a 404 falls back to English and is remembered across restarts', async () => {
    lang = 'sv-SE';
    answers.set(`${BASE}/v1/movie.sv.json`, { status: 404 });
    answers.set(`${BASE}/v1/series.sv.json`, { status: 404 });
    const s = make();
    await s.prime();
    await s.idle();
    expect(calls.map((c) => c.url).sort()).toEqual([
      `${BASE}/v1/movie.en.json`, `${BASE}/v1/movie.sv.json`, `${BASE}/v1/series.en.json`, `${BASE}/v1/series.sv.json`,
    ]);
    expect(s.feed('movie')?.lang).toBe('en');

    calls = [];
    const again = make();
    await again.prime();
    expect(again.feed('movie')?.lang).toBe('en');
    await again.idle();
    expect(calls).toEqual([]);

    // A day later the language is tried again.
    t += 25 * HOUR;
    const later = make();
    await later.prime();
    await later.idle();
    expect(calls.some((c) => c.url.endsWith('movie.sv.json'))).toBe(true);
  });

  test('a language with a feed is used; an odd or missing language means English', async () => {
    lang = 'sv';
    const s = make();
    await s.prime();
    await s.idle();
    expect(s.feed('movie')?.lang).toBe('sv');
    for (const l of [undefined, '', 'x', 'not a tag']) {
      lang = l;
      calls = [];
      storage = new MemoryStorage();
      const e = make();
      await e.prime();
      await e.idle();
      expect(calls.map((c) => c.url)).toContain(`${BASE}/v1/movie.en.json`);
    }
  });

  test('a trailing slash in the base URL is fine', async () => {
    const s = new TrendingService({ baseUrl: `${BASE}/`, fetch: fakeFetch, storage, now: () => t, language: () => 'en' });
    await s.prime();
    await s.idle();
    expect(calls[0]!.url.startsWith(`${BASE}/v1/`)).toBe(true);
  });
});
