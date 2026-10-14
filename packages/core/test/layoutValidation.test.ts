import { describe, expect, test } from 'vitest';
import {
  applyOps, emptyLayout, isLayoutOp, isLayoutOpBatch, normalizeLayout, MAX_IDS, MAX_OPS_PER_BATCH,
  type Layout, type LayoutOp,
} from '../src/layout/index.ts';

function run(layout: Layout, ...ops: LayoutOp[]) {
  return applyOps(layout, ops);
}
function withLists(...ids: string[]): Layout {
  let l = emptyLayout();
  for (const id of ids) l = run(l, { op: 'createList', id, name: id.toUpperCase() }).layout;
  return l;
}
function rejects(l: Layout, op: unknown) {
  const r = applyOps(l, [op as LayoutOp]);
  expect(r.rejected, JSON.stringify(op)?.slice(0, 80)).toHaveLength(1);
  expect(r.changed).toBe(false);
  return r;
}

describe('layout validation (fix round 1)', () => {
  test('deleteList removes channelOrder as well as sort', () => {
    let l = withLists('a');
    l = run(l, { op: 'setChannelOrder', groupId: 'list:a', ids: ['s:1'] }, { op: 'setSort', groupId: 'list:a', mode: 'name' }).layout;
    expect(l.channelOrder['list:a']).toEqual(['s:1']);
    const r = run(l, { op: 'deleteList', listId: 'a' });
    expect(r.layout.channelOrder).toEqual({});
    expect(r.layout.sort).toEqual({});
  });

  test('NaN, Infinity and fractional indexes are rejected as invalid index', () => {
    let l = withLists('a', 'b');
    l = run(l, { op: 'addToList', listId: 'a', channelIds: ['s:1', 's:2'] }).layout;
    for (const toIndex of [NaN, Infinity, -Infinity, 0.5, 1.5]) {
      expect(rejects(l, { op: 'moveList', listId: 'a', toIndex }).rejected[0]?.reason).toBe('invalid index');
      expect(rejects(l, { op: 'moveInList', listId: 'a', channelId: 's:1', toIndex }).rejected[0]?.reason).toBe('invalid index');
    }
  });

  test('sparse arrays and empty or over-long ids are rejected by the reducer', () => {
    const l = withLists('a');
    const sparse: string[] = ['s:1'];
    sparse[2] = 's:3';
    rejects(l, { op: 'hideChannels', ids: sparse });
    rejects(l, { op: 'addToList', listId: 'a', channelIds: sparse });
    rejects(l, { op: 'hideChannels', ids: [''] });
    rejects(l, { op: 'hideGroups', ids: ['x'.repeat(2049)] });
    rejects(l, { op: 'markWatched', id: '' });
    rejects(l, { op: 'renameChannel', id: '', name: 'x' });
    rejects(l, { op: 'addToList', listId: '', channelIds: ['s:1'] });
    rejects(l, { op: 'moveInList', listId: 'a', channelId: '', toIndex: 0 });
    rejects(l, { op: 'setChannelOrder', groupId: 'all', ids: ['s:1', ''] });
  });

  test('isLayoutOp rejects sparse arrays, empty ids and fractional indexes', () => {
    const sparse: string[] = ['s:1'];
    sparse[2] = 's:3';
    expect(isLayoutOp({ op: 'hideChannels', ids: sparse })).toBe(false);
    expect(isLayoutOp({ op: 'hideChannels', ids: [''] })).toBe(false);
    expect(isLayoutOp({ op: 'markWatched', id: '' })).toBe(false);
    expect(isLayoutOp({ op: 'moveList', listId: 'a', toIndex: 0.5 })).toBe(false);
  });

  test('list and set sizes are capped at 50,000; ops that would exceed are rejected', () => {
    const full = Array.from({ length: MAX_IDS }, (_, i) => `s:${i}`);
    let l = withLists('a');
    l = run(l, { op: 'addToList', listId: 'a', channelIds: full }, { op: 'hideChannels', ids: full }, { op: 'hideGroups', ids: full }).layout;
    expect(l.lists[1]?.channelIds).toHaveLength(MAX_IDS);
    const r = applyOps(l, [
      { op: 'addToList', listId: 'a', channelIds: ['extra'] }, { op: 'hideChannels', ids: ['extra'] }, { op: 'hideGroups', ids: ['extra'] },
      { op: 'addToList', listId: 'a', channelIds: ['s:1'] },
    ]);
    expect(r.rejected.map((x) => x.index)).toEqual([0, 1, 2]);
    expect(r.layout.lists[1]?.channelIds).toHaveLength(MAX_IDS);
    expect(r.layout.hiddenChannels).toHaveLength(MAX_IDS);
  });

  test('setSort and setChannelOrder reject list:fav', () => {
    const l = emptyLayout();
    rejects(l, { op: 'setSort', groupId: 'list:fav', mode: 'name' });
    rejects(l, { op: 'setChannelOrder', groupId: 'list:fav', ids: ['s:1'] });
    rejects(l, { op: 'setChannelOrder', groupId: 'list:fav', ids: null });
  });

  test('isLayoutOpBatch: arrays of valid ops, at most MAX_OPS_PER_BATCH', () => {
    expect(MAX_OPS_PER_BATCH).toBe(500);
    const op: LayoutOp = { op: 'setHideNoEpg', value: true };
    expect(isLayoutOpBatch([])).toBe(true);
    expect(isLayoutOpBatch(new Array(500).fill(op))).toBe(true);
    expect(isLayoutOpBatch(new Array(501).fill(op))).toBe(false);
    expect(isLayoutOpBatch([op, { op: 'nuke' }])).toBe(false);
    expect(isLayoutOpBatch({ length: 1 })).toBe(false);
    const sparse: LayoutOp[] = [op];
    sparse[2] = op;
    expect(isLayoutOpBatch(sparse)).toBe(false);
  });

  test('normalizeLayout keeps the first MAX_IDS valid ids and ignores a huge junk prefix cheaply', () => {
    const junk = new Array(200_000).fill(7) as unknown[];
    expect(normalizeLayout({ hiddenChannels: [...junk, 'late'] }).hiddenChannels).toEqual([]);
    const big = Array.from({ length: 120_000 }, (_, i) => `s:${i}`);
    expect(normalizeLayout({ hiddenChannels: big }).hiddenChannels).toHaveLength(MAX_IDS);
  });

  test('normalizeLayout is idempotent on hostile input', () => {
    const hostile: unknown[] = [
      JSON.parse('{"version":2,"lists":[{"id":"a","name":"A","channelIds":["x","",1,null,"x"]},{"id":"fav","channelIds":"no"},{"__proto__":{"id":"p"}}],"channelOrder":{"__proto__":["a"],"g:A":["b","b",3],"bad":["c"],"list:fav":["z"]},"channelNames":{"__proto__":"x","s:1":"  n  ","":"e","s:2":5},"groupNames":[],"sort":{"all":"name","g:X":"random","list:fav":"name"},"hideNoEpg":1,"recent":["a","a",""],"hiddenGroups":[{}],"groupOrder":["g:","g:B","x"]}'),
      { lists: [null, 3, { id: 'FAV' }], sort: [], channelOrder: 'x', version: 1.5 },
      { version: Infinity, recent: new Array(500).fill('r'), hiddenChannels: ['x'.repeat(5000), 'ok'] },
      [], null, 'str',
    ];
    for (const h of hostile) {
      const once = normalizeLayout(h);
      expect(normalizeLayout(once)).toEqual(once);
      expect(once.lists[0]?.id).toBe('fav');
      expect(Object.getPrototypeOf(once.channelOrder)).toBe(Object.prototype);
      expect(once.sort['list:fav']).toBeUndefined();
      expect(once.channelOrder['list:fav']).toBeUndefined();
    }
  });

  test('untouched fields are shared, touched ones replaced; input stays pristine', () => {
    const l = run(withLists('a'), { op: 'addToList', listId: 'a', channelIds: ['s:1'] }).layout;
    const frozen = JSON.stringify(l);
    const r = run(l, { op: 'markWatched', id: 's:1' });
    expect(r.layout.lists).toBe(l.lists);
    expect(r.layout.recent).not.toBe(l.recent);
    expect(JSON.stringify(l)).toBe(frozen);
  });
});
