import type { StreamHeaders } from '../types.ts';

export type VodKind = 'movie' | 'series';
export type VodSort = 'added' | 'title' | 'rating';

/** Category id for items whose category is missing or unknown. */
export const VOD_UNCATEGORIZED = 'uncategorized';
/** Pseudo-category for every item of a kind. */
export const VOD_ALL = 'all';
/** Most items kept per kind and source (protects 1 GB-RAM TVs). */
export const VOD_CAP = 200_000;

/** One row of a catalogue list. Kept compact: 60k of these stay resident in the worker. */
export interface VodItem {
  /** Xtream: `${sourceId}:m${streamId}` / `${sourceId}:s${seriesId}`. M3U: `${sourceId}:v<hash>` / `${sourceId}:s<hash>`. */
  id: string;
  kind: VodKind;
  title: string;
  categoryId: string;
  /** Xtream stream id (movies) or series id. */
  xid?: number;
  poster?: string;
  year?: number;
  /** 0–10, one decimal. */
  rating?: number;
  /** Epoch seconds, for "Recently added". */
  added?: number;
  /** Movies: container extension (Xtream). */
  ext?: string;
  /** M3U movies: the entry URL. */
  url?: string;
  /** M3U movies: request headers from the playlist entry. */
  headers?: StreamHeaders;
}

export interface VodCategory { id: string; kind: VodKind; name: string; count: number }

export interface Episode {
  /** Xtream: `${sourceId}:e${episodeId}`. M3U: `${sourceId}:e<hash>`. */
  id: string;
  season: number;
  episode: number;
  title: string;
  xid?: number;
  plot?: string;
  runtimeMin?: number;
  still?: string;
  ext?: string;
  url?: string;
  /** M3U episodes: request headers from the playlist entry. */
  headers?: StreamHeaders;
}

export interface Season { number: number; name: string; episodes: Episode[] }

/** A stored catalogue for one source and kind. */
export interface VodList {
  items: VodItem[];
  categories: VodCategory[];
  /** M3U series only: episodes per series id (Xtream loads them on demand). */
  episodes?: Record<string, Episode[]>;
  /** Set when the fetch stopped at `VOD_CAP`. */
  truncated?: boolean;
}

export interface MovieDetail {
  plot?: string;
  runtimeMin?: number;
  genre?: string;
  director?: string;
  cast?: string;
  ageRating?: string;
  backdrop?: string;
}

export interface SeriesDetail extends Omit<MovieDetail, 'runtimeMin'> {
  seasons: Season[];
}

/** Where an episode sits in its series, stored with the episode's progress so Continue watching needs no fetch. */
export interface SeriesPointer {
  /** The series item id. */
  id: string;
  season: number;
  episode: number;
  /** The episode after this one, when known at save time. */
  next?: { id: string; season: number; episode: number };
}

/** Per source and item (movie, series or episode id). Local only. */
export interface VodUserState {
  position: number;
  duration: number;
  watched: boolean;
  favourite: boolean;
  /** Time of the last progress or watched change (not favourite changes). Orders Continue watching. */
  updatedAt: number;
  audio?: string;
  subtitle?: string;
  /** Episodes only. */
  series?: SeriesPointer;
}

export interface VodUserRecord { itemId: string; state: VodUserState }
