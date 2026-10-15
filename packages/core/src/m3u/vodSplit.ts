import { UNCATEGORIZED } from '../constants.ts';
import { fnv1a } from '../hash.ts';
import { searchKey } from '../text/searchKey.ts';
import { buildVodList } from '../vod/list.ts';
import { parseEpisodeMarker, splitYear } from '../vod/title.ts';
import type { Episode, VodCategory, VodItem, VodKind, VodList } from '../vod/types.ts';
import type { M3uEntry } from './parse.ts';
import { uniqueId } from './toChannels.ts';

export type EntryKind = 'live' | 'movie' | 'episode';

/** Xtream-style stream paths: a first segment of `movie` or `series` (the same layout `errors.ts` recognises). */
export function classifyEntry(url: string): EntryKind {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return 'live';
  }
  const first = path.split('/')[1]?.toLowerCase();
  if (first === 'movie') return 'movie';
  if (first === 'series') return 'episode';
  return 'live';
}

class Categories {
  private readonly list: VodCategory[] = [];
  private readonly seen = new Set<string>();
  constructor(private readonly kind: VodKind) {}
  note(group: string): string {
    const id = `g:${group}`;
    if (!this.seen.has(id)) {
      this.seen.add(id);
      this.list.push({ id, kind: this.kind, name: group, count: 0 });
    }
    return id;
  }
  all(): VodCategory[] {
    return this.list;
  }
}

/**
 * Splits parsed playlist entries into live entries (unchanged, in order), movies and series. Movie and episode
 * entries are de-duplicated by URL. Episodes are grouped into series by the show name with its episode marker
 * removed (case- and accent-insensitive); an entry without a marker is episode N of season 1 of its own name.
 */
export function splitM3uVod(sourceId: string, entries: M3uEntry[]): { live: M3uEntry[]; movies: VodList; series: VodList } {
  const live: M3uEntry[] = [];
  const movies: VodItem[] = [];
  const movieCats = new Categories('movie');
  const seriesCats = new Categories('series');
  const usedIds = new Set<string>();
  const seenUrls = new Set<string>();
  const shows = new Map<string, { item: VodItem; eps: { ep: Episode; order: number }[] }>();
  let order = 0;

  for (const e of entries) {
    const kind = classifyEntry(e.url);
    if (kind === 'live') {
      live.push(e);
      continue;
    }
    if (seenUrls.has(e.url)) continue;
    seenUrls.add(e.url);
    const group = e.groupTitle ?? UNCATEGORIZED;

    if (kind === 'movie') {
      const { title, year } = splitYear(e.name);
      const item: VodItem = { id: uniqueId(`${sourceId}:v${fnv1a(e.url)}`, usedIds), kind: 'movie', title, categoryId: movieCats.note(group), url: e.url };
      if (year) item.year = year;
      if (e.tvgLogo) item.poster = e.tvgLogo;
      movies.push(item);
      continue;
    }

    const marker = parseEpisodeMarker(e.name);
    const { title: showTitle, year } = splitYear(marker?.show ?? e.name);
    const key = searchKey(showTitle);
    let show = shows.get(key);
    if (!show) {
      const item: VodItem = { id: uniqueId(`${sourceId}:s${fnv1a(key)}`, usedIds), kind: 'series', title: showTitle, categoryId: seriesCats.note(group) };
      if (year) item.year = year;
      show = { item, eps: [] };
      shows.set(key, show);
    }
    const ep: Episode = {
      id: uniqueId(`${sourceId}:e${fnv1a(e.url)}`, usedIds),
      season: marker?.season ?? 1,
      episode: marker?.episode ?? show.eps.length + 1,
      title: marker?.title ?? e.name,
      url: e.url,
    };
    if (e.tvgLogo) {
      ep.still = e.tvgLogo;
      show.item.poster ??= e.tvgLogo;
    }
    show.eps.push({ ep, order: order++ });
  }

  const episodes: Record<string, Episode[]> = {};
  for (const { item, eps } of shows.values()) {
    episodes[item.id] = eps
      .sort((a, b) => a.ep.season - b.ep.season || a.ep.episode - b.ep.episode || a.order - b.order)
      .map(({ ep }) => ep);
  }
  return {
    live,
    movies: buildVodList('movie', movies, movieCats.all()),
    series: buildVodList('series', [...shows.values()].map((s) => s.item), seriesCats.all(), { episodes }),
  };
}
