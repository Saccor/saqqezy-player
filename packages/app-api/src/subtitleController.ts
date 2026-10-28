/**
 * Subtitles in the worker: files loaded from a link, a file or the source, automatic sync, and the online search
 * (languages, versions, downloads) with the exact-match file hash. Stream URLs carry credentials: never logged.
 */
import {
  SubtitleError, alignSubtitle, englishLanguageName, languageChoices, mergeHeaders, rankSubtitles,
  type AppSettings, type LoadedSubtitle, type OnlineSubtitle, type OpenSubtitlesClient, type SourceSubtitle, type StreamHeaders,
  type SubtitleInput, type SubtitleSearch, type SubtitleService, type SyncResult, type SyncSample, type SyncSetting,
} from '@iptv/core';
import type { OnlineSubtitleLanguage, SubtitleVersion } from './types.ts';
import type { VodController } from './vodController.ts';

/**
 * The subtitle search's page size, used only when an answer leaves out `total_pages`: a page this full may have a
 * next one. (OpenSubtitles REST v1 answers 50 per page by default.)
 */
export const SUBTITLE_SEARCH_PAGE_SIZE = 50;
/** How many files' movie hashes the session remembers (the least recently used dropped first). */
const MOVIE_HASH_CACHE_MAX = 50;
/** How many "Try another version" lists are kept for the session. */
const VERSION_LISTS_MAX = 30;
/** How long a failed movie-hash read is remembered before the file is asked again. */
export const MOVIE_HASH_RETRY_MS = 10 * 60_000;
/** A movie-hash read: the hash (undefined when it failed) and, once it failed, when. */
interface MovieHashEntry { hash: Promise<string | undefined>; failedAt?: number }

/** A source subtitle file's display name: its label, else its language, then where it comes from. */
export function sourceSubtitleName(sub: SourceSubtitle): string {
  const what = sub.label?.trim() || englishLanguageName(sub.language) || 'Subtitles';
  return `${what} (from source)`;
}

export interface SubtitleControllerDeps {
  /** Subtitles loaded from a link or a file. Without it, those methods reject with "Loading subtitles is not available." */
  subtitles?: SubtitleService;
  /** Subtitles found online for a title. Without it, "Find subtitles online" is not offered. */
  onlineSubtitles?: OpenSubtitlesClient;
  /** The OpenSubtitles hash of a VOD file (AppApiDeps.fileHash). */
  fileHash?: (url: string, headers?: StreamHeaders) => Promise<string | undefined>;
  now: () => number;
  /** The active source's id. */
  activeId: () => string | undefined;
  /** The active source's User-Agent and Referer settings. */
  sourceHeaders: () => StreamHeaders | undefined;
  /** The active Xtream account's connection limit, when known. */
  sourceMaxConnections: () => number | undefined;
  settings: () => Promise<AppSettings>;
  /** The VOD controller; throws "Movies and series are not available." without one (AppApi's `vodOrThrow`). */
  vod: () => VodController;
}

export class SubtitleController {
  /** Movie hashes read this session, per stream URL, least recently used first; cleared on a source switch. */
  private readonly movieHashes = new Map<string, MovieHashEntry>();
  /** "Try another version" lists per title, language and frame rate, least recently used first; cleared on a source switch. */
  private readonly versionLists = new Map<string, Promise<SubtitleVersion[]>>();

  constructor(private readonly deps: SubtitleControllerDeps) {}

  /** The active source is about to change: item ids and stream URLs belong to a source, its file hashes go with it. */
  reset(): void {
    this.movieHashes.clear();
    this.versionLists.clear();
  }

  /** See AppApi.loadSubtitle. */
  load(itemId: string, input: SubtitleInput): Promise<LoadedSubtitle> {
    const [svc, src] = this.subtitlesOrThrow();
    return svc.load(src, itemId, input);
  }

  /** See AppApi.loadSourceSubtitle. */
  loadSource(itemId: string, sub: SourceSubtitle): Promise<LoadedSubtitle> {
    const [svc, src] = this.subtitlesOrThrow();
    const name = sourceSubtitleName(sub);
    return svc.load(src, itemId, { url: sub.url }, sub.language ? { language: sub.language, name } : { name });
  }

  /** See AppApi.syncSubtitle. */
  async sync(itemId: string, sample: SyncSample, current: SyncSetting): Promise<SyncResult | undefined> {
    const subtitles = this.deps.subtitles;
    const activeId = this.deps.activeId();
    if (!subtitles || !activeId) return undefined;
    const loaded = await subtitles.get(activeId, itemId);
    return loaded ? alignSubtitle(loaded.cues, sample, current) : undefined;
  }

  /** The subtitles loaded earlier for a title, if any. */
  async get(itemId: string): Promise<LoadedSubtitle | undefined> {
    const subtitles = this.deps.subtitles;
    const activeId = this.deps.activeId();
    if (!subtitles || !activeId) return undefined;
    return subtitles.get(activeId, itemId);
  }

  clear(itemId: string): Promise<void> {
    const [svc, src] = this.subtitlesOrThrow();
    return svc.clear(src, itemId);
  }

  /** Whether "Find subtitles online" can be offered (an app key is configured). */
  onlineAvailable(): boolean {
    return this.deps.onlineSubtitles !== undefined && this.deps.subtitles !== undefined;
  }

  /** See AppApi.findSubtitlesOnline. */
  async findOnline(itemId: string, seriesId?: string, videoFps?: number): Promise<OnlineSubtitleLanguage[]> {
    const client = this.onlineOrThrow();
    const { query, preferred } = await this.subtitleQuery(itemId, seriesId);
    const found = await client.search(query);
    return languageChoices(found, preferred, videoFps).map((c) => ({
      language: c.language, count: c.count, fileId: c.best.fileId, files: c.files.map((f) => f.fileId), synced: c.synced,
      release: c.best.release, ...(c.best.fps ? { fps: c.best.fps } : {}), ...(c.cc ? { cc: true } : {}),
    }));
  }

  /** See AppApi.subtitleVersions. */
  async versions(itemId: string, language: string, seriesId?: string, videoFps?: number): Promise<SubtitleVersion[]> {
    this.onlineOrThrow();
    const lang = language.trim();
    if (!lang) return [];
    // Kept for the session (a reopen of the title asks nothing); a failed search is not kept. With exact match on,
    // the list belongs to the file playing (a picked version under the same id is another file) and to the setting.
    const exact = this.exactMatchOn(await this.deps.settings());
    const file = exact ? (await this.deps.vod().playable(itemId, seriesId))?.url ?? '' : '';
    const key = JSON.stringify([itemId, seriesId ?? '', lang, videoFps ?? 0, exact, file]);
    let list = this.versionLists.get(key);
    if (list) this.versionLists.delete(key); // Re-inserted below: the most recently used is last.
    else list = this.searchVersions(itemId, lang, seriesId, videoFps);
    this.versionLists.set(key, list);
    if (this.versionLists.size > VERSION_LISTS_MAX) {
      const leastRecent = this.versionLists.keys().next().value;
      if (leastRecent !== undefined) this.versionLists.delete(leastRecent);
    }
    const kept = list;
    return kept.catch((err: unknown) => {
      if (this.versionLists.get(key) === kept) this.versionLists.delete(key);
      throw err;
    });
  }

  /** The search behind `versions`: pages 1 and 2 at most. */
  private async searchVersions(itemId: string, lang: string, seriesId: string | undefined, videoFps: number | undefined): Promise<SubtitleVersion[]> {
    const client = this.onlineOrThrow();
    const { query } = await this.subtitleQuery(itemId, seriesId);
    query.languages = [lang];
    const first = await client.searchPage(query);
    const more = first.totalPages !== undefined ? first.totalPages > 1 : first.subtitles.length >= SUBTITLE_SEARCH_PAGE_SIZE;
    const all: OnlineSubtitle[] = [...first.subtitles];
    if (more) all.push(...(await client.searchPage({ ...query, page: 2 })).subtitles);
    const seen = new Set<number>();
    const unique = all.filter((s) => (seen.has(s.fileId) ? false : (seen.add(s.fileId), true)));
    return rankSubtitles(unique, videoFps).map((s) => ({
      fileId: s.fileId, release: s.release, ...(s.fps ? { fps: s.fps } : {}), synced: s.hashMatch, downloads: s.downloads,
      ...(s.hearingImpaired ? { hearingImpaired: true } : {}),
    }));
  }

  /**
   * Exact match reads 128 KB of the playing file: a second request while the title streams. An account limited to one
   * connection may refuse it (or count it against the user), so there it is never read, whatever the setting says.
   */
  private exactMatchOn(settings: AppSettings): boolean {
    return settings.subtitleExactMatch && this.deps.fileHash !== undefined && this.deps.sourceMaxConnections() !== 1;
  }

  /** The search for a title, with the stream file's hash when exact match is on (`movieHash`). */
  private async subtitleQuery(itemId: string, seriesId?: string): Promise<{ query: SubtitleSearch; preferred: string }> {
    const vod = this.deps.vod();
    const query = await vod.subtitleSearch(itemId, seriesId);
    if (!query) throw new SubtitleError("This title can't be found right now.");
    const settings = await this.deps.settings();
    // Exact match: the stream file's hash marks the versions timed for it (a failed read just leaves it out).
    if (this.exactMatchOn(settings)) {
      const playable = await vod.playable(itemId, seriesId);
      // As `getVodPlayable`: the playlist entry's headers win over the source's settings.
      const hash = playable?.url ? await this.movieHash(playable.url, mergeHeaders(this.deps.sourceHeaders(), playable.headers)) : undefined;
      if (hash) query.moviehash = hash;
    }
    return { query, preferred: settings.subtitleLanguage };
  }

  /**
   * The hash of the file at `url`, read once per file (keyed by its URL: a picked version under the same id is another
   * file). A failed read is kept for MOVIE_HASH_RETRY_MS so a refusing server is not asked again at every search.
   */
  private async movieHash(url: string, headers: StreamHeaders | undefined): Promise<string | undefined> {
    const fileHash = this.deps.fileHash;
    if (!fileHash) return undefined;
    let entry = this.movieHashes.get(url);
    if (entry) {
      this.movieHashes.delete(url); // Re-inserted below: the most recently used is last.
      if (entry.failedAt !== undefined && this.deps.now() - entry.failedAt >= MOVIE_HASH_RETRY_MS) entry = undefined;
    }
    if (!entry) {
      const fresh: MovieHashEntry = { hash: Promise.resolve(undefined) };
      fresh.hash = fileHash(url, headers).catch(() => undefined).then((h) => {
        if (!h) fresh.failedAt = this.deps.now();
        return h;
      });
      entry = fresh;
    }
    this.movieHashes.set(url, entry);
    if (this.movieHashes.size > MOVIE_HASH_CACHE_MAX) {
      const leastRecent = this.movieHashes.keys().next().value;
      if (leastRecent !== undefined) this.movieHashes.delete(leastRecent);
    }
    return entry.hash;
  }

  /** How much later (positive) or earlier the title's loaded subtitles show; kept with that file. */
  setDelay(itemId: string, delayMs: number): Promise<void> {
    const [svc, src] = this.subtitlesOrThrow();
    return svc.setDelay(src, itemId, delayMs);
  }

  /** How fast the title's loaded subtitles run against the video (a frame-rate fix); kept with that file. */
  setSpeed(itemId: string, speed: number): Promise<void> {
    const [svc, src] = this.subtitlesOrThrow();
    return svc.setSpeed(src, itemId, speed);
  }

  /** See AppApi.loadOnlineSubtitle. */
  async loadOnline(itemId: string, fileId: number, name: string, details?: { language?: string; fps?: number; cc?: boolean }): Promise<LoadedSubtitle> {
    const client = this.onlineOrThrow();
    const [svc, src] = this.subtitlesOrThrow();
    const file = await client.download(fileId);
    return svc.load(src, itemId, { bytes: file.bytes, name }, details && { ...details, fileId });
  }

  private onlineOrThrow(): OpenSubtitlesClient {
    if (!this.deps.onlineSubtitles) throw new Error('Online subtitles are not available.');
    return this.deps.onlineSubtitles;
  }

  private subtitlesOrThrow(): [SubtitleService, string] {
    const activeId = this.deps.activeId();
    if (!this.deps.subtitles) throw new Error('Loading subtitles is not available.');
    if (!activeId) throw new Error('Add a source first.');
    return [this.deps.subtitles, activeId];
  }
}
