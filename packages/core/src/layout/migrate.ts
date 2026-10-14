import { RECENT_MAX } from '../constants.ts';
import { emptyLayout, FAV_LIST_ID, type Layout } from './types.ts';

/** v1 per-source user flags. Superseded by `Layout`; kept for migration and compatibility. */
export interface UserFlags {
  favourites: string[];
  hidden: string[];
  /** Most recent first, at most RECENT_MAX. */
  recent?: string[];
}

/** True when `x` has the v1 `UserFlags` shape (a `favourites` array and no `lists`). */
export function isUserFlags(x: unknown): x is UserFlags {
  return typeof x === 'object' && x !== null && !('lists' in x)
    && Array.isArray((x as { favourites?: unknown }).favourites);
}

/** Converts v1 flags to a layout. Ids missing from the current playlist are kept. */
export function layoutFromFlags(flags: UserFlags): Layout {
  const l = emptyLayout();
  const fav = l.lists.find((x) => x.id === FAV_LIST_ID);
  if (fav) fav.channelIds = [...new Set(flags.favourites)];
  l.hiddenChannels = [...new Set(flags.hidden ?? [])];
  l.recent = [...new Set(flags.recent ?? [])].slice(0, RECENT_MAX);
  return l;
}
