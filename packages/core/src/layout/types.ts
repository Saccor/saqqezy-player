import { GROUP_FAV } from '../constants.ts';

export type SortMode = 'provider' | 'number' | 'name';

export interface UserList {
  id: string;
  name: string;
  channelIds: string[];
}

export interface Layout {
  version: number;
  lists: UserList[];
  hiddenChannels: string[];
  hiddenGroups: string[];
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

export function emptyLayout(): Layout {
  return {
    version: 0,
    lists: [{ id: FAV_LIST_ID, name: 'Favourites', channelIds: [] }],
    hiddenChannels: [],
    hiddenGroups: [],
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
}
