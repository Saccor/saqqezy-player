import { describe, expect, test } from 'vitest';
import { LAYOUT_SCHEMA, applyOps, emptyLayout, isLayoutOp, normalizeLayout } from '../src/layout/index.ts';

const G1 = 'g:SE | Synthetic News';
const G2 = 'g:DK | Synthetic Docs';

describe('layout: shown groups and group regions', () => {
  test('an empty layout has the new fields and the current schema', () => {
    const l = emptyLayout();
    expect(l.schema).toBe(LAYOUT_SCHEMA);
    expect(LAYOUT_SCHEMA).toBe(2);
    expect(l.shownGroups).toEqual([]);
    expect(l.groupRegion).toEqual({});
  });

  test('a stored schema-1 layout migrates: fields defaulted, everything else kept', () => {
    const old = { version: 7, lists: [{ id: 'fav', name: 'Favourites', channelIds: ['a'] }], hiddenGroups: [G1], recent: [] };
    const l = normalizeLayout(old);
    expect(l.schema).toBe(2);
    expect(l.version).toBe(7);
    expect(l.hiddenGroups).toEqual([G1]);
    expect(l.shownGroups).toEqual([]);
    expect(l.groupRegion).toEqual({});
  });

  test('normalize repairs shownGroups and groupRegion', () => {
    const l = normalizeLayout({
      shownGroups: [G1, G1, 'all', 5],
      groupRegion: { [G1]: ['se', 'UK', 'lang:EN', 'XX'], [G2]: [], bad: ['SE'], 'g:x': 'SE' },
    });
    expect(l.shownGroups).toEqual([G1]);
    expect(l.groupRegion).toEqual({ [G1]: ['SE', 'GB', 'lang:en'], [G2]: [] });
  });

  test('showGroups unhides and marks shown; unshowGroups returns to the rule; hideGroups clears shown', () => {
    let l = applyOps(emptyLayout(), [{ op: 'hideGroups', ids: [G1] }]).layout;
    const shown = applyOps(l, [{ op: 'showGroups', ids: [G1, G2] }]);
    expect(shown.layout.hiddenGroups).toEqual([]);
    expect(shown.layout.shownGroups).toEqual([G1, G2]);
    expect(shown.touched.sort()).toEqual([`hg:${G1}`, `sg:${G1}`, `sg:${G2}`].sort());
    l = shown.layout;
    const unshown = applyOps(l, [{ op: 'unshowGroups', ids: [G2] }]);
    expect(unshown.layout.shownGroups).toEqual([G1]);
    expect(unshown.touched).toEqual([`sg:${G2}`]);
    const hidden = applyOps(unshown.layout, [{ op: 'hideGroups', ids: [G1] }]);
    expect(hidden.layout.hiddenGroups).toEqual([G1]);
    expect(hidden.layout.shownGroups).toEqual([]);
    expect(hidden.touched.sort()).toEqual([`hg:${G1}`, `sg:${G1}`]);
    expect(applyOps(hidden.layout, [{ op: 'unshowGroups', ids: [G1] }]).changed).toBe(false);
  });

  test('setGroupRegion sets, clears and validates the override', () => {
    const set = applyOps(emptyLayout(), [{ op: 'setGroupRegion', id: G1, codes: ['dk', 'lang:en'] }]);
    expect(set.layout.groupRegion).toEqual({ [G1]: ['DK', 'lang:en'] });
    expect(set.touched).toEqual([`gr:${G1}`]);
    expect(applyOps(set.layout, [{ op: 'setGroupRegion', id: G1, codes: ['DK', 'lang:en'] }]).changed).toBe(false);
    const none = applyOps(set.layout, [{ op: 'setGroupRegion', id: G1, codes: [] }]);
    expect(none.layout.groupRegion).toEqual({ [G1]: [] });
    const cleared = applyOps(none.layout, [{ op: 'setGroupRegion', id: G1, codes: null }]);
    expect(cleared.layout.groupRegion).toEqual({});
    expect(applyOps(emptyLayout(), [{ op: 'setGroupRegion', id: 'all', codes: ['SE'] }]).rejected).toHaveLength(1);
    expect(applyOps(emptyLayout(), [{ op: 'setGroupRegion', id: G1, codes: ['Sweden'] }]).rejected).toHaveLength(1);
    expect(applyOps(emptyLayout(), [{ op: 'setGroupRegion', id: G1, codes: Array(11).fill('SE') }]).rejected).toHaveLength(1);
  });

  test('isLayoutOp knows the new ops', () => {
    expect(isLayoutOp({ op: 'showGroups', ids: [G1] })).toBe(true);
    expect(isLayoutOp({ op: 'unshowGroups', ids: [G1] })).toBe(true);
    expect(isLayoutOp({ op: 'setGroupRegion', id: G1, codes: ['SE'] })).toBe(true);
    expect(isLayoutOp({ op: 'setGroupRegion', id: G1, codes: null })).toBe(true);
    expect(isLayoutOp({ op: 'setGroupRegion', id: G1, codes: 'SE' })).toBe(false);
  });
});
