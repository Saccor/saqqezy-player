import { SourceAuthError, SourceRefusedError } from '../errors.ts';
import type { XtreamClient } from '../xtream/client.ts';
import { buildVodList } from './list.ts';
import {
  VOD_CAP, VOD_FALLBACK_GAP_MS, VOD_FALLBACK_MAX_FAILS, VOD_SNAPSHOT_MS,
  type VodCategory, type VodItem, type VodKind, type VodList,
} from './types.ts';

export interface XtreamVodApi {
  categories(signal?: AbortSignal): Promise<VodCategory[]>;
  /** One category (the fallback). */
  list(categoryId?: string, signal?: AbortSignal): Promise<VodItem[]>;
  /** The whole list in one streamed request, in batches. */
  all(signal?: AbortSignal): AsyncIterable<VodItem[]>;
}

export function xtreamVodApi(client: XtreamClient, sourceId: string, kind: VodKind): XtreamVodApi {
  return kind === 'movie'
    ? { categories: (s) => client.vodCategories(s), list: (c, s) => client.vodStreams(sourceId, c, s), all: (s) => client.vodStreamBatches(sourceId, s) }
    : { categories: (s) => client.seriesCategories(s), list: (c, s) => client.seriesList(sourceId, c, s), all: (s) => client.seriesBatches(sourceId, s) };
}

/** The fetch was cancelled (source switched or removed). Nothing was stored. */
export class VodFetchCancelled extends Error {
  constructor() {
    super('The catalogue fetch was cancelled.');
    this.name = 'VodFetchCancelled';
  }
}

export interface FetchCatalogOptions {
  cap?: number;
  signal?: AbortSignal;
  /** The running item count, after each batch or category. */
  onProgress?: (count: number) => void;
  /** The list so far (a copy, never stored): after the first batch, then at most once per `snapshotMs`. */
  onSnapshot?: (list: VodList) => void;
  snapshotMs?: number;
  /** Fallback pacing: request starts at least `gap` ms apart. */
  gap?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Errors that mean "stop asking": the source refuses us or the login is wrong. */
const stopsAsking = (e: unknown) => e instanceof SourceRefusedError || e instanceof SourceAuthError;

/**
 * Fetches a whole catalogue: the category list, then every title in **one streamed request** (no `category_id`),
 * parsed batch by batch. Only when that request fails (not a refusal, login error or cancel), or answers empty while
 * categories exist, does it fall back to one category at a time, paced `gap` apart and never in parallel. A category
 * that fails there is skipped (`partial`); a refusal, or `VOD_FALLBACK_MAX_FAILS` failures in a row, ends it (the
 * titles so far are the partial result; with none, the error is thrown). Titles are de-duplicated by id and cut at
 * `cap` (`truncated` only when one was dropped).
 */
export async function fetchXtreamCatalog(api: XtreamVodApi, kind: VodKind, opts: FetchCatalogOptions = {}): Promise<VodList> {
  const cap = opts.cap ?? VOD_CAP;
  const signal = opts.signal;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gap = opts.gap ?? VOD_FALLBACK_GAP_MS;
  const snapshotMs = opts.snapshotMs ?? VOD_SNAPSHOT_MS;
  const check = () => {
    if (signal?.aborted) throw new VodFetchCancelled();
  };
  // A request that fails after the caller aborted is a cancel, not a network error.
  const guard = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      check();
      throw e;
    }
  };

  const categories = await guard(api.categories(signal));
  check();

  const items: VodItem[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let partial = false;
  let lastSnapshot: number | undefined;
  const add = (list: VodItem[]) => {
    for (const it of list) {
      if (seen.has(it.id)) continue;
      if (items.length >= cap) {
        truncated = true;
        return;
      }
      seen.add(it.id);
      items.push(it);
    }
  };
  const progressed = () => {
    opts.onProgress?.(items.length);
    if (!opts.onSnapshot || items.length === 0) return;
    const t = now();
    if (lastSnapshot !== undefined && t - lastSnapshot < snapshotMs) return;
    lastSnapshot = t;
    opts.onSnapshot(buildVodList(kind, items.slice(), categories));
  };

  // 1. The whole list in one request.
  let fallback = false;
  let fullError: unknown;
  try {
    for await (const batch of api.all(signal)) {
      check();
      add(batch);
      progressed();
      if (truncated) break;
    }
    check();
    // An empty answer while categories exist: maybe the panel wants category_id. Probe the first one only.
    if (items.length === 0 && categories.length > 0) fallback = true;
  } catch (e) {
    check();
    if (stopsAsking(e)) throw e;
    fullError = e;
    fallback = true;
  }
  // Nothing to fall back on (no categories): what arrived before the failure is all there is.
  if (fullError !== undefined && categories.length === 0) {
    if (items.length === 0) throw fullError;
    partial = true;
  }

  // 2. Fallback: one category at a time, paced.
  if (fallback && !truncated) {
    const probing = items.length === 0;
    const known = new Set(categories.map((c) => c.id));
    let lastStart: number | undefined;
    let fails = 0;
    let lastError: unknown;
    for (let i = 0; i < categories.length && !truncated; i++) {
      if (lastStart !== undefined) {
        const wait = lastStart + gap - now();
        if (wait > 0) await sleep(wait);
        check();
      }
      lastStart = now();
      const id = categories[i]!.id;
      let list: VodItem[];
      try {
        list = await guard(api.list(id, signal));
      } catch (e) {
        if (e instanceof VodFetchCancelled) throw e;
        lastError = e;
        partial = true;
        if (stopsAsking(e) || ++fails >= VOD_FALLBACK_MAX_FAILS) break;
        continue;
      }
      check();
      fails = 0;
      // The first answer holds other categories' titles: the panel ignores category_id, so this is everything.
      if (i === 0 && list.some((it) => it.categoryId !== id && known.has(it.categoryId))) {
        add(list);
        progressed();
        break;
      }
      // An empty probe: the source has no titles of this kind.
      if (i === 0 && probing && list.length === 0) break;
      add(list);
      progressed();
    }
    if (items.length === 0 && lastError !== undefined) throw lastError;
  }

  opts.onProgress?.(items.length);
  return buildVodList(kind, items, categories, { truncated, partial });
}
