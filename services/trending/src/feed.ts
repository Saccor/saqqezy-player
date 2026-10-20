/** The public trending feed, format v1 (spec §1). The device has its own copy of these types in @iptv/core. */
export type FeedKind = 'movie' | 'series';

export interface TrendingFeedItem {
  /** 1-based, best first. */
  rank: number;
  /** Wikidata id ("Q123"). */
  wd: string;
  /** The Movie Database id: P4947 (film) or P4983 (series). */
  tmdb?: number;
  /** IMDb id (P345), "tt123". */
  imdb?: string;
  /** Earliest release year (P577; P580 for series without one). */
  year?: number;
  /** Label in the feed's language, English label, then aliases in the feed's language. */
  titles: string[];
}

export interface TrendingFeed {
  v: 1;
  kind: FeedKind;
  lang: string;
  /** Build time, ISO 8601. */
  at: string;
  items: TrendingFeedItem[];
}

/** Feed items per kind and language. */
export const FEED_MAX = 150;

/** R2 key (and URL path without the leading slash) of a feed file. */
export const feedKey = (kind: FeedKind, lang: string): string => `trending/v1/${kind}.${lang}.json`;
