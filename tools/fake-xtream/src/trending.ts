// A synthetic trending feed (spec 2026-10-20-trending-design §6) so the Start rows can be tried on localhost without
// the real Worker. Built from the fake catalogue's own titles with synthetic Wikidata ids; nothing real (rule 1).

/** Titles in the feeds that are not in the catalogue: they must never show on Start. */
export const ABSENT_MOVIE = 'Synthetic Absent Film';
export const ABSENT_SERIES = 'Synthetic Absent Series';
/** The series title the feed lists without a year (matched by its unambiguous name). */
export const UNDATED_SERIES = 4;

/** The fake list's tmdb id of a movie title (every third title has one), as `get_vod_streams` sends it. */
export const movieTmdb = (title: number): number | undefined => (title % 3 === 0 ? 900_000 + title : undefined);
/** The same for series (`get_series`). */
export const seriesTmdb = (title: number): number | undefined => (title % 3 === 0 ? 800_000 + title : undefined);

interface FeedItem { rank: number; wd: string; tmdb?: number; year?: number; titles: string[] }

const pad = (n: number, w: number) => String(n).padStart(w, '0');

/**
 * `/__trending/v1/<kind>.en.json` over `titles` catalogue titles (numbered from 1), in a scrambled order: every third
 * with its tmdb id and a Swedish-style alias (the id alone finds it), the rest by title and year, every fifth of those
 * a year off (±1 still matches); one series without a year. An absent title sits at rank 2.
 */
export function trendingFeed(kind: 'movie' | 'series', titles: number, now: number): unknown {
  const order = Array.from({ length: titles }, (_, i) => i + 1)
    .sort((a, b) => ((a * 37) % 101) - ((b * 37) % 101) || a - b)
    .slice(0, kind === 'movie' ? 24 : 8);
  const items: FeedItem[] = order.map((t, k) => {
    const name = kind === 'movie' ? `Synthetic Film ${pad(t, 3)}` : `Synthetic Series ${pad(t, 2)}`;
    const year = kind === 'movie' ? 2000 + (t % 25) : 2021;
    const tmdb = kind === 'movie' ? movieTmdb(t) : seriesTmdb(t);
    const alias = kind === 'movie' ? `Syntetisk film ${pad(t, 3)}` : `Syntetisk serie ${pad(t, 2)}`;
    const item: FeedItem = { rank: 0, wd: `Q${(kind === 'movie' ? 9_100_000 : 9_200_000) + t}`, titles: tmdb ? [alias, name] : [name] };
    if (tmdb) item.tmdb = tmdb;
    if (!(kind === 'series' && t === UNDATED_SERIES)) item.year = !tmdb && k % 5 === 4 ? year + 1 : year;
    return item;
  });
  items.splice(1, 0, { rank: 0, wd: kind === 'movie' ? 'Q9199999' : 'Q9299999', year: 2026, titles: [kind === 'movie' ? ABSENT_MOVIE : ABSENT_SERIES] });
  return { v: 1, kind, lang: 'en', at: new Date(now).toISOString(), items: items.map((it, i) => ({ ...it, rank: i + 1 })) };
}
