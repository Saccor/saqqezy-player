import { describe, expect, test } from 'vitest';
import {
  applyOps, emptyLayout, isLayoutOp, normalizeLayout, FAV_LIST_ID, MAX_LISTS, NAME_MAX,
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

describe('emptyLayout', () => {
  test('has only favourites', () => {
    const l = emptyLayout();
    expect(l.version).toBe(0);
    expect(l.lists).toEqual([{ id: FAV_LIST_ID, name: 'Favourites', channelIds: [] }]);
    expect(l.hideNoEpg).toBe(false);
    expect(l.recent).toEqual([]);
    expect(l.hiddenChannels).toEqual([]);
    expect(l.sort).toEqual({});
  });
});

describe('createList', () => {
  test('appends at end and trims name', () => {
    const r = run(emptyLayout(), { op: 'createList', id: 'a', name: '  Alpha ' }, { op: 'createList', id: 'b', name: 'Beta' });
    expect(r.layout.lists.map((x) => [x.id, x.name])).toEqual([['fav', 'Favourites'], ['a', 'Alpha'], ['b', 'Beta']]);
    expect(r.changed).toBe(true);
    expect(r.rejected).toEqual([]);
  });
  test('rejects duplicate id, fav, bad id, bad name', () => {
    const base = withLists('a');
    for (const op of [
      { op: 'createList', id: 'a', name: 'X' },
      { op: 'createList', id: 'fav', name: 'X' },
      { op: 'createList', id: 'Bad_Id', name: 'X' },
      { op: 'createList', id: '', name: 'X' },
      { op: 'createList', id: 'x'.repeat(33), name: 'X' },
      { op: 'createList', id: 'ok', name: '   ' },
      { op: 'createList', id: 'ok', name: 'n'.repeat(NAME_MAX + 1) },
    ] as LayoutOp[]) {
      const r = run(base, op);
      expect(r.changed).toBe(false);
      expect(r.rejected).toHaveLength(1);
      expect(r.layout.lists).toHaveLength(2);
    }
  });
  test('accepts 60-char name and 32-char id', () => {
    const r = run(emptyLayout(), { op: 'createList', id: 'x'.repeat(32), name: 'n'.repeat(60) });
    expect(r.changed).toBe(true);
  });
  test('rejects the 51st list', () => {
    let l = emptyLayout();
    for (let i = 1; i < MAX_LISTS; i++) l = run(l, { op: 'createList', id: `l${i}`, name: `L${i}` }).layout;
    expect(l.lists).toHaveLength(MAX_LISTS);
    const r = run(l, { op: 'createList', id: 'over', name: 'Over' });
    expect(r.changed).toBe(false);
    expect(r.rejected[0]?.index).toBe(0);
  });
});

describe('renameList', () => {
  test('renames fav and others', () => {
    const r = run(withLists('a'), { op: 'renameList', listId: 'fav', name: ' Best ' }, { op: 'renameList', listId: 'a', name: 'Z' });
    expect(r.layout.lists.map((x) => x.name)).toEqual(['Best', 'Z']);
  });
  test('rejects unknown list and invalid name', () => {
    const r = run(emptyLayout(), { op: 'renameList', listId: 'nope', name: 'X' }, { op: 'renameList', listId: 'fav', name: ' ' });
    expect(r.changed).toBe(false);
    expect(r.rejected.map((x) => x.index)).toEqual([0, 1]);
  });
  test('same name is a no-op', () => {
    const r = run(emptyLayout(), { op: 'renameList', listId: 'fav', name: 'Favourites' });
    expect(r.changed).toBe(false);
    expect(r.rejected).toEqual([]);
  });
});

describe('deleteList', () => {
  test('removes list and its sort/order entries', () => {
    let l = withLists('a', 'b');
    l = run(l, { op: 'setSort', groupId: 'list:a', mode: 'name' }, { op: 'setSort', groupId: 'list:b', mode: 'name' }).layout;
    const r = run(l, { op: 'deleteList', listId: 'a' });
    expect(r.layout.lists.map((x) => x.id)).toEqual(['fav', 'b']);
    expect(r.layout.sort).toEqual({ 'list:b': 'name' });
  });
  test('rejects fav and unknown', () => {
    const r = run(emptyLayout(), { op: 'deleteList', listId: 'fav' }, { op: 'deleteList', listId: 'zz' });
    expect(r.changed).toBe(false);
    expect(r.rejected).toHaveLength(2);
  });
});

describe('moveList', () => {
  test('moves and clamps to keep fav first', () => {
    const l = withLists('a', 'b', 'c');
    expect(run(l, { op: 'moveList', listId: 'c', toIndex: 1 }).layout.lists.map((x) => x.id)).toEqual(['fav', 'c', 'a', 'b']);
    expect(run(l, { op: 'moveList', listId: 'c', toIndex: 0 }).layout.lists.map((x) => x.id)).toEqual(['fav', 'c', 'a', 'b']);
    expect(run(l, { op: 'moveList', listId: 'a', toIndex: 99 }).layout.lists.map((x) => x.id)).toEqual(['fav', 'b', 'c', 'a']);
    expect(run(l, { op: 'moveList', listId: 'c', toIndex: -5 }).layout.lists.map((x) => x.id)).toEqual(['fav', 'c', 'a', 'b']);
  });
  test('rejects fav and unknown; same position is a no-op', () => {
    const l = withLists('a', 'b');
    const r = run(l, { op: 'moveList', listId: 'fav', toIndex: 2 }, { op: 'moveList', listId: 'x', toIndex: 1 });
    expect(r.rejected).toHaveLength(2);
    const same = run(l, { op: 'moveList', listId: 'a', toIndex: 1 });
    expect(same.changed).toBe(false);
    expect(same.rejected).toEqual([]);
  });
});

describe('list membership', () => {
  test('addToList appends new ids, dedupes, keeps order', () => {
    const r = run(emptyLayout(), { op: 'addToList', listId: 'fav', channelIds: ['s:1', 's:2', 's:1'] }, { op: 'addToList', listId: 'fav', channelIds: ['s:2', 's:3'] });
    expect(r.layout.lists[0]?.channelIds).toEqual(['s:1', 's:2', 's:3']);
  });
  test('addToList with nothing new is a no-op; unknown list rejected', () => {
    const l = run(emptyLayout(), { op: 'addToList', listId: 'fav', channelIds: ['s:1'] }).layout;
    expect(run(l, { op: 'addToList', listId: 'fav', channelIds: ['s:1'] }).changed).toBe(false);
    expect(run(l, { op: 'addToList', listId: 'nope', channelIds: ['s:1'] }).rejected).toHaveLength(1);
  });
  test('ids not in any playlist are kept', () => {
    const r = run(emptyLayout(), { op: 'addToList', listId: 'fav', channelIds: ['ghost:9'] });
    expect(r.layout.lists[0]?.channelIds).toEqual(['ghost:9']);
  });
  test('removeFromList', () => {
    const l = run(emptyLayout(), { op: 'addToList', listId: 'fav', channelIds: ['s:1', 's:2', 's:3'] }).layout;
    const r = run(l, { op: 'removeFromList', listId: 'fav', channelIds: ['s:2', 's:9'] });
    expect(r.layout.lists[0]?.channelIds).toEqual(['s:1', 's:3']);
    expect(run(l, { op: 'removeFromList', listId: 'fav', channelIds: ['s:9'] }).changed).toBe(false);
    expect(run(l, { op: 'removeFromList', listId: 'nope', channelIds: ['s:1'] }).rejected).toHaveLength(1);
  });
  test('moveInList clamps and rejects missing channel', () => {
    const l = run(emptyLayout(), { op: 'addToList', listId: 'fav', channelIds: ['s:1', 's:2', 's:3'] }).layout;
    expect(run(l, { op: 'moveInList', listId: 'fav', channelId: 's:1', toIndex: 2 }).layout.lists[0]?.channelIds).toEqual(['s:2', 's:3', 's:1']);
    expect(run(l, { op: 'moveInList', listId: 'fav', channelId: 's:3', toIndex: -4 }).layout.lists[0]?.channelIds).toEqual(['s:3', 's:1', 's:2']);
    expect(run(l, { op: 'moveInList', listId: 'fav', channelId: 's:1', toIndex: 50 }).layout.lists[0]?.channelIds).toEqual(['s:2', 's:3', 's:1']);
    expect(run(l, { op: 'moveInList', listId: 'fav', channelId: 's:9', toIndex: 0 }).rejected).toHaveLength(1);
    expect(run(l, { op: 'moveInList', listId: 'nope', channelId: 's:1', toIndex: 0 }).rejected).toHaveLength(1);
    expect(run(l, { op: 'moveInList', listId: 'fav', channelId: 's:1', toIndex: 0 }).changed).toBe(false);
  });
});

describe('hide / unhide', () => {
  test('channels: set semantics, stable order, no-op repeat', () => {
    const a = run(emptyLayout(), { op: 'hideChannels', ids: ['s:2', 's:1', 's:2'] });
    expect(a.layout.hiddenChannels).toEqual(['s:2', 's:1']);
    const b = run(a.layout, { op: 'hideChannels', ids: ['s:1'] });
    expect(b.changed).toBe(false);
    expect(b.layout.version).toBe(a.layout.version);
    const c = run(a.layout, { op: 'unhideChannels', ids: ['s:2', 's:7'] });
    expect(c.layout.hiddenChannels).toEqual(['s:1']);
    expect(run(a.layout, { op: 'unhideChannels', ids: ['s:7'] }).changed).toBe(false);
  });
  test('groups', () => {
    const a = run(emptyLayout(), { op: 'hideGroups', ids: ['g:News', 'g:Kids'] });
    expect(a.layout.hiddenGroups).toEqual(['g:News', 'g:Kids']);
    expect(run(a.layout, { op: 'hideGroups', ids: ['g:News'] }).changed).toBe(false);
    expect(run(a.layout, { op: 'unhideGroups', ids: ['g:News'] }).layout.hiddenGroups).toEqual(['g:Kids']);
  });
});

describe('rename channel / group', () => {
  test('sets, trims, clears with null or blank', () => {
    let l = run(emptyLayout(), { op: 'renameChannel', id: 's:1', name: '  New  ' }, { op: 'renameGroup', id: 'g:News', name: 'Headlines' }).layout;
    expect(l.channelNames).toEqual({ 's:1': 'New' });
    expect(l.groupNames).toEqual({ 'g:News': 'Headlines' });
    l = run(l, { op: 'renameChannel', id: 's:1', name: null }, { op: 'renameGroup', id: 'g:News', name: '   ' }).layout;
    expect(l.channelNames).toEqual({});
    expect(l.groupNames).toEqual({});
  });
  test('rejects names over 60 characters', () => {
    const r = run(emptyLayout(), { op: 'renameChannel', id: 's:1', name: 'n'.repeat(61) }, { op: 'renameGroup', id: 'g:A', name: 'n'.repeat(61) });
    expect(r.changed).toBe(false);
    expect(r.rejected).toHaveLength(2);
  });
  test('same name and clearing a missing override are no-ops', () => {
    const l = run(emptyLayout(), { op: 'renameChannel', id: 's:1', name: 'X' }).layout;
    expect(run(l, { op: 'renameChannel', id: 's:1', name: ' X ' }).changed).toBe(false);
    expect(run(l, { op: 'renameChannel', id: 's:2', name: null }).changed).toBe(false);
    expect(run(l, { op: 'renameGroup', id: 'g:A', name: null }).changed).toBe(false);
  });
  test('prototype-pollution key is rejected', () => {
    const r = run(emptyLayout(), { op: 'renameChannel', id: '__proto__', name: 'x' });
    expect(r.rejected).toHaveLength(1);
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });
});

describe('ordering and sort', () => {
  test('setGroupOrder keeps only g: ids, dedupes', () => {
    const r = run(emptyLayout(), { op: 'setGroupOrder', ids: ['g:B', 'all', 'g:A', 'g:B', 'list:x'] });
    expect(r.layout.groupOrder).toEqual(['g:B', 'g:A']);
    expect(run(r.layout, { op: 'setGroupOrder', ids: ['g:B', 'g:A'] }).changed).toBe(false);
    expect(run(r.layout, { op: 'setGroupOrder', ids: [] }).layout.groupOrder).toEqual([]);
  });
  test('setChannelOrder dedupes; null deletes the key', () => {
    let l = run(emptyLayout(), { op: 'setChannelOrder', groupId: 'g:A', ids: ['s:2', 's:1', 's:2'] }).layout;
    expect(l.channelOrder).toEqual({ 'g:A': ['s:2', 's:1'] });
    expect(run(l, { op: 'setChannelOrder', groupId: 'g:A', ids: ['s:2', 's:1'] }).changed).toBe(false);
    l = run(l, { op: 'setChannelOrder', groupId: 'g:A', ids: null }).layout;
    expect(l.channelOrder).toEqual({});
    expect(run(l, { op: 'setChannelOrder', groupId: 'g:A', ids: null }).changed).toBe(false);
  });
  test('setChannelOrder rejects invalid group id', () => {
    expect(run(emptyLayout(), { op: 'setChannelOrder', groupId: 'bogus', ids: [] }).rejected).toHaveLength(1);
  });
  test('setSort accepts all, fav, list:<id>, g:<name> only', () => {
    for (const groupId of ['all', 'fav', 'list:abc', 'g:News']) {
      const r = run(emptyLayout(), { op: 'setSort', groupId, mode: 'name' });
      expect(r.layout.sort[groupId]).toBe('name');
    }
    for (const groupId of ['recent', 'News', 'list:', 'g:', '', '__proto__']) {
      expect(run(emptyLayout(), { op: 'setSort', groupId, mode: 'name' }).rejected).toHaveLength(1);
    }
    const l = run(emptyLayout(), { op: 'setSort', groupId: 'all', mode: 'name' }).layout;
    expect(run(l, { op: 'setSort', groupId: 'all', mode: 'name' }).changed).toBe(false);
  });
  test('setHideNoEpg', () => {
    const r = run(emptyLayout(), { op: 'setHideNoEpg', value: true });
    expect(r.layout.hideNoEpg).toBe(true);
    expect(run(r.layout, { op: 'setHideNoEpg', value: true }).changed).toBe(false);
  });
});

describe('markWatched', () => {
  test('moves to front, dedupes, caps at 20', () => {
    let l = emptyLayout();
    for (let i = 0; i < 25; i++) l = run(l, { op: 'markWatched', id: `s:${i}` }).layout;
    expect(l.recent).toHaveLength(20);
    expect(l.recent[0]).toBe('s:24');
    l = run(l, { op: 'markWatched', id: 's:10' }).layout;
    expect(l.recent.slice(0, 2)).toEqual(['s:10', 's:24']);
    expect(new Set(l.recent).size).toBe(20);
  });
  test('already first is a no-op', () => {
    const l = run(emptyLayout(), { op: 'markWatched', id: 's:1' }).layout;
    expect(run(l, { op: 'markWatched', id: 's:1' }).changed).toBe(false);
  });
});

describe('applyOps general', () => {
  test('version increments once per call, not per op', () => {
    const r = run(emptyLayout(), { op: 'hideChannels', ids: ['s:1'] }, { op: 'hideGroups', ids: ['g:A'] }, { op: 'markWatched', id: 's:1' });
    expect(r.layout.version).toBe(1);
    expect(run(r.layout, { op: 'hideChannels', ids: ['s:1'] }).layout.version).toBe(1);
  });
  test('rejected ops report index and do not stop later ops', () => {
    const r = run(emptyLayout(), { op: 'deleteList', listId: 'fav' }, { op: 'hideChannels', ids: ['s:1'] });
    expect(r.rejected).toEqual([{ index: 0, reason: expect.any(String) }]);
    expect(r.layout.hiddenChannels).toEqual(['s:1']);
    expect(r.changed).toBe(true);
  });
  test('empty ops: unchanged, same version', () => {
    const r = applyOps(emptyLayout(), []);
    expect(r.changed).toBe(false);
    expect(r.layout.version).toBe(0);
  });
  test('never mutates input, including rejected and changing ops', () => {
    let l = withLists('a', 'b');
    l = run(l, { op: 'addToList', listId: 'a', channelIds: ['s:1', 's:2'] }, { op: 'renameChannel', id: 's:1', name: 'N' }, { op: 'markWatched', id: 's:1' }).layout;
    const before = structuredClone(l);
    const ops: LayoutOp[] = [
      { op: 'moveList', listId: 'b', toIndex: 1 }, { op: 'addToList', listId: 'a', channelIds: ['s:3'] },
      { op: 'removeFromList', listId: 'a', channelIds: ['s:1'] }, { op: 'hideChannels', ids: ['s:9'] },
      { op: 'renameChannel', id: 's:1', name: null }, { op: 'setChannelOrder', groupId: 'g:A', ids: ['s:1'] },
      { op: 'setSort', groupId: 'all', mode: 'number' }, { op: 'deleteList', listId: 'a' },
      { op: 'deleteList', listId: 'fav' }, { op: 'markWatched', id: 's:5' },
    ];
    const r = applyOps(l, ops);
    expect(r.changed).toBe(true);
    expect(l).toEqual(before);
    expect(r.layout).not.toBe(l);
  });
});

describe('isLayoutOp', () => {
  test('accepts every valid op shape', () => {
    const valid: LayoutOp[] = [
      { op: 'createList', id: 'a', name: 'A' }, { op: 'renameList', listId: 'a', name: 'B' }, { op: 'deleteList', listId: 'a' },
      { op: 'moveList', listId: 'a', toIndex: 1 }, { op: 'addToList', listId: 'a', channelIds: ['s:1'] },
      { op: 'removeFromList', listId: 'a', channelIds: [] }, { op: 'moveInList', listId: 'a', channelId: 's:1', toIndex: 0 },
      { op: 'hideChannels', ids: ['s:1'] }, { op: 'unhideChannels', ids: [] }, { op: 'hideGroups', ids: ['g:A'] },
      { op: 'unhideGroups', ids: [] }, { op: 'renameChannel', id: 's:1', name: null }, { op: 'renameGroup', id: 'g:A', name: 'x' },
      { op: 'setGroupOrder', ids: ['g:A'] }, { op: 'setChannelOrder', groupId: 'g:A', ids: null },
      { op: 'setChannelOrder', groupId: 'g:A', ids: ['s:1'] }, { op: 'setSort', groupId: 'all', mode: 'name' },
      { op: 'setHideNoEpg', value: false }, { op: 'markWatched', id: 's:1' },
    ];
    for (const op of valid) expect(isLayoutOp(op), op.op).toBe(true);
  });
  test('rejects junk', () => {
    const bad: unknown[] = [
      null, undefined, 'x', 5, [], {}, { op: 'nuke' }, { op: 'hideChannels' }, { op: 'hideChannels', ids: [1] },
      { op: 'hideChannels', ids: 'a' }, { op: 'hideChannels', ids: new Array(50_001).fill('a') },
      { op: 'createList', id: 'a', name: 5 }, { op: 'createList', id: 5, name: 'a' }, { op: 'renameChannel', id: 's:1', name: 5 },
      { op: 'renameChannel', id: 's:1' }, { op: 'moveList', listId: 'a', toIndex: '1' }, { op: 'moveList', listId: 'a', toIndex: NaN },
      { op: 'setSort', groupId: 'all', mode: 'random' }, { op: 'setHideNoEpg', value: 'yes' },
      { op: 'setChannelOrder', groupId: 'g:A', ids: undefined }, { op: 'markWatched', id: null },
    ];
    for (const x of bad) expect(isLayoutOp(x), JSON.stringify(x)?.slice(0, 60)).toBe(false);
  });
  test('accepts exactly 50,000 ids', () => {
    expect(isLayoutOp({ op: 'hideChannels', ids: new Array(50_000).fill('a') })).toBe(true);
  });
});

describe('normalizeLayout', () => {
  test('unknown shapes become empty layout', () => {
    for (const x of [null, undefined, 3, 'x', [], true]) expect(normalizeLayout(x)).toEqual(emptyLayout());
  });
  test('fills missing fields', () => {
    const l = normalizeLayout({ version: 4 });
    expect(l).toEqual({ ...emptyLayout(), version: 4 });
  });
  test('round-trips a valid layout', () => {
    const l = run(withLists('a'), { op: 'addToList', listId: 'a', channelIds: ['s:1'] }, { op: 'setSort', groupId: 'all', mode: 'name' }, { op: 'markWatched', id: 's:1' }).layout;
    expect(normalizeLayout(structuredClone(l))).toEqual(l);
  });
  test('guarantees fav at index 0', () => {
    const missing = normalizeLayout({ lists: [{ id: 'a', name: 'A', channelIds: ['s:1'] }] });
    expect(missing.lists.map((x) => x.id)).toEqual(['fav', 'a']);
    const misplaced = normalizeLayout({ lists: [{ id: 'a', name: 'A', channelIds: [] }, { id: 'fav', name: 'Mine', channelIds: ['s:2'] }] });
    expect(misplaced.lists.map((x) => [x.id, x.name])).toEqual([['fav', 'Mine'], ['a', 'A']]);
    expect(misplaced.lists[0]?.channelIds).toEqual(['s:2']);
  });
  test('drops invalid and duplicate lists, clamps names and caps count', () => {
    const lists = [
      { id: 'BAD ID', name: 'x', channelIds: [] }, { id: 7, name: 'x', channelIds: [] }, null,
      { id: 'a', name: '  ' + 'n'.repeat(80), channelIds: ['s:1', 's:1', 4, 's:2'] },
      { id: 'a', name: 'dup', channelIds: [] },
    ];
    const l = normalizeLayout({ lists });
    expect(l.lists.map((x) => x.id)).toEqual(['fav', 'a']);
    expect(l.lists[1]?.name).toHaveLength(NAME_MAX);
    expect(l.lists[1]?.channelIds).toEqual(['s:1', 's:2']);
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `l${i}`, name: 'x', channelIds: [] }));
    expect(normalizeLayout({ lists: many }).lists).toHaveLength(MAX_LISTS);
  });
  test('cleans arrays, records, sort, recent, flags', () => {
    const l = normalizeLayout({
      version: -3, hiddenChannels: ['s:1', 's:1', 2], hiddenGroups: 'nope', groupOrder: ['g:B', 'all', 'g:B', 'g:A'],
      channelOrder: { 'g:A': ['s:1', 's:1', 3], bad: ['s:1'], 'g:B': 'x' },
      channelNames: { 's:1': '  ' + 'n'.repeat(80), 's:2': '  ', 's:3': 5 }, groupNames: { 'g:A': ' Hi ' },
      sort: { all: 'name', 'g:A': 'weird', nonsense: 'name' }, hideNoEpg: 'yes',
      recent: Array.from({ length: 30 }, (_, i) => `s:${i % 25}`),
    });
    expect(l.version).toBe(0);
    expect(l.hiddenChannels).toEqual(['s:1']);
    expect(l.hiddenGroups).toEqual([]);
    expect(l.groupOrder).toEqual(['g:B', 'g:A']);
    expect(l.channelOrder).toEqual({ 'g:A': ['s:1'] });
    expect(Object.keys(l.channelNames)).toEqual(['s:1']);
    expect(l.channelNames['s:1']).toHaveLength(NAME_MAX);
    expect(l.groupNames).toEqual({ 'g:A': 'Hi' });
    expect(l.sort).toEqual({ all: 'name' });
    expect(l.hideNoEpg).toBe(false);
    expect(l.recent).toHaveLength(20);
    expect(new Set(l.recent).size).toBe(20);
  });
  test('does not mutate input', () => {
    const x = { lists: [{ id: 'a', name: 'A', channelIds: ['s:1', 's:1'] }], hiddenChannels: ['a', 'a'] };
    const before = structuredClone(x);
    normalizeLayout(x);
    expect(x).toEqual(before);
  });
  test('ignores __proto__ keys', () => {
    const l = normalizeLayout(JSON.parse('{"channelNames":{"__proto__":"x","s:1":"y"}}'));
    expect(Object.keys(l.channelNames)).toEqual(['s:1']);
  });
});
