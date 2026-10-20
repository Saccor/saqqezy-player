// The ranking (spec §2, `rankFeed`). Pure: no network, no clock of its own.
import { FEED_MAX, type FeedKind, type TrendingFeed, type TrendingFeedItem } from './feed.ts';
import { articleKey, type DayTop, type EntitySummary } from './wikidata.ts';

const YEAR_MS = 365.25 * 86_400_000;

export interface RankInput {
  lang: string;
  /** The last days' top articles (underscores, as Wikimedia sends them). */
  days: readonly DayTop[];
  /** Article (spaces) → its summary, or null when it is not a film or series. Unknown articles are skipped. */
  entities: Readonly<Record<string, EntitySummary | null>>;
  /** TMDB weekly trending ids, best first (beta booster; absent without a key). */
  tmdb?: { movie: readonly number[]; series: readonly number[] };
  now: number;
}

/** 1 for a title out less than a year (or not yet out), then 1 / (1 + (age − 1) / 2), floored at 0.1; unknown 0.5. */
export function recency(date: number | undefined, now: number): number {
  if (date === undefined) return 0.5;
  const age = (now - date) / YEAR_MS;
  if (age <= 1) return 1;
  return Math.max(0.1, 1 / (1 + (age - 1) / 2));
}

interface Scored { e: EntitySummary; views: number; score: number }

export function rankFeed(input: RankInput): Record<FeedKind, TrendingFeed> {
  const byWd = new Map<string, { e: EntitySummary; views: number }>();
  for (const day of input.days) {
    for (const [article, views] of day) {
      const e = input.entities[articleKey(article)];
      if (!e) continue;
      const cur = byWd.get(e.wd);
      if (cur) cur.views += views;
      else byWd.set(e.wd, { e, views });
    }
  }
  const boost = (kind: FeedKind, tmdb: number | undefined): number => {
    const list = input.tmdb?.[kind];
    if (!list?.length || tmdb === undefined) return 1;
    const r = list.indexOf(tmdb);
    return r < 0 ? 1 : 1 + (list.length - r) / list.length;
  };
  const at = new Date(input.now).toISOString();
  const feed = (kind: FeedKind): TrendingFeed => {
    const scored: Scored[] = [];
    for (const { e, views } of byWd.values()) {
      if (e.kind !== kind) continue;
      scored.push({ e, views, score: views * recency(e.date, input.now) * boost(kind, e.tmdb) });
    }
    scored.sort((a, b) => b.score - a.score || b.views - a.views || (a.e.wd < b.e.wd ? -1 : a.e.wd > b.e.wd ? 1 : 0));
    const items: TrendingFeedItem[] = [];
    const tmdbSeen = new Set<number>();
    for (const { e } of scored) {
      if (items.length >= FEED_MAX) break;
      if (e.tmdb !== undefined) {
        if (tmdbSeen.has(e.tmdb)) continue;
        tmdbSeen.add(e.tmdb);
      }
      const item: TrendingFeedItem = { rank: items.length + 1, wd: e.wd, titles: [...e.titles] };
      if (e.tmdb !== undefined) item.tmdb = e.tmdb;
      if (e.imdb !== undefined) item.imdb = e.imdb;
      if (e.year !== undefined) item.year = e.year;
      items.push(item);
    }
    return { v: 1, kind, lang: input.lang, at, items };
  };
  return { movie: feed('movie'), series: feed('series') };
}
