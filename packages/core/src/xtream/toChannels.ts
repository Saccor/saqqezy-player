import { UNCATEGORIZED } from '../constants.ts';
import type { Channel } from '../types.ts';
import type { XtreamCategory, XtreamClient, XtreamStream } from './client.ts';

export function xtreamToChannels(
  sourceId: string,
  client: XtreamClient,
  categories: XtreamCategory[],
  streams: XtreamStream[],
  ext: 'ts' | 'm3u8' = 'ts',
): Channel[] {
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  let next = streams.reduce((m, s) => Math.max(m, s.num ?? 0), 0) + 1;
  return streams.map((s) => {
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
    return ch;
  });
}
