import { UNCATEGORIZED } from '../constants.ts';
import { SharedCatchup } from '../catchup/m3uCatchup.ts';
import type { Channel } from '../types.ts';
import type { XtreamCategory, XtreamClient, XtreamStream } from './client.ts';

/**
 * Maps the live streams to channels in the provider's category order (`get_live_categories`), not the order streams
 * arrive in: a stable sort by category index, unknown or missing categories last, stream order inside a category.
 * Fallback numbers (`num` missing) are given in the original stream order first, so number-zapping stays what it was.
 */
export function xtreamToChannels(
  sourceId: string,
  client: XtreamClient,
  categories: XtreamCategory[],
  streams: XtreamStream[],
  ext: 'ts' | 'm3u8' = 'ts',
): Channel[] {
  const catName = new Map<string, string>();
  const catRank = new Map<string, number>();
  for (const c of categories) {
    if (!catName.has(c.id)) catName.set(c.id, c.name);
    if (!catRank.has(c.id)) catRank.set(c.id, catRank.size);
  }
  const shared = new SharedCatchup();
  let next = streams.reduce((m, s) => Math.max(m, s.num ?? 0), 0) + 1;
  const out = streams.map((s) => {
    const ch: Channel = {
      id: `${sourceId}:x${s.streamId}`,
      sourceId,
      name: s.name,
      url: client.streamUrl(s.streamId, ext),
      group: (s.categoryId && catName.get(s.categoryId)) || UNCATEGORIZED,
      number: s.num ?? next++,
    };
    if (s.epgChannelId) ch.epgId = s.epgChannelId;
    if (s.icon) ch.logo = s.icon;
    if (s.archiveDays) ch.cu = shared.get({ mode: 'xc', days: s.archiveDays });
    return ch;
  });
  return byCategory(out, streams, catRank);
}

/** `channels[i]` came from `streams[i]`; returns them stably sorted by category rank (unknown last). */
function byCategory(channels: Channel[], streams: XtreamStream[], catRank: Map<string, number>): Channel[] {
  const last = catRank.size;
  const rank = new Int32Array(streams.length);
  let sorted = true;
  for (let i = 0; i < streams.length; i++) {
    const id = streams[i]!.categoryId;
    rank[i] = (id === undefined ? undefined : catRank.get(id)) ?? last;
    if (i > 0 && rank[i]! < rank[i - 1]!) sorted = false;
  }
  if (sorted) return channels;
  const order = Array.from({ length: channels.length }, (_, i) => i);
  order.sort((a, b) => rank[a]! - rank[b]! || a - b);
  return order.map((i) => channels[i]!);
}
