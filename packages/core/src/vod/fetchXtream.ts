import type { XtreamClient } from '../xtream/client.ts';
import { buildVodList } from './list.ts';
import { VOD_CAP, type VodCategory, type VodItem, type VodKind, type VodList } from './types.ts';

export interface XtreamVodApi {
  categories(): Promise<VodCategory[]>;
  list(categoryId?: string): Promise<VodItem[]>;
}

export function xtreamVodApi(client: XtreamClient, sourceId: string, kind: VodKind): XtreamVodApi {
  return kind === 'movie'
    ? { categories: () => client.vodCategories(), list: (c) => client.vodStreams(sourceId, c) }
    : { categories: () => client.seriesCategories(), list: (c) => client.seriesList(sourceId, c) };
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

  const categories = await api.categories();
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
    add(await api.list());
    check();
  } else {
    const firstId = categories[0]!.id;
    const first = await api.list(firstId);
    check();
    if (first.some((it) => it.categoryId !== firstId)) {
      add(first);
    } else {
      const results: VodItem[][] = new Array<VodItem[]>(categories.length);
      results[0] = first;
      let fetched = first.length;
      let next = 1;
      opts.onProgress?.(fetched);
      const worker = async () => {
        while (next < categories.length && fetched < cap) {
          const i = next++;
          const list = await api.list(categories[i]!.id);
          check();
          results[i] = list;
          fetched += list.length;
          opts.onProgress?.(Math.min(fetched, cap));
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, categories.length - 1) }, worker));
      for (const r of results) if (r) add(r);
      if (next < categories.length) truncated = true;
    }
  }
  opts.onProgress?.(items.length);
  return buildVodList(kind, items, categories, { truncated });
}
