import { describe, expect, it } from 'vitest';
import { applyOps, emptyLayout, FAV_LIST_ID } from '@iptv/core';
import { arrayMove, channelOrderOps, groupOrderOps, listChannelMoveOps, listMoveOps, newListId } from './reorder.ts';

describe('arrayMove', () => {
  it('moves an item forwards and backwards without mutating the input', () => {
    const a = ['a', 'b', 'c', 'd'];
    expect(arrayMove(a, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(arrayMove(a, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(arrayMove(a, 1, 1)).toEqual(a);
    expect(a).toEqual(['a', 'b', 'c', 'd']);
  });

  it('clamps the target and ignores an out-of-range source', () => {
    expect(arrayMove(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a']);
    expect(arrayMove(['a', 'b', 'c'], 2, -5)).toEqual(['c', 'a', 'b']);
    expect(arrayMove(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });
});

describe('reorder to ops', () => {
  it('moves a channel inside a list with moveInList, matching what the reducer does', () => {
    const ids = ['c1', 'c2', 'c3', 'c4'];
    const ops = listChannelMoveOps('mine', ids, 3, 0);
    expect(ops).toEqual([{ op: 'moveInList', listId: 'mine', channelId: 'c4', toIndex: 0 }]);
    const base = applyOps(emptyLayout(), [{ op: 'createList', id: 'mine', name: 'Mine' }, { op: 'addToList', listId: 'mine', channelIds: ids }]).layout;
    const after = applyOps(base, ops).layout;
    expect(after.lists[1]!.channelIds).toEqual(arrayMove(ids, 3, 0));
    expect(listChannelMoveOps('mine', ids, 2, 2)).toEqual([]);
  });

  it('moves a list with moveList but never Favourites, and never above it', () => {
    const lists = [{ id: FAV_LIST_ID }, { id: 'a' }, { id: 'b' }];
    expect(listMoveOps(lists, 2, 1)).toEqual([{ op: 'moveList', listId: 'b', toIndex: 1 }]);
    expect(listMoveOps(lists, 2, 0)).toEqual([{ op: 'moveList', listId: 'b', toIndex: 1 }]);
    expect(listMoveOps(lists, 0, 2)).toEqual([]);
    expect(listMoveOps(lists, 1, 0)).toEqual([]);
  });

  it('sends the full group order with setGroupOrder', () => {
    expect(groupOrderOps(['g:A', 'g:B', 'g:C'], 2, 0)).toEqual([{ op: 'setGroupOrder', ids: ['g:C', 'g:A', 'g:B'] }]);
    expect(groupOrderOps(['g:A'], 0, 0)).toEqual([]);
  });

  it('sends the full channel order of a group with setChannelOrder', () => {
    expect(channelOrderOps('g:A', ['x', 'y', 'z'], 0, 2)).toEqual([{ op: 'setChannelOrder', groupId: 'g:A', ids: ['y', 'z', 'x'] }]);
  });

  it('makes list ids the reducer accepts', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = newListId();
      expect(id).toMatch(/^[a-z0-9-]{1,32}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(50);
    const r = applyOps(emptyLayout(), [{ op: 'createList', id: newListId(), name: 'X' }]);
    expect(r.rejected).toEqual([]);
  });
});
