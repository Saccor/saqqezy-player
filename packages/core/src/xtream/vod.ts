import { seasonsOf } from '../vod/list.ts';
import { parseEpisodeMarker, splitYear } from '../vod/title.ts';
import {
  VOD_UNCATEGORIZED,
  type Episode, type MovieDetail, type SeriesDetail, type VodCategory, type VodItem, type VodKind,
} from '../vod/types.ts';
import { isObj, posInt, str } from './json.ts';

const num = (v: unknown): number | undefined => {
  const n = Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : undefined;
};

/** 0 or missing means "no rating"; clamped to 10, one decimal. */
function rating(v: unknown): number | undefined {
  const n = num(v);
  if (n === undefined || n <= 0) return undefined;
  return Math.round(Math.min(10, n) * 10) / 10;
}

/** The first value that starts with a plausible 4-digit year. */
function yearOf(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    const m = /^(\d{4})/.exec(String(v ?? '').trim());
    if (!m) continue;
    const y = Number(m[1]);
    if (y >= 1900 && y <= 2100) return y;
  }
  return undefined;
}

function runtimeMin(info: Record<string, unknown>): number | undefined {
  const secs = posInt(info.duration_secs);
  if (secs) return Math.max(1, Math.round(secs / 60));
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(str(info.duration) ?? '');
  if (!m) return undefined;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins > 0 ? mins : undefined;
}

function firstUrl(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = str(x);
      if (s) return s;
    }
    return undefined;
  }
  return str(v);
}

export function parseVodCategories(data: unknown, kind: VodKind): VodCategory[] {
  if (!Array.isArray(data)) return [];
  const out: VodCategory[] = [];
  const seen = new Set<string>();
  for (const c of data) {
    if (!isObj(c)) continue;
    const id = str(c.category_id);
    const name = str(c.category_name);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, kind, name, count: 0 });
  }
  return out;
}

function baseItem(s: Record<string, unknown>, kind: VodKind, sourceId: string, xid: number, rawName: string, prefix: 'm' | 's'): VodItem {
  const { title, year: nameYear } = splitYear(rawName);
  const item: VodItem = { id: `${sourceId}:${prefix}${xid}`, kind, title, categoryId: str(s.category_id) ?? VOD_UNCATEGORIZED, xid };
  const year = yearOf(s.year, s.releaseDate, s.release_date) ?? nameYear;
  if (year) item.year = year;
  return item;
}

export function parseVodStreams(data: unknown, sourceId: string): VodItem[] {
  if (!Array.isArray(data)) return [];
  const out: VodItem[] = [];
  for (const s of data) {
    if (!isObj(s)) continue;
    const xid = posInt(s.stream_id);
    const name = str(s.name);
    if (!xid || !name) continue;
    const item = baseItem(s, 'movie', sourceId, xid, name, 'm');
    const poster = str(s.stream_icon);
    if (poster) item.poster = poster;
    const r = rating(s.rating);
    if (r !== undefined) item.rating = r;
    const added = posInt(s.added);
    if (added) item.added = added;
    const ext = str(s.container_extension);
    if (ext) item.ext = ext;
    out.push(item);
  }
  return out;
}

export function parseSeriesList(data: unknown, sourceId: string): VodItem[] {
  if (!Array.isArray(data)) return [];
  const out: VodItem[] = [];
  for (const s of data) {
    if (!isObj(s)) continue;
    const xid = posInt(s.series_id);
    const name = str(s.name);
    if (!xid || !name) continue;
    const item = baseItem(s, 'series', sourceId, xid, name, 's');
    const poster = str(s.cover);
    if (poster) item.poster = poster;
    const r = rating(s.rating);
    if (r !== undefined) item.rating = r;
    const added = posInt(s.last_modified);
    if (added) item.added = added;
    out.push(item);
  }
  return out;
}

function detailFields(info: Record<string, unknown>): MovieDetail {
  const d: MovieDetail = {};
  const plot = str(info.plot) ?? str(info.description);
  if (plot) d.plot = plot;
  const genre = str(info.genre);
  if (genre) d.genre = genre;
  const director = str(info.director);
  if (director) d.director = director;
  const cast = str(info.cast) ?? str(info.actors);
  if (cast) d.cast = cast;
  const age = str(info.mpaa_rating) ?? str(info.age);
  if (age) d.ageRating = age;
  const backdrop = firstUrl(info.backdrop_path);
  if (backdrop) d.backdrop = backdrop;
  return d;
}

export function parseVodInfo(data: unknown): MovieDetail {
  const info = isObj(data) && isObj(data.info) ? data.info : {};
  const d = detailFields(info);
  const rt = runtimeMin(info);
  if (rt) d.runtimeMin = rt;
  return d;
}

export function parseSeriesInfo(data: unknown, sourceId: string): SeriesDetail {
  const root = isObj(data) ? data : {};
  const info = isObj(root.info) ? root.info : {};
  const names = new Map<number, string>();
  if (Array.isArray(root.seasons)) {
    for (const s of root.seasons) {
      if (!isObj(s)) continue;
      const n = posInt(s.season_number);
      const name = str(s.name);
      if (n && name) names.set(n, name);
    }
  }
  const groups: { key?: number; list: unknown[] }[] = [];
  if (isObj(root.episodes)) {
    for (const [k, v] of Object.entries(root.episodes)) if (Array.isArray(v)) groups.push({ key: posInt(k), list: v });
  } else if (Array.isArray(root.episodes)) {
    for (const v of root.episodes) if (Array.isArray(v)) groups.push({ list: v });
  }
  const episodes: Episode[] = [];
  for (const g of groups) {
    g.list.forEach((e, i) => {
      if (!isObj(e)) return;
      const xid = posInt(e.id);
      if (!xid) return;
      const season = posInt(e.season) ?? g.key ?? 1;
      const episode = posInt(e.episode_num) ?? i + 1;
      const raw = str(e.title);
      // "Show - S01E02 - Title" → "Title"; a name without a marker stays as it is.
      const title = (raw && parseEpisodeMarker(raw)?.title) ?? raw ?? `Episode ${episode}`;
      const ep: Episode = { id: `${sourceId}:e${xid}`, season, episode, title, xid };
      const ei = isObj(e.info) ? e.info : {};
      const plot = str(ei.plot);
      if (plot) ep.plot = plot;
      const rt = runtimeMin(ei);
      if (rt) ep.runtimeMin = rt;
      const still = str(ei.movie_image);
      if (still) ep.still = still;
      const ext = str(e.container_extension);
      if (ext) ep.ext = ext;
      episodes.push(ep);
    });
  }
  return { ...detailFields(info), seasons: seasonsOf(episodes, names) };
}
