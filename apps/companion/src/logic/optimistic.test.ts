import { describe, expect, it } from 'vitest';
import { applyOps, emptyLayout, type Layout, type LayoutOp } from '@iptv/core';
import { OptimisticLayout } from './optimistic.ts';

/** The TV side: the same reducer, applied to its own layout. */
function tvApply(l: Layout, ops: LayoutOp[]): Layout {
  return applyOps(l, ops).layout;
}

describe('OptimisticLayout', () => {
  it('shows a change at once, before the TV answers', () => {
    const o = new OptimisticLayout();
    o.confirm(emptyLayout());
    o.add([{ op: 'setHideNoEpg', value: true }]);
    expect(o.view()!.hideNoEpg).toBe(true);
    expect(o.base()!.hideNoEpg).toBe(false);
  });

  it('keeps an acknowledged change until the TV layout arrives, then the TV layout is the view', () => {
    const o = new OptimisticLayout();
    let tv = emptyLayout();
    o.confirm(tv);
    const ops: LayoutOp[] = [{ op: 'createList', id: 'mine', name: 'Mine' }];
    const id = o.add(ops);
    o.ack(id);
    expect(o.view()!.lists.map((l) => l.id)).toEqual(['fav', 'mine']);
    tv = tvApply(tv, ops);
    o.confirm(tv);
    expect(o.pendingCount).toBe(0);
    expect(o.view()).toEqual(tv);
  });

  it('the TV wins: a newer TV layout replaces what was guessed', () => {
    const o = new OptimisticLayout();
    let tv = emptyLayout();
    o.confirm(tv);
    const id = o.add([{ op: 'renameChannel', id: 'c1', name: 'Phone name' }]);
    o.ack(id);
    // Someone on the TV renamed it differently after our op landed.
    tv = tvApply(tv, [{ op: 'renameChannel', id: 'c1', name: 'Phone name' }]);
    tv = tvApply(tv, [{ op: 'renameChannel', id: 'c1', name: 'TV name' }]);
    o.confirm(tv);
    expect(o.view()!.channelNames).toEqual({ c1: 'TV name' });
  });

  it('re-applies unacknowledged changes on top of a newer TV layout', () => {
    const o = new OptimisticLayout();
    let tv = emptyLayout();
    o.confirm(tv);
    o.add([{ op: 'hideGroups', ids: ['g:A'] }]);
    tv = tvApply(tv, [{ op: 'setHideNoEpg', value: true }]); // an unrelated change on the TV
    o.confirm(tv);
    const v = o.view()!;
    expect(v.hideNoEpg).toBe(true);
    expect(v.hiddenGroups).toEqual(['g:A']);
  });

  it('reverts a rejected change', () => {
    const o = new OptimisticLayout();
    o.confirm(emptyLayout());
    const id = o.add([{ op: 'hideGroups', ids: ['g:A'] }]);
    expect(o.view()!.hiddenGroups).toEqual(['g:A']);
    o.drop(id);
    expect(o.view()!.hiddenGroups).toEqual([]);
  });

  it('ignores a TV layout older than the one it holds', () => {
    const o = new OptimisticLayout();
    const v1 = tvApply(emptyLayout(), [{ op: 'setHideNoEpg', value: true }]);
    const v2 = tvApply(v1, [{ op: 'hideGroups', ids: ['g:A'] }]);
    expect(o.confirm(v2)).toBe(true);
    expect(o.confirm(v1)).toBe(false);
    expect(o.view()!.hiddenGroups).toEqual(['g:A']);
  });

  it('has no view before the first TV layout, and forgets everything on reset', () => {
    const o = new OptimisticLayout();
    expect(o.view()).toBeUndefined();
    o.confirm(emptyLayout());
    o.add([{ op: 'setHideNoEpg', value: true }]);
    o.reset();
    expect(o.view()).toBeUndefined();
    expect(o.pendingCount).toBe(0);
  });

  it('checks a change against the current view before it is sent', () => {
    const o = new OptimisticLayout();
    o.confirm(emptyLayout());
    expect(o.check([{ op: 'deleteList', listId: 'fav' }])).toEqual(['favourites cannot be deleted']);
    expect(o.check([{ op: 'setHideNoEpg', value: true }])).toEqual([]);
  });
});
