// One cron run (spec §2): pageviews → Wikidata → (TMDB) → rankFeed → publish. Every external request goes through
// one sequential, paced, budgeted helper. The run handles public metadata only; nothing about any user exists here.
import { feedKey, type FeedKind, type TrendingFeed } from './feed.ts';
import { rankFeed } from './rank.ts';
import {
  candidateArticles, compactTop, parseTmdbTrending, summarizeBatch, type DayTop, type EntitySummary,
} from './wikidata.ts';

/** Text files by key (R2 in the Worker, a Map in tests). */
export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, body: string): Promise<void>;
}

export interface PipelineDeps {
  fetch: typeof fetch;
  store: Store;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Operator contact for Wikimedia's User-Agent policy (a URL or an address). Required. */
  contact: string;
  langs: readonly string[];
  /** TMDB v3 key or v4 token (beta only). Without it TMDB is never asked. */
  tmdbKey?: string;
  /** External requests per run (the free plan allows 50 subrequests). */
  maxFetches?: number;
  /** Pause between two external requests. */
  paceMs?: number;
}

export interface RunSummary {
  done: { lang: string; movie: number; series: number }[];
  /** Why the run ended early, if it did (never a URL or a key). */
  stopped?: string;
}

export const PAGEVIEW_DAYS = 7;
const CANDIDATES_MAX = 500;
const WIKIDATA_BATCH = 50;
export const ENTITY_TTL_MS = 7 * 86_400_000;
const DEFAULT_MAX_FETCHES = 45;
const DEFAULT_PACE_MS = 500;
/** TMDB answers are reused for this long (runs are 6 h apart). */
const TMDB_TTL_MS = 5.5 * 3_600_000;
const TMDB_PAGES = 2;
const STATE_KEY = 'cache/state.json';
const TMDB_KEY = 'cache/tmdb.json';

class Stop extends Error {}

type EntityCache = Record<string, { at: number; s: EntitySummary | null }>;

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

async function readJson<T>(store: Store, key: string): Promise<T | undefined> {
  const text = await store.get(key);
  if (text === null) return undefined;
  try { return JSON.parse(text) as T; } catch { return undefined; }
}

export async function runTrending(deps: PipelineDeps): Promise<RunSummary> {
  const contact = deps.contact.trim();
  if (!contact) {
    throw new Error('CONTACT is not set: set the CONTACT var (a URL or address where Wikimedia can reach the operator) before the cron runs.');
  }
  const ua = `SaqqezyTrending/1 (${contact})`;
  const budget = deps.maxFetches ?? DEFAULT_MAX_FETCHES;
  const pace = deps.paceMs ?? DEFAULT_PACE_MS;
  const now = deps.now();
  let used = 0;

  /** One external GET: sequential, paced, counted. 429/503 stop the whole run (never hammer a service). */
  const get = async (url: string, headers: Record<string, string> = {}): Promise<Response> => {
    if (used >= budget) throw new Stop('request budget used up');
    if (used > 0) await deps.sleep(pace);
    used++;
    const res = await deps.fetch(url, { headers: { 'user-agent': ua, accept: 'application/json', ...headers } });
    if (res.status === 429 || res.status === 503) throw new Stop(`${new URL(url).hostname} answered ${res.status}`);
    return res;
  };

  const summary: RunSummary = { done: [] };
  const langs = deps.langs.filter((l) => /^[a-z]{2,3}$/.test(l));
  const state = (await readJson<{ next?: number }>(deps.store, STATE_KEY)) ?? {};
  const start = Number.isInteger(state.next) && state.next! >= 0 ? state.next! % Math.max(1, langs.length) : 0;
  let completed = 0;

  try {
    const tmdb = deps.tmdbKey?.trim() ? await tmdbTrending(deps, get, now) : undefined;
    for (let k = 0; k < langs.length; k++) {
      const lang = langs[(start + k) % langs.length]!;
      const result = await runLanguage(deps, get, lang, now, tmdb);
      if (result) summary.done.push({ lang, ...result });
      completed++;
    }
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    summary.stopped = err.message;
  }
  await deps.store.put(STATE_KEY, JSON.stringify({ next: langs.length ? (start + completed) % langs.length : 0, at: now }));
  return summary;
}

type Get = (url: string, headers?: Record<string, string>) => Promise<Response>;

async function tmdbTrending(deps: PipelineDeps, get: Get, now: number): Promise<{ movie: number[]; series: number[] } | undefined> {
  const cached = await readJson<{ at: number; movie: number[]; series: number[] }>(deps.store, TMDB_KEY);
  if (cached && now - cached.at < TMDB_TTL_MS) return cached;
  const key = deps.tmdbKey!.trim();
  // A v4 read token is a JWT; a v3 key is a short hex string.
  const bearer = key.startsWith('eyJ');
  const out = { movie: [] as number[], series: [] as number[] };
  try {
    for (const [kind, path] of [['movie', 'movie'], ['series', 'tv']] as const) {
      for (let page = 1; page <= TMDB_PAGES; page++) {
        const url = `https://api.themoviedb.org/3/trending/${path}/week?page=${page}${bearer ? '' : `&api_key=${encodeURIComponent(key)}`}`;
        const res = await get(url, bearer ? { authorization: `Bearer ${key}` } : {});
        if (!res.ok) return cached; // a bad key or an outage: the feed is built without the boost
        out[kind].push(...parseTmdbTrending(await res.json().catch(() => null)));
      }
    }
  } catch (err) {
    if (err instanceof Stop) throw err;
    return cached;
  }
  await deps.store.put(TMDB_KEY, JSON.stringify({ at: now, ...out }));
  return out;
}

/** Builds and publishes one language. Undefined when no pageviews were available (old files stay). */
async function runLanguage(
  deps: PipelineDeps, get: Get, lang: string, now: number, tmdb: { movie: number[]; series: number[] } | undefined,
): Promise<{ movie: number; series: number } | undefined> {
  const days: DayTop[] = [];
  for (let d = 1; d <= PAGEVIEW_DAYS; d++) {
    const day = now - d * 86_400_000;
    const key = `cache/pageviews/${lang}/${isoDay(day)}.json`;
    const cached = await readJson<DayTop>(deps.store, key);
    if (cached) { days.push(cached); continue; }
    const res = await get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/${lang}.wikipedia/all-access/${isoDay(day).replace(/-/g, '/')}`);
    if (!res.ok) continue; // 404: not published yet; asked again next run
    const top = compactTop(await res.json().catch(() => null));
    if (!top.length) continue;
    await deps.store.put(key, JSON.stringify(top));
    days.push(top);
  }
  if (!days.length) return undefined;

  const entityKey = `cache/entities/${lang}.json`;
  const cache = (await readJson<EntityCache>(deps.store, entityKey)) ?? {};
  const candidates = candidateArticles(days, CANDIDATES_MAX).map((c) => c.article);
  const missing = candidates.filter((a) => !cache[a] || now - cache[a].at > ENTITY_TTL_MS);
  let stop: Stop | undefined;
  try {
    for (let i = 0; i < missing.length; i += WIKIDATA_BATCH) {
      const batch = missing.slice(i, i + WIKIDATA_BATCH);
      const q = new URLSearchParams({
        action: 'wbgetentities', sites: `${lang}wiki`, titles: batch.join('|'), props: 'claims|labels|aliases|sitelinks',
        languages: lang === 'en' ? 'en' : `${lang}|en`, sitefilter: `${lang}wiki`, format: 'json',
      });
      const res = await get(`https://www.wikidata.org/w/api.php?${q}`);
      if (!res.ok) break; // the rest is asked next run
      const got = summarizeBatch(await res.json().catch(() => null), lang, batch);
      for (const [article, s] of Object.entries(got)) cache[article] = { at: now, s };
    }
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    stop = err; // publish what is known, then end the run
  }
  // Bounded: entries that are neither candidates now nor recent are dropped.
  const keep = new Set(candidates);
  for (const [a, e] of Object.entries(cache)) if (!keep.has(a) && now - e.at > 2 * ENTITY_TTL_MS) delete cache[a];
  await deps.store.put(entityKey, JSON.stringify(cache));

  const entities: Record<string, EntitySummary | null> = {};
  for (const [a, e] of Object.entries(cache)) entities[a] = e.s;
  const feeds = rankFeed({ lang, days, entities, ...(tmdb ? { tmdb } : {}), now });
  for (const kind of ['movie', 'series'] as FeedKind[]) {
    const feed: TrendingFeed = feeds[kind];
    // Never replace a good feed with an empty one (a cold cache whose Wikidata step failed).
    if (!feed.items.length && (await deps.store.get(feedKey(kind, lang))) !== null) continue;
    await deps.store.put(feedKey(kind, lang), JSON.stringify(feed));
  }
  if (stop) throw stop;
  return { movie: feeds.movie.items.length, series: feeds.series.items.length };
}
