// Pure helpers over Wikimedia, Wikidata and TMDB answers (spec §2). No network here.
import type { FeedKind } from './feed.ts';

/** What the feed keeps of an entity. `null` in caches: not a film or series. */
export interface EntitySummary {
  wd: string;
  kind: FeedKind;
  tmdb?: number;
  imdb?: string;
  year?: number;
  /** Earliest release (or start) date, epoch ms. */
  date?: number;
  titles: string[];
}

/** One day's top articles as [article (underscores), views]. */
export type DayTop = [string, number][];

/** "instance of" (P31) values that make an entity a film or a series, in priority order. */
const TYPE_KINDS: readonly (readonly [string, FeedKind])[] = [
  ['Q11424', 'movie'], // film
  ['Q24869', 'movie'], // feature film
  ['Q202866', 'movie'], // animated film
  ['Q93204', 'movie'], // documentary film
  ['Q506240', 'movie'], // television film
  ['Q20650540', 'movie'], // anime film
  ['Q229390', 'movie'], // 3D film
  ['Q5398426', 'series'], // television series
  ['Q581714', 'series'], // animated television series
  ['Q1259759', 'series'], // miniseries
  ['Q526877', 'series'], // web series
  ['Q63952888', 'series'], // anime television series
];

/** Titles per feed item. */
const TITLES_MAX = 8;

/** Main pages outside a namespace (namespaced ones are dropped by `isNamespaced`), and the "-" pseudo-article. */
const MAIN_PAGES = new Set([
  'Main_Page', 'Pagina_principale', 'Hoofdpagina', 'Anasayfa', 'Forside', 'Etusivu', 'Página_principal',
  'الصفحة_الرئيسية', // ar
  'صفحهٔ_اصلی', // fa
  '-',
]);
const NAMESPACED = /^[^\s_:]+:(?![\s_])/;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export const articleKey = (article: string): string => article.replace(/_/g, ' ');

/** "Special:Search", "Portal:Huvudsida": yes. "Dune:_Part_Two" (a title with a colon): no. */
export function isNamespaced(article: string): boolean {
  return NAMESPACED.test(article);
}

/** A Wikimedia "top articles" answer as compact pairs. */
export function compactTop(answer: unknown): DayTop {
  const items = isObj(answer) ? answer.items : undefined;
  const first: unknown = Array.isArray(items) ? items[0] : undefined;
  const articles = isObj(first) ? first.articles : undefined;
  if (!Array.isArray(articles)) return [];
  const out: DayTop = [];
  for (const a of articles) {
    if (isObj(a) && typeof a.article === 'string' && typeof a.views === 'number' && a.views > 0) out.push([a.article, a.views]);
  }
  return out;
}

/** Articles by summed views over the days, without namespaces and main pages; at most `max`, keyed with spaces. */
export function candidateArticles(days: readonly DayTop[], max: number): { article: string; views: number }[] {
  const sum = new Map<string, number>();
  for (const day of days) {
    for (const [article, views] of day) {
      if (MAIN_PAGES.has(article) || isNamespaced(article)) continue;
      const key = articleKey(article);
      sum.set(key, (sum.get(key) ?? 0) + views);
    }
  }
  return [...sum].map(([article, views]) => ({ article, views }))
    .sort((a, b) => b.views - a.views || (a.article < b.article ? -1 : 1))
    .slice(0, Math.max(0, max));
}

/** The values of a property's usable statements (value snaks, not deprecated). */
function values(claims: Json, prop: string): unknown[] {
  const list = claims[prop];
  if (!Array.isArray(list)) return [];
  const out: unknown[] = [];
  for (const c of list) {
    if (!isObj(c) || c.rank === 'deprecated' || !isObj(c.mainsnak)) continue;
    const snak = c.mainsnak;
    if (snak.snaktype !== 'value' || !isObj(snak.datavalue)) continue;
    out.push(snak.datavalue.value);
  }
  return out;
}

function firstString(claims: Json, prop: string): string | undefined {
  return values(claims, prop).find((v): v is string => typeof v === 'string' && v.length > 0);
}

/** "+2021-09-15T00:00:00Z" (month and day may be 00) → epoch ms. */
function wikidataTime(v: unknown): number | undefined {
  if (!isObj(v) || typeof v.time !== 'string') return undefined;
  const m = /^\+(\d{4})-(\d{2})-(\d{2})/.exec(v.time);
  if (!m) return undefined;
  const y = Number(m[1]);
  if (y < 1870 || y > 2100) return undefined;
  return Date.UTC(y, Math.max(1, Number(m[2])) - 1, Math.max(1, Number(m[3])));
}

function earliest(claims: Json, prop: string): number | undefined {
  let best: number | undefined;
  for (const v of values(claims, prop)) {
    const t = wikidataTime(v);
    if (t !== undefined && (best === undefined || t < best)) best = t;
  }
  return best;
}

function label(map: unknown, lang: string): string | undefined {
  const l = isObj(map) ? map[lang] : undefined;
  return isObj(l) && typeof l.value === 'string' && l.value.trim() ? l.value.trim() : undefined;
}

/** A film or series entity as the feed needs it; null for anything else. */
export function summarizeEntity(entity: unknown, lang: string): EntitySummary | null {
  if (!isObj(entity) || typeof entity.id !== 'string' || !isObj(entity.claims)) return null;
  const claims = entity.claims;
  const types = new Set(values(claims, 'P31').map((v) => (isObj(v) && typeof v.id === 'string' ? v.id : '')));
  const kind = TYPE_KINDS.find(([q]) => types.has(q))?.[1];
  if (!kind) return null;

  const titles: string[] = [];
  const seen = new Set<string>();
  const add = (t: string | undefined) => {
    if (!t || titles.length >= TITLES_MAX) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    titles.push(t);
  };
  add(label(entity.labels, lang));
  add(label(entity.labels, 'en'));
  const aliases = isObj(entity.aliases) ? entity.aliases[lang] : undefined;
  if (Array.isArray(aliases)) for (const a of aliases) if (isObj(a) && typeof a.value === 'string') add(a.value.trim());
  if (!titles.length) return null;

  const out: EntitySummary = { wd: entity.id, kind, titles };
  const tmdb = Number(firstString(claims, kind === 'movie' ? 'P4947' : 'P4983'));
  if (Number.isInteger(tmdb) && tmdb > 0) out.tmdb = tmdb;
  const imdb = firstString(claims, 'P345');
  if (imdb && /^tt\d+$/.test(imdb)) out.imdb = imdb;
  const date = earliest(claims, 'P577') ?? (kind === 'series' ? earliest(claims, 'P580') : undefined);
  if (date !== undefined) {
    out.date = date;
    out.year = new Date(date).getUTCFullYear();
  }
  return out;
}

/**
 * A `wbgetentities` answer for `asked` articles (spaces) of `{lang}wiki`: each article → its summary, or null when
 * it is missing or not a title. A malformed answer gives {} (nothing is cached; the articles are asked again).
 */
export function summarizeBatch(answer: unknown, lang: string, asked: readonly string[]): Record<string, EntitySummary | null> {
  const ents = isObj(answer) ? answer.entities : undefined;
  if (!isObj(ents)) return {};
  const site = `${lang}wiki`;
  const wanted = new Set(asked);
  const out: Record<string, EntitySummary | null> = {};
  for (const e of Object.values(ents)) {
    if (!isObj(e)) continue;
    const link = isObj(e.sitelinks) ? e.sitelinks[site] : undefined;
    const title = isObj(link) && typeof link.title === 'string' ? link.title : typeof e.title === 'string' ? e.title : undefined;
    if (title && wanted.has(articleKey(title))) out[articleKey(title)] = summarizeEntity(e, lang);
  }
  // Normalised or redirected titles come back under another name: the asked one is then not a title here.
  for (const a of asked) if (!(a in out)) out[a] = null;
  return out;
}

/** TMDB `/trending/{movie,tv}/week` result ids, in order. */
export function parseTmdbTrending(answer: unknown): number[] {
  const results = isObj(answer) ? answer.results : undefined;
  if (!Array.isArray(results)) return [];
  const out: number[] = [];
  for (const r of results) {
    if (isObj(r) && typeof r.id === 'number' && Number.isInteger(r.id) && r.id > 0) out.push(r.id);
  }
  return out;
}
