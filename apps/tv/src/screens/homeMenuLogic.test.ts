import { describe, expect, it } from 'vitest';
import { MAX_LISTS as CORE_MAX_LISTS, NAME_MAX as CORE_NAME_MAX } from '@iptv/core';
import {
  MAX_LISTS, NAME_MAX, buildChannelMenu, emptyGroupText, focusAfterRefresh, limitTyping, listIdOfGroup, newListId,
  pickerRows, renameOutcome, validateListName, validateRename,
} from './homeMenuLogic.ts';

const lists = [
  { id: 'fav', name: 'Favourites' },
  { id: 'l-abc', name: 'Evening' },
];

describe('limits mirror core', () => {
  it('uses the same NAME_MAX and MAX_LISTS as the layout reducer', () => {
    expect(NAME_MAX).toBe(CORE_NAME_MAX);
    expect(MAX_LISTS).toBe(CORE_MAX_LISTS);
  });
});

describe('buildChannelMenu', () => {
  const actions = (m: { action: string }[]) => m.map((i) => i.action);
  const base = { isHidden: false, isFavourite: false, lists };

  it('outside a list: quick favourite first, then add, hide, rename, cancel', () => {
    const m = buildChannelMenu(base);
    expect(actions(m)).toEqual(['toggleFavourite', 'addToList', 'hide', 'rename', 'cancel']);
    expect(m.map((i) => i.label))
      .toEqual(['Add to favourites', 'Add to list…', 'Hide channel', 'Rename…', 'Cancel']);
  });

  it('a favourite offers "Remove from favourites" as the first item', () => {
    const m = buildChannelMenu({ ...base, isFavourite: true });
    expect(m[0]).toEqual({ action: 'toggleFavourite', label: 'Remove from favourites' });
  });

  it('inside a list: adds "Remove from" with the list name after Add to list', () => {
    const m = buildChannelMenu({ ...base, inListId: 'l-abc' });
    expect(actions(m)).toEqual(['toggleFavourite', 'addToList', 'removeFromList', 'hide', 'rename', 'cancel']);
    expect(m[2]?.label).toBe('Remove from "Evening"');
  });

  it('inside Favourites the quick item already removes it: no second "Remove from"', () => {
    const m = buildChannelMenu({ ...base, inListId: 'fav', isFavourite: true });
    expect(actions(m)).toEqual(['toggleFavourite', 'addToList', 'hide', 'rename', 'cancel']);
    expect(m[0]?.label).toBe('Remove from favourites');
  });

  it('a hidden channel offers Show instead of Hide', () => {
    expect(actions(buildChannelMenu({ ...base, isHidden: true })))
      .toEqual(['toggleFavourite', 'addToList', 'unhide', 'rename', 'cancel']);
    expect(buildChannelMenu({ ...base, isHidden: true })[2]?.label).toBe('Show channel');
    expect(actions(buildChannelMenu({ ...base, inListId: 'l-abc', isHidden: true })))
      .toEqual(['toggleFavourite', 'addToList', 'removeFromList', 'unhide', 'rename', 'cancel']);
  });

  it('an unknown list id (deleted meanwhile) has no Remove item', () => {
    expect(actions(buildChannelMenu({ ...base, inListId: 'l-gone' })))
      .toEqual(['toggleFavourite', 'addToList', 'hide', 'rename', 'cancel']);
  });

  it('never puts two spaces in a label', () => {
    const m = buildChannelMenu({ ...base, inListId: 'l-abc', lists: [{ id: 'l-abc', name: 'A  B' }] });
    for (const i of m) expect(i.label).not.toMatch(/ {2}/);
  });
});

describe('listIdOfGroup', () => {
  it('maps list group ids to list ids', () => {
    expect(listIdOfGroup('fav')).toBe('fav');
    expect(listIdOfGroup('list:l-abc')).toBe('l-abc');
    expect(listIdOfGroup('all')).toBeUndefined();
    expect(listIdOfGroup('recent')).toBeUndefined();
    expect(listIdOfGroup('g:News')).toBeUndefined();
    expect(listIdOfGroup(undefined)).toBeUndefined();
  });
});

describe('pickerRows', () => {
  it('lists with membership checks, then New list…', () => {
    const rows = pickerRows(lists, new Set(['l-abc']));
    expect(rows).toEqual([
      { kind: 'list', id: 'fav', label: 'Favourites', checked: false },
      { kind: 'list', id: 'l-abc', label: 'Evening', checked: true },
      { kind: 'new', label: 'New list…' },
    ]);
  });

  it('omits New list… at the list limit', () => {
    const many = Array.from({ length: MAX_LISTS }, (_, i) => ({ id: `l-${i}`, name: `L${i}` }));
    const rows = pickerRows(many, new Set());
    expect(rows).toHaveLength(MAX_LISTS);
    expect(rows.some((r) => r.kind === 'new')).toBe(false);
  });
});

describe('newListId', () => {
  it('is l- plus a short base36 string accepted by the layout reducer', () => {
    const id = newListId(new Set(), () => 0.123456789);
    expect(id).toMatch(/^l-[a-z0-9]{1,10}$/);
    expect(id).toMatch(/^[a-z0-9-]{1,32}$/);
  });

  it('avoids existing ids', () => {
    const seq = [0.5, 0.5, 0.25];
    const first = newListId(new Set(), () => 0.5);
    const id = newListId(new Set([first]), () => seq.shift() ?? 0.75);
    expect(id).not.toBe(first);
    expect(id).toMatch(/^l-[a-z0-9]+$/);
  });

  it('never returns a bare prefix when the random number is 0', () => {
    expect(newListId(new Set(), () => 0)).toMatch(/^l-[a-z0-9]+$/);
  });
});

describe('validateListName', () => {
  it('trims and accepts 1..NAME_MAX characters', () => {
    expect(validateListName('  Evening ')).toEqual({ ok: true, name: 'Evening' });
    expect(validateListName('x'.repeat(NAME_MAX))).toEqual({ ok: true, name: 'x'.repeat(NAME_MAX) });
  });

  it('rejects empty and too long names', () => {
    expect(validateListName('   ')).toEqual({ ok: false, message: 'Enter a name for the list.' });
    expect(validateListName('x'.repeat(NAME_MAX + 1)))
      .toEqual({ ok: false, message: `Use at most ${NAME_MAX} characters.` });
  });
});

describe('validateRename', () => {
  it('an empty result clears the override', () => {
    expect(validateRename('  ')).toEqual({ ok: true, name: null });
    expect(validateRename('')).toEqual({ ok: true, name: null });
  });

  it('trims and caps at NAME_MAX', () => {
    expect(validateRename(' My channel ')).toEqual({ ok: true, name: 'My channel' });
    expect(validateRename('x'.repeat(NAME_MAX + 1)).ok).toBe(false);
  });
});

describe('renameOutcome', () => {
  it('unchanged (after trimming) is a no-op', () => {
    expect(renameOutcome('Channel 1', 'Channel 1')).toEqual({ kind: 'unchanged' });
    expect(renameOutcome('  Channel 1 ', 'Channel 1')).toEqual({ kind: 'unchanged' });
  });

  it('an unchanged long name is a no-op, not an error', () => {
    const long = 'x'.repeat(NAME_MAX + 10);
    expect(renameOutcome(long, long)).toEqual({ kind: 'unchanged' });
  });

  it('a new name is applied, trimmed', () => {
    expect(renameOutcome(' My channel ', 'Channel 1')).toEqual({ kind: 'apply', name: 'My channel' });
  });

  it('empty restores the original name', () => {
    expect(renameOutcome('  ', 'Channel 1')).toEqual({ kind: 'apply', name: null });
  });

  it('a changed name over NAME_MAX is an error shown on Done', () => {
    expect(renameOutcome('y'.repeat(NAME_MAX + 1), 'Channel 1'))
      .toEqual({ kind: 'error', message: `Use at most ${NAME_MAX} characters.` });
  });
});

describe('limitTyping', () => {
  it('accepts edits up to NAME_MAX characters', () => {
    expect(limitTyping('abc', 'abcd')).toBe('abcd');
    expect(limitTyping('x'.repeat(NAME_MAX - 1), 'x'.repeat(NAME_MAX))).toBe('x'.repeat(NAME_MAX));
  });

  it('refuses growth past NAME_MAX', () => {
    expect(limitTyping('x'.repeat(NAME_MAX), 'x'.repeat(NAME_MAX + 1))).toBe('x'.repeat(NAME_MAX));
  });

  it('a prefilled name over NAME_MAX is kept in full and can be shortened', () => {
    const long = 'x'.repeat(NAME_MAX + 10);
    expect(limitTyping(long, long.slice(0, -1))).toBe(long.slice(0, -1));
    expect(limitTyping(long, `${long}y`)).toBe(long);
  });
});

describe('focusAfterRefresh', () => {
  it('follows the channel to its new row', () => {
    expect(focusAfterRefresh(7, 3, 10)).toBe(7);
  });

  it('the channel left the group: the next row takes its place', () => {
    expect(focusAfterRefresh(-1, 3, 9)).toBe(3);
  });

  it('the last row left: focus the new last row', () => {
    expect(focusAfterRefresh(-1, 9, 9)).toBe(8);
  });

  it('the group is now empty', () => {
    expect(focusAfterRefresh(-1, 0, 0)).toBe(0);
  });

  it('clamps a found index past the end', () => {
    expect(focusAfterRefresh(12, 3, 10)).toBe(9);
  });
});

describe('emptyGroupText', () => {
  it('user lists explain how to add channels', () => {
    expect(emptyGroupText('list:l-abc')).toBe('Empty – add channels from the channel menu');
    expect(emptyGroupText('fav')).toBe('Empty – add channels from the channel menu');
  });

  it('other groups use the default text', () => {
    expect(emptyGroupText('all')).toBe('No channels here yet.');
    expect(emptyGroupText(undefined)).toBe('No channels here yet.');
  });
});
