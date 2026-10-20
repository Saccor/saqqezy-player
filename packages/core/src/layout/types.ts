import { GROUP_FAV } from '../constants.ts';

export type SortMode = 'provider' | 'number' | 'name';

export interface UserList {
  id: string;
  name: string;
  channelIds: string[];
}

/**
 * Shape version of a stored layout (not the edit counter `version`). 2 added `shownGroups` and `groupRegion`
 * (report 2026-10-20 §2.2); `normalizeLayout` migrates older layouts by defaulting them.
 */
export const LAYOUT_SCHEMA = 2;
/** Most region keys in one `groupRegion` entry. */
export const GROUP_REGION_MAX = 10;

export interface Layout {
  /** Edit counter: +1 per applied batch. */
  version: number;
  schema: number;
  lists: UserList[];
  hiddenChannels: string[];
  hiddenGroups: string[];
  /** Groups shown on purpose: beats the region rule (`hiddenGroups` still beats this). */
  shownGroups: string[];
  /** The user's region keys for a group (countries, `lang:xx`), over detection; [] = no country. */
  groupRegion: Record<string, string[]>;
  groupOrder: string[];
  channelOrder: Record<string, string[]>;
  channelNames: Record<string, string>;
  groupNames: Record<string, string>;
  sort: Record<string, SortMode>;
  hideNoEpg: boolean;
  recent: string[];
}

export const FAV_LIST_ID = GROUP_FAV;
export const MAX_LISTS = 50;
export const NAME_MAX = 60;
/** Longest accepted id (channel, group, list). */
export const MAX_ID_LEN = 2048;
/** Largest accepted list or set of ids, in ops and in stored layouts. */
export const MAX_IDS = 50_000;
/** Largest op batch accepted from an untrusted source. */
export const MAX_OPS_PER_BATCH = 500;

/** The one id rule shared by the reducer and `normalizeLayout`: a non-empty string of at most MAX_ID_LEN characters. */
export function isValidId(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0 && x.length <= MAX_ID_LEN;
}

export function emptyLayout(): Layout {
  return {
    version: 0,
    schema: LAYOUT_SCHEMA,
    lists: [{ id: FAV_LIST_ID, name: 'Favourites', channelIds: [] }],
    hiddenChannels: [],
    hiddenGroups: [],
    shownGroups: [],
    groupRegion: {},
    groupOrder: [],
    channelOrder: {},
    channelNames: {},
    groupNames: {},
    sort: {},
    hideNoEpg: false,
    recent: [],
  };
}

export type LayoutOp =
  | { op: 'createList'; id: string; name: string }
  | { op: 'renameList'; listId: string; name: string }
  | { op: 'deleteList'; listId: string }
  | { op: 'moveList'; listId: string; toIndex: number }
  | { op: 'addToList'; listId: string; channelIds: string[] }
  | { op: 'removeFromList'; listId: string; channelIds: string[] }
  | { op: 'moveInList'; listId: string; channelId: string; toIndex: number }
  | { op: 'hideChannels'; ids: string[] }
  | { op: 'unhideChannels'; ids: string[] }
  | { op: 'hideGroups'; ids: string[] }
  | { op: 'unhideGroups'; ids: string[] }
  /** Shows groups on purpose: unhides them and lets them beat the region rule. */
  | { op: 'showGroups'; ids: string[] }
  /** Returns groups to the region rule (drops them from `shownGroups`). */
  | { op: 'unshowGroups'; ids: string[] }
  /** The user's region keys for a group; null returns it to detection. */
  | { op: 'setGroupRegion'; id: string; codes: string[] | null }
  | { op: 'renameChannel'; id: string; name: string | null }
  | { op: 'renameGroup'; id: string; name: string | null }
  | { op: 'setGroupOrder'; ids: string[] }
  | { op: 'setChannelOrder'; groupId: string; ids: string[] | null }
  | { op: 'setSort'; groupId: string; mode: SortMode }
  | { op: 'setHideNoEpg'; value: boolean }
  | { op: 'markWatched'; id: string };

export interface ApplyResult {
  layout: Layout;
  changed: boolean;
  rejected: { index: number; reason: string }[];
  /**
   * Sync clock keys (`sync/keys.ts`) of the registers the batch changed, each once: what the write path stamps.
   * Empty when nothing synced changed (`markWatched` only touches `recent`, which stays local).
   */
  touched: string[];
}
