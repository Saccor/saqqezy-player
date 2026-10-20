import { beforeEach, describe, expect, test } from 'vitest';
import pageviewsTop from './fixtures/pageviews-top.json';
import wbgetentities from './fixtures/wbgetentities.json';
import { feedKey, type TrendingFeed } from '../src/feed.ts';
import { ENTITY_TTL_MS, PAGEVIEW_DAYS, runTrending, type PipelineDeps, type Store } from '../src/pipeline.ts';

const NOW = Date.UTC(2026, 9, 20, 6, 0);
const FIXTURES: Record<string, string> = { 'pageviews-top.json': JSON.stringify(pageviewsTop), 'wbgetentities.json': JSON.stringify(wbgetentities) };
const fixture = (name: string) => FIXTURES[name]!;

class MemStore implements Store {
  readonly data = new Map<string, string>();
  async get(key: string) { return this.data.get(key) ?? null; }
  async put(key: string, body: string) { this.data.set(key, body); }
  json<T>(key: string): T { return JSON.parse(this.data.get(key)!) as T; }
}

interface Call { url: string; ua: string | null; auth: string | null }
let calls: Call[];
let sleeps: number[];
let store: MemStore;
/** Overrides per URL substring: a status, or a body. */
let answers: { match: string; status?: number; body?: string }[];

function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const headers = new Headers(init?.headers);
  calls.push({ url, ua: headers.get('user-agent'), auth: headers.get('authorization') });
  const a = answers.find((x) => url.includes(x.match));
  if (a) return Promise.resolve(new Response(a.body ?? '', { status: a.status ?? 200 }));
  if (url.includes('/pageviews/top/')) return Promise.resolve(new Response(fixture('pageviews-top.json')));
  if (url.includes('wbgetentities')) return Promise.resolve(new Response(fixture('wbgetentities.json')));
  if (url.includes('api.themoviedb.org')) return Promise.resolve(new Response(JSON.stringify({ results: [{ id: 920003 }] })));
  return Promise.resolve(new Response('', { status: 404 }));
}

function deps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    fetch: fakeFetch as typeof fetch, store, now: () => NOW, sleep: async (ms) => { sleeps.push(ms); },
    contact: 'https://example.test/contact', langs: ['sv'], ...over,
  };
}

beforeEach(() => {
  calls = []; sleeps = []; store = new MemStore(); answers = [];
});

describe('runTrending', () => {
  test('without CONTACT it fails before any request', async () => {
    await expect(runTrending(deps({ contact: ' ' }))).rejects.toThrow(/CONTACT is not set/);
    expect(calls).toEqual([]);
  });

  test('builds and publishes both feeds of a language from the last 7 days', async () => {
    const summary = await runTrending(deps());
    const days = calls.filter((c) => c.url.includes('/pageviews/top/sv.wikipedia/all-access/'));
    expect(days.map((c) => c.url.slice(-10))).toEqual([
      '2026/10/19', '2026/10/18', '2026/10/17', '2026/10/16', '2026/10/15', '2026/10/14', '2026/10/13',
    ]);
    expect(days).toHaveLength(PAGEVIEW_DAYS);
    const wd = calls.filter((c) => c.url.includes('wbgetentities'));
    expect(wd).toHaveLength(1);
    const asked = new URL(wd[0]!.url).searchParams;
    expect(asked.get('sites')).toBe('svwiki');
    expect(asked.get('languages')).toBe('sv|en');
    // Namespaced articles, the main page and "-" are never asked about.
    expect(asked.get('titles')!.split('|').sort()).toEqual(
      ['Synthetic Person', 'Synthetic Sequel: Part Two', 'Syntetisk film (film, 2025)', 'Syntetisk serie'].sort(),
    );
    const movie = store.json<TrendingFeed>(feedKey('movie', 'sv'));
    expect(movie.items.map((i) => i.wd)).toEqual(['Q900001']);
    expect(store.json<TrendingFeed>(feedKey('series', 'sv')).items.map((i) => i.wd)).toEqual(['Q900003']);
    expect(summary.done).toEqual([{ lang: 'sv', movie: 1, series: 1 }]);
  });

  test('every request carries the descriptive User-Agent; requests are paced, one at a time', async () => {
    await runTrending(deps());
    expect(new Set(calls.map((c) => c.ua))).toEqual(new Set(['SaqqezyTrending/1 (https://example.test/contact)']));
    expect(sleeps).toHaveLength(calls.length - 1);
    expect(sleeps.every((ms) => ms >= 500)).toBe(true);
  });

  test('a second run reuses cached days and entities: only today\'s newest day is asked again', async () => {
    await runTrending(deps());
    calls = [];
    await runTrending(deps({ now: () => NOW + 86_400_000 }));
    expect(calls.map((c) => c.url.slice(-10))).toEqual(['2026/10/20']);
  });

  test('entities are asked again after their TTL', async () => {
    await runTrending(deps());
    calls = [];
    await runTrending(deps({ now: () => NOW + ENTITY_TTL_MS + 1 }));
    expect(calls.filter((c) => c.url.includes('wbgetentities'))).toHaveLength(1);
  });

  test('a day not yet published (404) is skipped and asked again next run', async () => {
    answers = [{ match: '2026/10/19', status: 404 }];
    await runTrending(deps());
    expect(store.data.has('cache/pageviews/sv/2026-10-19.json')).toBe(false);
    expect(store.data.has('cache/pageviews/sv/2026-10-18.json')).toBe(true);
    expect(store.data.has(feedKey('movie', 'sv'))).toBe(true);
  });

  test('a 429 stops the run at once and publishes nothing for that language', async () => {
    store.data.set(feedKey('movie', 'sv'), '{"old":true}');
    answers = [{ match: '/pageviews/top/', status: 429 }];
    const summary = await runTrending(deps({ langs: ['sv', 'en'] }));
    expect(calls).toHaveLength(1);
    expect(store.data.get(feedKey('movie', 'sv'))).toBe('{"old":true}');
    expect(summary.done).toEqual([]);
    expect(summary.stopped).toMatch(/429/);
  });

  test('the request budget stops a run; the next run continues with the language it stopped at', async () => {
    const s1 = await runTrending(deps({ langs: ['sv', 'en'], maxFetches: 10 }));
    expect(s1.done.map((d) => d.lang)).toEqual(['sv']);
    expect(calls).toHaveLength(10);
    calls = [];
    const s2 = await runTrending(deps({ langs: ['sv', 'en'], maxFetches: 10 }));
    expect(calls[0]!.url).toContain('/en.wikipedia/');
    // en finishes from its cached days; sv is then all cache (no request) and is rebuilt too.
    expect(s2.done.map((d) => d.lang)).toEqual(['en', 'sv']);
  });

  test('TMDB is asked only with a key: a v4 token as Bearer, a v3 key as api_key; cached for the day', async () => {
    await runTrending(deps());
    expect(calls.some((c) => c.url.includes('themoviedb'))).toBe(false);

    calls = [];
    store = new MemStore();
    await runTrending(deps({ tmdbKey: 'eyJhbGciOi.test.token' }));
    const tmdb = calls.filter((c) => c.url.includes('themoviedb'));
    expect(tmdb.map((c) => new URL(c.url).pathname)).toEqual([
      '/3/trending/movie/week', '/3/trending/movie/week', '/3/trending/tv/week', '/3/trending/tv/week',
    ]);
    expect(tmdb.every((c) => c.auth === 'Bearer eyJhbGciOi.test.token' && !c.url.includes('api_key'))).toBe(true);

    calls = [];
    store = new MemStore();
    await runTrending(deps({ tmdbKey: 'abc123' }));
    expect(calls.filter((c) => c.url.includes('themoviedb')).every((c) => c.url.includes('api_key=abc123') && c.auth === null)).toBe(true);

    calls = [];
    await runTrending(deps({ tmdbKey: 'abc123', now: () => NOW + 3_600_000 }));
    expect(calls.some((c) => c.url.includes('themoviedb'))).toBe(false);
  });

  test('a failing TMDB never stops the feed', async () => {
    answers = [{ match: 'themoviedb', status: 500 }];
    const summary = await runTrending(deps({ tmdbKey: 'abc123' }));
    expect(summary.done).toEqual([{ lang: 'sv', movie: 1, series: 1 }]);
  });

  test('a failing Wikidata batch publishes what is known and leaves the rest for the next run', async () => {
    answers = [{ match: 'wbgetentities', status: 500 }];
    const summary = await runTrending(deps());
    expect(summary.done).toEqual([{ lang: 'sv', movie: 0, series: 0 }]);
    answers = [];
    calls = [];
    await runTrending(deps());
    expect(calls.filter((c) => c.url.includes('wbgetentities'))).toHaveLength(1);
  });

  test('a key never appears in the summary', async () => {
    answers = [{ match: 'themoviedb', status: 401 }];
    const summary = await runTrending(deps({ tmdbKey: 'secret-key-1' }));
    expect(JSON.stringify(summary)).not.toContain('secret-key-1');
  });
});
