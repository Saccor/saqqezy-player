import { describe, expect, it } from 'vitest';
import type { CompanionChannel } from '@iptv/companion-protocol';
import { applyOps, emptyLayout, FAV_LIST_ID, type Layout, type LayoutOp } from '@iptv/core';
import { groupChannels, GroupModel } from './groups.ts';
import { arrayMove, channelOrderOps, groupOrderOps, listChannelMoveOps, listMoveOps, newListId, resolveDrop } from './reorder.ts';

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

describe('channelOrderOps sends only the changed prefix', () => {
  const NAMES = ['Kilo', 'alpha', 'Echo 10', 'Echo 9', 'bravo', 'Zulu', 'delta', 'Mike', 'Charlie', 'Lima', 'foxtrot', 'Hotel'];
  const channels: CompanionChannel[] = NAMES.map((name, i) => ({ id: `c${i}`, name, group: 'G', number: (i * 7) % 12 + 1, hasEpg: true }));
  const model = new GroupModel(channels);
  const gid = 'g:G';
  const shown = (l: Layout) => groupChannels(model, gid, l).map((c) => c.id);

  const starts: [string, LayoutOp[]][] = [
    ['provider', []],
    ['number', [{ op: 'setSort', groupId: gid, mode: 'number' }]],
    ['name', [{ op: 'setSort', groupId: gid, mode: 'name' }]],
    ['name + partial manual', [{ op: 'setSort', groupId: gid, mode: 'name' }, { op: 'setChannelOrder', groupId: gid, ids: ['c5', 'c2', 'c9'] }]],
    ['number + manual with a stale id', [{ op: 'setSort', groupId: gid, mode: 'number' }, { op: 'setChannelOrder', groupId: gid, ids: ['gone', 'c3'] }]],
    ['full manual', [{ op: 'setChannelOrder', groupId: gid, ids: ['c11', 'c10', 'c9', 'c8', 'c7', 'c6', 'c5', 'c4', 'c3', 'c2', 'c1', 'c0'] }]],
  ];

  it.each(starts)('%s: the TV order is the moved order for every move', (_name, setup) => {
    const l = applyOps(emptyLayout(), setup).layout;
    const ids = shown(l);
    const m = l.channelOrder[gid]?.length ?? 0;
    for (let from = 0; from < ids.length; from++) {
      for (let to = 0; to < ids.length; to++) {
        if (from === to) continue;
        const ops = channelOrderOps(gid, ids, from, to, m);
        expect(ops).toHaveLength(1);
        const sent = (ops[0] as { ids: string[] }).ids;
        expect(sent).toHaveLength(Math.min(ids.length, Math.max(Math.max(from, to) + 1, m)));
        const r = applyOps(l, ops);
        expect(r.rejected).toEqual([]);
        expect(shown(r.layout), `${from} -> ${to}`).toEqual(arrayMove(ids, from, to));
      }
    }
  });

  it('a move near the top of a big group sends a short prefix', () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `ch${i}`);
    const ops = channelOrderOps('g:A', ids, 3, 1, 0);
    expect((ops[0] as { ids: string[] }).ids).toEqual(['ch0', 'ch3', 'ch1', 'ch2']);
  });
});

describe('resolveDrop', () => {
  it('takes the dragged row by key at drop time, so a list that changed during the drag moves the right row', () => {
    // Dragged 'c' from index 2; meanwhile 'a' was removed, so 'c' is now at index 1.
    expect(resolveDrop(['b', 'c', 'd', 'e'], 'c', 3, 0)).toEqual({ from: 1, to: 3 });
  });

  it('aborts when the dragged row is gone, or nothing moves', () => {
    expect(resolveDrop(['a', 'b'], 'x', 0, 0)).toBeUndefined();
    expect(resolveDrop(['a', 'b', 'c'], 'b', 1, 0)).toBeUndefined();
  });

  it('clamps the target to the list and to minIndex', () => {
    expect(resolveDrop(['fav', 'a', 'b'], 'b', 0, 1)).toEqual({ from: 2, to: 1 });
    expect(resolveDrop(['a', 'b'], 'a', 9, 0)).toEqual({ from: 0, to: 1 });
    expect(resolveDrop(['fav', 'a'], 'fav', 1, 1)).toBeUndefined(); // a locked row never moves
  });
});
