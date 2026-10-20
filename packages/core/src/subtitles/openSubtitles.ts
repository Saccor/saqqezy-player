import type { FetchFn } from '../types.ts';
import { SubtitleError } from './service.ts';

/**
 * What identifies one title: a movie's TMDB id, an episode's series TMDB id plus season and episode, or, without
 * ids, the cleaned title (with the year for movies, season and episode for episodes).
 */
export interface SubtitleSearch {
  tmdbId?: number;
  parentTmdbId?: number;
  season?: number;
  episode?: number;
  query?: string;
  year?: number;
  /** ISO 639-1 codes; left out: every language. */
  languages?: string[];
  /** The file's OpenSubtitles hash (`fetchMovieHash`): results then mark the files timed for this exact release. */
  moviehash?: string;
  /** 1-based result page; left out: the first. */
  page?: number;
}

/** One subtitle file found online. */
export interface OnlineSubtitle {
  fileId: number;
  /** As the service names it: ISO 639-1, sometimes with a region ("pt-BR"). */
  language: string;
  release: string;
  downloads: number;
  hearingImpaired: boolean;
  /** Machine or AI translated. */
  machineTranslated: boolean;
  trusted: boolean;
  /** Made for the exact file playing (its hash matched): timed for it. */
  hashMatch: boolean;
  /** The frame rate the file was timed for, when the service says (a positive number). */
  fps?: number;
}

/** One row of the language list: how many files, the one a click loads, and all of them best first. */
export interface LanguageChoice {
  language: string;
  count: number;
  best: OnlineSubtitle;
  files: OnlineSubtitle[];
  /** One of its files matches the file playing. */
  synced: boolean;
  /** The hearing-impaired (CC/SDH) row of its language. */
  cc?: boolean;
}

// "EN - ", "|SE| ", "[MULTI] ", "NL: " in front of provider titles. Upper case only, so "It: …" stays a title.
const LEADING_TAG = /^\s*(?:[[|(]\s*[A-Z]{2,5}\s*[\]|)]|[A-Z]{2,3}\s*[-:|])\s*/;
const QUALITY = /\s+(?:4k|uhd|fhd|hd|sd|hdr|hdr10|dv|\d{3,4}p|hevc|h\.?26[45]|x26[45]|multi(?:-?sub)?|vostfr|dual)\b.*$/i;
const YEAR = /\s*[([](\d{4})[)\]]/;

/** A provider's title as a search query: tags in front, quality words and the year out (the year is returned apart). */
export function searchTitle(name: string): { title: string; year?: number } {
  let s = name.replace(LEADING_TAG, '');
  let year: number | undefined;
  const y = YEAR.exec(s);
  if (y) {
    const n = Number(y[1]);
    if (n >= 1900 && n <= 2100) year = n;
    s = s.slice(0, y.index);
  }
  s = s.replace(QUALITY, '').replace(/\s+/g, ' ').trim();
  return year ? { title: s, year } : { title: s };
}

const enc = (v: string) => encodeURIComponent(v.toLowerCase()).replace(/%20/g, '+').replace(/%2C/gi, ',');

/** The search query string: keys sorted and values lower-case, as the service asks (it redirects otherwise). */
export function searchParams(q: SubtitleSearch): string {
  const p: Record<string, string> = {};
  if (q.tmdbId) {
    p.tmdb_id = String(q.tmdbId);
  } else if (q.parentTmdbId) {
    p.parent_tmdb_id = String(q.parentTmdbId);
  } else if (q.query) {
    p.query = q.query;
    if (q.year && q.season === undefined) p.year = String(q.year);
  }
  if (!q.tmdbId && q.season !== undefined && q.episode !== undefined) {
    p.season_number = String(q.season);
    p.episode_number = String(q.episode);
  }
  if (q.languages?.length) p.languages = [...q.languages].sort().join(',');
  if (q.moviehash) p.moviehash = q.moviehash;
  const pg = Math.floor(q.page ?? 1);
  if (pg > 1) p.page = String(pg);
  return Object.keys(p).sort().map((k) => `${k}=${enc(p[k] ?? '')}`).join('&');
}

/** 0: the frame rate of the video; 1: unknown; 2: another one. Without a video frame rate: all 0. */
function fpsRank(s: OnlineSubtitle, videoFps: number | undefined): number {
  if (!videoFps || videoFps <= 0) return 0;
  if (!s.fps) return 1;
  return Math.abs(s.fps - videoFps) <= 0.05 ? 0 : 2;
}

const score = (s: OnlineSubtitle, videoFps?: number) => [
  s.hashMatch ? 0 : 1, fpsRank(s, videoFps), s.trusted ? 0 : 1, s.machineTranslated ? 1 : 0, s.hearingImpaired ? 1 : 0, -s.downloads,
];

/**
 * Files best first: a match for the exact file playing, then (when the video's frame rate is known) files timed for
 * that rate, then trusted uploaders, then human translations, then not hearing-impaired, then most downloaded.
 */
export function rankSubtitles(list: readonly OnlineSubtitle[], videoFps?: number): OnlineSubtitle[] {
  return [...list].sort((a, b) => {
    const x = score(a, videoFps);
    const y = score(b, videoFps);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  });
}

/** The file a click loads (`rankSubtitles`' first). */
export function bestSubtitle(list: readonly OnlineSubtitle[]): OnlineSubtitle | undefined {
  return rankSubtitles(list)[0];
}

const base = (code: string) => code.toLowerCase().split(/[-_]/)[0] ?? '';

/**
 * The language list: one row per language, plus a CC row (hearing-impaired files only) for a language that has both
 * kinds; a language with only hearing-impaired files has one row, marked CC. Each row's files are its own kind, best
 * first. Order: the preferred language (ISO 639-1, 'off': none), then English, then the most files, then by code; a
 * CC row right after its language's regular row.
 */
export function languageChoices(list: readonly OnlineSubtitle[], preferred: string, videoFps?: number): LanguageChoice[] {
  const groups = new Map<string, OnlineSubtitle[]>();
  for (const s of list) {
    const g = groups.get(s.language);
    if (g) g.push(s);
    else groups.set(s.language, [s]);
  }
  const rows: LanguageChoice[] = [];
  const total = new Map<string, number>();
  for (const [language, group] of groups) {
    total.set(language, group.length);
    const regular = group.filter((s) => !s.hearingImpaired);
    const cc = group.filter((s) => s.hearingImpaired);
    for (const [kind, isCc] of [[regular, false], [cc, true]] as const) {
      const files = rankSubtitles(kind, videoFps);
      const best = files[0];
      if (!best) continue;
      const row: LanguageChoice = { language, count: files.length, best, files, synced: best.hashMatch };
      if (isCc) row.cc = true;
      rows.push(row);
    }
  }
  const rank = (c: LanguageChoice) => (preferred !== 'off' && base(c.language) === preferred ? 0 : base(c.language) === 'en' ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b)
    || (total.get(b.language) ?? 0) - (total.get(a.language) ?? 0)
    || a.language.localeCompare(b.language)
    || Number(a.cc ?? false) - Number(b.cc ?? false));
}

export interface OpenSubtitlesDeps {
  /** For the API itself (search, download link): a direct fetch (the service answers CORS with `*`). */
  apiFetch: FetchFn;
  /** For the subtitle file behind the download link (the app's fetch). */
  fileFetch: FetchFn;
  /** The app's key (one per app; the service bans apps that make users create keys). */
  apiKey: string;
  baseUrl?: string;
  /** "AppName v1.0": the service requires it; browsers cannot set User-Agent, so it goes in X-User-Agent. */
  appName: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const UNREACHABLE = "Couldn't reach the subtitle service.";

function statusError(status: number): SubtitleError {
  if (status === 401 || status === 403) return new SubtitleError('Online subtitles are not set up correctly.');
  if (status === 406) return new SubtitleError('Daily subtitle download limit reached. Try again tomorrow.');
  if (status === 429) return new SubtitleError('The subtitle service is busy. Try again in a moment.');
  return new SubtitleError(`The subtitle service answered with an error (${status}).`);
}

/**
 * OpenSubtitles.com REST v1, called from the device (never through our servers). Search is free; downloads count
 * against the caller's daily quota.
 */
export class OpenSubtitlesClient {
  private readonly deps: OpenSubtitlesDeps;
  private readonly baseUrl: string;

  constructor(deps: OpenSubtitlesDeps) {
    this.deps = deps;
    this.baseUrl = (deps.baseUrl ?? 'https://api.opensubtitles.com/api/v1').replace(/\/+$/, '');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'Api-Key': this.deps.apiKey, 'X-User-Agent': this.deps.appName, Accept: 'application/json', ...extra };
  }

  private async call(path: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await this.deps.apiFetch(`${this.baseUrl}${path}`, init);
    } catch {
      throw new SubtitleError(UNREACHABLE);
    }
    if (!res.ok) throw statusError(res.status);
    try {
      return await res.json();
    } catch {
      throw new SubtitleError(UNREACHABLE);
    }
  }

  async search(q: SubtitleSearch): Promise<OnlineSubtitle[]> {
    return (await this.searchPage(q)).subtitles;
  }

  /** One page of results plus the page count the service reports (`total_pages`; undefined when it does not say). */
  async searchPage(q: SubtitleSearch): Promise<{ subtitles: OnlineSubtitle[]; totalPages?: number }> {
    const body = await this.call(`/subtitles?${searchParams(q)}`, { method: 'GET', headers: this.headers() });
    const data = isObj(body) && Array.isArray(body.data) ? body.data : [];
    const pages = isObj(body) && typeof body.total_pages === 'number' && Number.isFinite(body.total_pages) ? body.total_pages : undefined;
    const out: OnlineSubtitle[] = [];
    for (const d of data) {
      const a = isObj(d) && isObj(d.attributes) ? d.attributes : undefined;
      const file = a && Array.isArray(a.files) && isObj(a.files[0]) ? a.files[0] : undefined;
      const fileId = file && typeof file.file_id === 'number' ? file.file_id : undefined;
      const language = a && typeof a.language === 'string' ? a.language : '';
      if (!a || fileId === undefined || !language) continue;
      const fps = typeof a.fps === 'number' && Number.isFinite(a.fps) && a.fps > 0 ? a.fps : undefined;
      out.push({
        fileId,
        language,
        release: typeof a.release === 'string' ? a.release : '',
        downloads: typeof a.download_count === 'number' ? a.download_count : 0,
        hearingImpaired: a.hearing_impaired === true,
        machineTranslated: a.machine_translated === true || a.ai_translated === true,
        trusted: a.from_trusted === true,
        hashMatch: a.moviehash_match === true,
        ...(fps ? { fps } : {}),
      });
    }
    return pages === undefined ? { subtitles: out } : { subtitles: out, totalPages: pages };
  }

  /** The file's bytes and name. Counts against the daily download quota. */
  async download(fileId: number): Promise<{ bytes: Uint8Array; name: string }> {
    const body = await this.call('/download', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ file_id: fileId }),
    });
    const link = isObj(body) && typeof body.link === 'string' ? body.link : undefined;
    if (!link) throw new SubtitleError(UNREACHABLE);
    let res: Response;
    try {
      res = await this.deps.fileFetch(link);
    } catch {
      throw new SubtitleError("Couldn't download the subtitles. Try again.");
    }
    if (!res.ok) throw new SubtitleError(`Couldn't download the subtitles (error ${res.status}).`);
    const name = isObj(body) && typeof body.file_name === 'string' && body.file_name ? body.file_name : `subtitles-${fileId}.srt`;
    return { bytes: new Uint8Array(await res.arrayBuffer()), name };
  }
}
