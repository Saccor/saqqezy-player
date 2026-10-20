// The trending feed on the device (spec 2026-10-20-trending-design §4). Stale-while-revalidate: the last copy (meta)
// serves at once, a refresh runs in the background at most every 6 h, failures back off. The request is a bare GET
// of a public file: no credentials, no referrer, no headers of ours, nothing about the user or the library
// (CLAUDE.md rule 7). Matching against the library happens elsewhere, on the device (core `matchTrending`).
import { parseTrendingFeed, type Storage, type TrendingFeed, type VodKind } from '@iptv/core';

/** A copy younger than this is not asked again (the feed is rebuilt every 6 h). */
export const TRENDING_FRESH_MS = 6 * 3_600_000;
/** Waits after 1, 2, 3, 4 and 5+ failures in a row. */
export const TRENDING_BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
/** A language without a feed (404) is not asked again for this long; English is used meanwhile. */
export const TRENDING_MISSING_MS = 24 * 3_600_000;
const FALLBACK = 'en';
const KINDS: readonly VodKind[] = ['movie', 'series'];
const MISSING_KEY = 'trending:missing';

export interface TrendingServiceDeps {
  /** The feed base ("https://host/trending"); files are `<base>/v1/<kind>.<lang>.json`. */
  baseUrl: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  storage: Pick<Storage, 'getMeta' | 'setMeta'>;
  now?: () => number;
  /** The UI language ("sv-SE"); English when unknown. */
  language?: () => string | undefined;
  /** Notes a failure for diagnostics (never with the URL's query: it has none). */
  record?: (where: string, err: unknown) => void;
}

interface Entry { loaded: boolean; feed?: TrendingFeed; fetchedAt?: number }
interface Stored { feed: unknown; fetchedAt: number }

export class TrendingService {
  private readonly base: string;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly loads = new Map<string, Promise<void>>();
  private readonly inflight = new Set<string>();
  private readonly backoff = new Map<string, { fails: number; nextAt: number }>();
  private readonly jobs = new Set<Promise<void>>();
  /** Language → until when it is known to have no feed. */
  private missing: Record<string, number> = {};
  private missingLoad: Promise<void> | undefined;

  constructor(private readonly deps: TrendingServiceDeps) {
    this.base = deps.baseUrl.replace(/\/+$/, '');
    this.now = deps.now ?? Date.now;
  }

  /** Loads the stored copies for the current language (no network wait) and starts refreshes that are due. */
  async prime(): Promise<void> {
    await this.loadMissing();
    const lang = this.lang();
    await Promise.all(KINDS.map((k) => this.load(k, lang)));
    for (const k of KINDS) this.refreshIfDue(k, lang);
  }

  /** The current copy of `kind` (undefined until one is known); starts a background refresh when one is due. */
  feed(kind: VodKind): TrendingFeed | undefined {
    const lang = this.lang();
    const e = this.entries.get(key(kind, lang));
    if (!e?.loaded) {
      this.track(this.load(kind, lang).then(() => this.refreshIfDue(kind, lang)));
      return e?.feed;
    }
    this.refreshIfDue(kind, lang);
    return e.feed;
  }

  /** Test helper: resolves once no load or refresh is running. */
  async idle(): Promise<void> {
    while (this.jobs.size) await Promise.all([...this.jobs]);
  }

  private lang(): string {
    const raw = (this.deps.language?.() ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
    const lang = /^[a-z]{2,3}$/.test(raw) ? raw : FALLBACK;
    return (this.missing[lang] ?? 0) > this.now() ? FALLBACK : lang;
  }

  private track(p: Promise<void>): void {
    const job = p.catch((err) => this.deps.record?.('trending', err)).finally(() => this.jobs.delete(job));
    this.jobs.add(job);
  }

  private loadMissing(): Promise<void> {
    this.missingLoad ??= this.deps.storage.getMeta<Record<string, number>>(MISSING_KEY).then((m) => {
      if (m && typeof m === 'object') this.missing = { ...m, ...this.missing };
    }, () => undefined);
    return this.missingLoad;
  }

  /** Reads the stored copy once per kind and language. */
  private load(kind: VodKind, lang: string): Promise<void> {
    const k = key(kind, lang);
    if (this.entries.get(k)?.loaded) return Promise.resolve();
    let p = this.loads.get(k);
    if (!p) {
      p = this.deps.storage.getMeta<Stored>(k).then((stored) => {
        const e = this.entries.get(k) ?? { loaded: false };
        const feed = stored ? parseTrendingFeed(stored.feed, kind) : undefined;
        // A refresh that finished first wins.
        if (feed && !e.feed && typeof stored?.fetchedAt === 'number') {
          e.feed = feed;
          e.fetchedAt = stored.fetchedAt;
        }
        e.loaded = true;
        this.entries.set(k, e);
      }, () => {
        this.entries.set(k, { ...(this.entries.get(k) ?? {}), loaded: true });
      }).finally(() => this.loads.delete(k));
      this.loads.set(k, p);
    }
    return p;
  }

  private refreshIfDue(kind: VodKind, lang: string): void {
    const k = key(kind, lang);
    const now = this.now();
    const e = this.entries.get(k);
    if (!e?.loaded || this.inflight.has(k)) return;
    if (e.fetchedAt !== undefined && now - e.fetchedAt < TRENDING_FRESH_MS && e.fetchedAt <= now) return;
    const b = this.backoff.get(k);
    if (b && now < b.nextAt) return;
    this.inflight.add(k);
    this.track(this.refresh(kind, lang).finally(() => this.inflight.delete(k)));
  }

  private async refresh(kind: VodKind, lang: string): Promise<void> {
    const k = key(kind, lang);
    let res: Response;
    try {
      // Nothing but the path: no cookies, no referrer, no headers (and no conditional request, which would need a
      // CORS preflight; the HTTP cache and the server's max-age handle that).
      res = await this.deps.fetch(`${this.base}/v1/${kind}.${lang}.json`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    } catch (err) {
      this.failed(k);
      throw err;
    }
    if (res.status === 404 && lang !== FALLBACK) {
      this.missing[lang] = this.now() + TRENDING_MISSING_MS;
      await this.deps.storage.setMeta(MISSING_KEY, this.missing).catch(() => undefined);
      await this.load(kind, FALLBACK);
      this.refreshIfDue(kind, FALLBACK);
      return;
    }
    if (!res.ok) {
      this.failed(k);
      throw new Error(`The trending feed answered ${res.status}.`);
    }
    const feed = parseTrendingFeed(await res.json().catch(() => undefined), kind);
    if (!feed) {
      this.failed(k);
      throw new Error('The trending feed could not be read.');
    }
    const fetchedAt = this.now();
    this.entries.set(k, { loaded: true, feed, fetchedAt });
    this.backoff.delete(k);
    await this.deps.storage.setMeta(k, { feed, fetchedAt } satisfies Stored).catch(() => undefined);
  }

  private failed(k: string): void {
    const fails = (this.backoff.get(k)?.fails ?? 0) + 1;
    const wait = TRENDING_BACKOFF_MS[Math.min(fails, TRENDING_BACKOFF_MS.length) - 1]!;
    this.backoff.set(k, { fails, nextAt: this.now() + wait });
  }
}

const key = (kind: VodKind, lang: string) => `trending:${kind}:${lang}`;
