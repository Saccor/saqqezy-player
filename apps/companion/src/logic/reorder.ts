import { FAV_LIST_ID, type LayoutOp } from '@iptv/core';

/** A copy of `arr` with the item at `from` moved to `to` (clamped). An out-of-range `from` returns a plain copy. */
export function arrayMove<T>(arr: readonly T[], from: number, to: number): T[] {
  const out = arr.slice();
  if (from < 0 || from >= out.length) return out;
  const target = Math.min(Math.max(to, 0), out.length - 1);
  if (target === from) return out;
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item as T);
  return out;
}

/** A channel dragged inside a user list. `moveInList` takes an absolute index, so it is safe to re-apply. */
export function listChannelMoveOps(listId: string, ids: readonly string[], from: number, to: number): LayoutOp[] {
  const channelId = ids[from];
  if (channelId === undefined || from === to) return [];
  return [{ op: 'moveInList', listId, channelId, toIndex: Math.min(Math.max(to, 0), ids.length - 1) }];
}

/** A list dragged among the lists. Favourites stays first: it never moves, and nothing moves above it. */
export function listMoveOps(lists: readonly { id: string }[], from: number, to: number): LayoutOp[] {
  const list = lists[from];
  if (!list || list.id === FAV_LIST_ID) return [];
  const target = Math.min(Math.max(to, 1), lists.length - 1);
  if (target === from) return [];
  return [{ op: 'moveList', listId: list.id, toIndex: target }];
}

/** A provider group dragged: the TV gets the full order. */
export function groupOrderOps(groupIds: readonly string[], from: number, to: number): LayoutOp[] {
  if (from === to || groupIds[from] === undefined) return [];
  return [{ op: 'setGroupOrder', ids: arrayMove(groupIds, from, to) }];
}

/** A channel dragged inside a provider group: the TV gets the group's full manual order. */
export function channelOrderOps(groupId: string, ids: readonly string[], from: number, to: number): LayoutOp[] {
  if (from === to || ids[from] === undefined) return [];
  return [{ op: 'setChannelOrder', groupId, ids: arrayMove(ids, from, to) }];
}

/** A fresh user-list id in the reducer's format (`[a-z0-9-]{1,32}`). */
export function newListId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = 'l-';
  for (const b of bytes) s += b.toString(36).padStart(2, '0');
  return s.slice(0, 32);
}
