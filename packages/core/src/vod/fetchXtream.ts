import type { XtreamClient } from '../xtream/client.ts';
import { buildVodList } from './list.ts';
import { VOD_CAP, type VodCategory, type VodItem, type VodKind, type VodList } from './types.ts';

export interface XtreamVodApi {
  categories(signal?: AbortSignal): Promise<VodCategory[]>;
  list(categoryId?: string, signal?: AbortSignal): Promise<VodItem[]>;
}

export function xtreamVodApi(client: XtreamClient, sourceId: string, kind: VodKind): XtreamVodApi {
  return kind === 'movie'
    ? { categories: (s) => client.vodCategories(s), list: (c, s) => client.vodStreams(sourceId, c, s) }
    : { categories: (s) => client.seriesCategories(s), list: (c, s) => client.seriesList(sourceId, c, s) };
}

/** The fetch was cancelled (source switched or removed). Nothing was stored. */
export class VodFetchCancelled extends Error {
  constructor() {
    super('The catalogue fetch was cancelled.');
    this.name = 'VodFetchCancelled';
  }
}

/**
 * Fetches a whole catalogue one category at a time (`concurrency` requests in flight), so no single response holds
 * the full list. A server that ignores `category_id` is detected on the first answer, which is then the full list.
 * Items are kept in category order, de-duplicated by id, and cut at `cap`.
 */
export async function fetchXtreamCatalog(
  api: XtreamVodApi,
  kind: VodKind,
  opts: { concurrency?: number; cap?: number; signal?: AbortSignal; onProgress?: (count: number) => void } = {},
): Promise<VodList> {
  const cap = opts.cap ?? VOD_CAP;
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const check = () => {
    if (opts.signal?.aborted) throw new VodFetchCancelled();
  };

  const signal = opts.signal;
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

  if (categories.length === 0) {
    add(await guard(api.list(undefined, signal)));
    check();
  } else {
    const firstId = categories[0]!.id;
    const first = await guard(api.list(firstId, signal));
    check();
    const others = new Set(categories.slice(1).map((c) => c.id));
    others.delete(firstId);
    if (first.some((it) => others.has(it.categoryId))) {
      add(first);
    } else {
      const results: VodItem[][] = new Array<VodItem[]>(categories.length);
      results[0] = first;
      const unique = new Set(first.map((it) => it.id));
      let next = 1;
      let stop = false;
      opts.onProgress?.(unique.size);
      const worker = async () => {
        while (!stop && next < categories.length && unique.size < cap) {
          const i = next++;
          try {
            const list = await guard(api.list(categories[i]!.id, signal));
            check();
            results[i] = list;
            for (const it of list) unique.add(it.id);
          } catch (e) {
            stop = true;
            throw e;
          }
          opts.onProgress?.(Math.min(unique.size, cap));
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, categories.length - 1) }, worker));
      for (const r of results) if (r) add(r);
      if (next < categories.length && unique.size >= cap) truncated = true;
    }
  }
  opts.onProgress?.(items.length);
  return buildVodList(kind, items, categories, { truncated });
}
