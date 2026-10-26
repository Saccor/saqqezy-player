import { describe, expect, test } from 'vitest';
import {
  GRID_Y, INFO_W, INFO_X, LIVE_PREVIEW_RECT, NO_LIVE_TEXT, hasNoLive, liveEmptyText, liveKey, liveTypedChar, locateFocus, sameCell, sameInfo,
  LIVE_POINTER_LABELS, liveMenuItems, liveOkAction, timeLeftLabel, infoTimeLine, GROUPS_FAILED_TEXT, groupsRetryMs, livePlaceOnOpen, liveChannelLine, liveProgramme,
} from './liveLogic.ts';

describe('LIVE_POINTER_LABELS', () => {
  test('uses the spec copy', () => {
    expect(LIVE_POINTER_LABELS).toEqual({ earlier: '‹ Earlier', later: 'Later ›', search: '⌕ Search', settings: '⚙ Settings' });
  });
});

describe('liveLogic layout', () => {
  test('preview, info and grid positions', () => {
    expect(LIVE_PREVIEW_RECT).toEqual({ x: 160, y: 54, w: 416, h: 234 });
    expect(INFO_X).toBe(616);
    expect(INFO_X + INFO_W).toBe(1380);
    expect(GRID_Y).toBe(312);
  });
});

describe('liveKey', () => {
  const ctx = { row: 3, total: 50, hasGroups: true };
  test('rail', () => {
    expect(liveKey('rail', 'right', ctx)).toBe('channels');
    expect(liveKey('rail', 'right', { ...ctx, total: 0 })).toBe('groups');
    expect(liveKey('rail', 'back', ctx)).toBe('exit');
  });
  test('group dropdown', () => {
    expect(liveKey('groups', 'down', ctx)).toBe('channels');
    expect(liveKey('groups', 'left', ctx)).toBe('rail');
    expect(liveKey('groups', 'up', ctx)).toBe('groups');
    expect(liveKey('groups', 'back', ctx)).toBe('channels');
    expect(liveKey('groups', 'back', { ...ctx, total: 0 })).toBe('rail');
  });
  test('channel column', () => {
    expect(liveKey('channels', 'left', ctx)).toBe('rail');
    expect(liveKey('channels', 'right', ctx)).toBe('grid');
    expect(liveKey('channels', 'up', { ...ctx, row: 0 })).toBe('groups');
    expect(liveKey('channels', 'up', ctx)).toBe('move');
    expect(liveKey('channels', 'down', ctx)).toBe('move');
    expect(liveKey('channels', 'back', ctx)).toBe('rail');
  });
  test('grid', () => {
    expect(liveKey('grid', 'up', { ...ctx, row: 0 })).toBe('groups');
    expect(liveKey('grid', 'up', ctx)).toBe('move');
    expect(liveKey('grid', 'left', ctx)).toBe('move');
    expect(liveKey('grid', 'back', ctx)).toBe('channels');
  });
  test('empty list with focus in the grid: focus goes to the groups or the rail', () => {
    for (const place of ['grid', 'channels'] as const) {
      const withGroups = { row: 0, total: 0, hasGroups: true };
      const noGroups = { row: 0, total: 0, hasGroups: false };
      for (const key of ['up', 'down', 'right'] as const) {
        expect(liveKey(place, key, withGroups), `${place} ${key}`).toBe('groups');
        expect(liveKey(place, key, noGroups), `${place} ${key}`).toBe('rail');
      }
      expect(liveKey(place, 'left', withGroups)).toBe('rail');
      expect(liveKey(place, 'left', noGroups)).toBe('rail');
      expect(liveKey(place, 'back', withGroups)).toBe('rail');
      expect(liveKey(place, 'back', noGroups)).toBe('rail');
    }
  });
  test('Up on row 0 reaches the dropdown from the grid and the channel column', () => {
    for (const place of ['grid', 'channels'] as const) expect(liveKey(place, 'up', { ...ctx, row: 0 })).toBe('groups');
  });
  test('no groups: Up from the top row stays', () => {
    expect(liveKey('grid', 'up', { row: 0, total: 5, hasGroups: false })).toBe('move');
  });
});

describe('liveOkAction', () => {
  const base = { channelId: 'c1', onAir: true, archive: 'none' as const };
  test('on air: preview first, fullscreen when it already plays or was requested', () => {
    expect(liveOkAction(base)).toBe('preview');
    expect(liveOkAction({ ...base, playingId: 'c1' })).toBe('fullscreen');
    expect(liveOkAction({ ...base, requestedId: 'c1' })).toBe('fullscreen');
    expect(liveOkAction({ ...base, playingId: 'c2' })).toBe('preview');
  });
  test('past with catch-up opens it; otherwise details', () => {
    expect(liveOkAction({ ...base, onAir: false, archive: 'available' })).toBe('catchup');
    expect(liveOkAction({ ...base, onAir: false })).toBe('details');
  });
});

describe('timeLeftLabel', () => {
  const now = 1_000_000_000_000;
  test('minutes, rounded up, and hours', () => {
    expect(timeLeftLabel(now + 12 * 60_000, now)).toBe('12 min left');
    expect(timeLeftLabel(now + 11 * 60_000 + 1, now)).toBe('12 min left');
    expect(timeLeftLabel(now + 65 * 60_000, now)).toBe('1 h 5 min left');
    expect(timeLeftLabel(now + 120 * 60_000, now)).toBe('2 h left');
    expect(timeLeftLabel(now - 1, now)).toBe('');
  });
});

describe('liveMenuItems', () => {
  const channel = { isHidden: false, isFavourite: false, lists: [] };
  test('programme items first, then the channel items', () => {
    const items = liveMenuItems({ channel, fromStart: true, goToDay: true });
    expect(items.slice(0, 2).map((i) => i.action)).toEqual(['fromStart', 'goToDay']);
    expect(items.map((i) => i.action)).toContain('toggleFavourite');
    expect(items[items.length - 1]!.action).toBe('cancel');
  });
  test('no programme items when neither applies', () => {
    expect(liveMenuItems({ channel, fromStart: false, goToDay: false })[0]!.action).toBe('toggleFavourite');
  });
  test('Add to multiview comes after the programme items where this device can play 2 or more', () => {
    const items = liveMenuItems({ channel, fromStart: true, goToDay: false, multiview: true });
    expect(items.slice(0, 2)).toEqual([{ action: 'fromStart', label: 'From the start' }, { action: 'addToMultiview', label: 'Add to multiview' }]);
    expect(liveMenuItems({ channel, fromStart: false, goToDay: false }).map((i) => i.action)).not.toContain('addToMultiview');
  });
  test('OK opens the menu with Watch first, then Preview when asked', () => {
    const items = liveMenuItems({ channel, fromStart: true, goToDay: false, watch: true, preview: true });
    expect(items.slice(0, 3).map((i) => i.action)).toEqual(['watch', 'preview', 'fromStart']);
    expect(items[0]!.label).toBe('Watch');
    expect(items[1]!.label).toBe('Preview');
    expect(liveMenuItems({ channel, fromStart: false, goToDay: false, watch: true }).map((i) => i.action))
      .not.toContain('preview');
    expect(liveMenuItems({ channel, fromStart: false, goToDay: false }).map((i) => i.action)).not.toContain('watch');
  });
  test('a combined channel offers Choose source', () => {
    expect(liveMenuItems({ channel: { ...channel, sources: 4 }, fromStart: false, goToDay: false }).map((i) => i.action))
      .toContain('chooseSource');
    expect(liveMenuItems({ channel, fromStart: false, goToDay: false }).map((i) => i.action)).not.toContain('chooseSource');
  });
});

describe('sameInfo', () => {
  const ch = { id: 'c1', number: 1, name: 'One' };
  const block = { start: 10, stop: 20, title: 'T', desc: 'D', filler: false };
  test('rebuilt objects with the same content are equal', () => {
    expect(sameInfo({ channel: { ...ch }, block: { ...block } }, { channel: { ...ch }, block: { ...block } })).toBe(true);
    expect(sameInfo(undefined, undefined)).toBe(true);
  });
  test('another channel, block or text is a change', () => {
    expect(sameInfo({ channel: ch, block }, { channel: { ...ch, id: 'c2' }, block })).toBe(false);
    expect(sameInfo({ channel: ch, block }, { channel: { ...ch, name: 'Renamed' }, block })).toBe(false);
    expect(sameInfo({ channel: ch, block }, { channel: { ...ch, sourceCount: 3 }, block })).toBe(false);
    expect(sameInfo({ channel: { ...ch, sourceCount: 3 }, block }, { channel: { ...ch, sourceCount: 3, quality: '4K' }, block }))
      .toBe(false);
    expect(sameInfo({ channel: ch, block }, { channel: ch, block: { ...block, start: 11 } })).toBe(false);
    expect(sameInfo({ channel: ch, block }, { channel: ch, block: { ...block, desc: 'More' } })).toBe(false);
    expect(sameInfo({ channel: ch, block }, { channel: ch })).toBe(false);
    expect(sameInfo({ channel: ch }, undefined)).toBe(false);
  });
  test('without a block, the row now/next counts', () => {
    const now = { title: 'N', start: 1, stop: 2 };
    expect(sameInfo({ channel: { ...ch, now } }, { channel: { ...ch, now: { ...now } } })).toBe(true);
    expect(sameInfo({ channel: { ...ch, now } }, { channel: { ...ch, now: { ...now, title: 'M' } } })).toBe(false);
  });
});

describe('locateFocus', () => {
  const groups = [{ id: 'all', name: 'All', count: 100 }, { id: 'news', name: 'News', count: 10 }];
  /** news holds the `n` ids, all holds every id; the index is the id's number. */
  const lookup = () => {
    const calls: [string, string][] = [];
    const indexOf = async (g: string, id: string) => {
      calls.push([g, id]);
      return g === 'all' || id.startsWith('n') ? Number(id.slice(1)) : -1;
    };
    return { calls, indexOf };
  };

  test('cold start: one lookup when the pinned channel is in the group', async () => {
    const l = lookup();
    expect(await locateFocus({ groups, prefer: 'news', pinned: [undefined, 'n4'], others: ['n4', 'n7'], indexOf: l.indexOf }))
      .toEqual({ g: 'news', index: 4 });
    expect(l.calls).toEqual([['news', 'n4']]);
  });

  test('a pinned (playing) channel outside the group switches to All', async () => {
    const l = lookup();
    expect(await locateFocus({ groups, prefer: 'news', pinned: ['x42'], others: [], indexOf: l.indexOf }))
      .toEqual({ g: 'all', index: 42 });
    expect(l.calls).toEqual([['news', 'x42'], ['all', 'x42']]);
  });

  test('a remembered or last channel outside the group keeps the group at row 0', async () => {
    const l = lookup();
    expect(await locateFocus({ groups, prefer: 'news', pinned: [], others: ['x42', 'x7'], indexOf: l.indexOf }))
      .toEqual({ g: 'news', index: 0 });
    expect(l.calls).toEqual([['news', 'x42'], ['news', 'x7']]);
  });

  test('falls back to the next candidate and skips duplicates', async () => {
    const l = lookup();
    expect(await locateFocus({ groups, prefer: 'news', pinned: [], others: ['x1', 'x1', 'n3'], indexOf: l.indexOf }))
      .toEqual({ g: 'news', index: 3 });
    expect(l.calls).toEqual([['news', 'x1'], ['news', 'n3']]);
  });

  test('the remembered row is the fallback when the remembered channel left the group (clamped to its count)', async () => {
    const l = lookup();
    expect(await locateFocus({ groups, prefer: 'news', pinned: [], others: ['x1'], fallbackRow: 6, indexOf: l.indexOf }))
      .toEqual({ g: 'news', index: 6 });
    expect(await locateFocus({ groups, prefer: 'news', pinned: [], others: ['x1'], fallbackRow: 25, indexOf: l.indexOf }))
      .toEqual({ g: 'news', index: 9 });
    // Only for the preferred group: one that is gone falls back to All at row 0.
    expect(await locateFocus({ groups, prefer: 'gone', pinned: [], others: ['x1'], fallbackRow: 6, indexOf: async () => -1 }))
      .toEqual({ g: 'all', index: 0 });
  });

  test('no groups: nothing to open', async () => {
    const l = lookup();
    expect(await locateFocus({ groups: [], prefer: undefined, pinned: ['a'], others: [], indexOf: l.indexOf }))
      .toEqual({ g: undefined, index: 0 });
    expect(l.calls).toEqual([]);
  });
});

describe('liveTypedChar', () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
    ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });
  test('letters and digits hand off to Search', () => {
    expect(liveTypedChar(key('a'))).toBe('a');
    expect(liveTypedChar(key('B'))).toBe('B');
    expect(liveTypedChar(key('7'))).toBe('7');
    expect(liveTypedChar(key('ö'))).toBe('ö');
  });
  test('keys the remote uses (m Menu, i Info), symbols, space and named keys stay remote keys', () => {
    for (const k of ['m', 'M', 'i', 'I', ' ', '-', '.', 'Enter', 'Backspace', 'ArrowUp', 'F3', 'Escape']) {
      expect(liveTypedChar(key(k))).toBeUndefined();
    }
  });
  test('shortcuts never type', () => {
    expect(liveTypedChar(key('a', { ctrlKey: true }))).toBeUndefined();
    expect(liveTypedChar(key('a', { metaKey: true }))).toBeUndefined();
    expect(liveTypedChar(key('a', { altKey: true }))).toBeUndefined();
  });
});

describe('empty states', () => {
  test('the first load waits, with the progress count', () => {
    expect(liveEmptyText({ waiting: true, allCount: 0, groupId: 'all' })).toBe('Loading channels…');
    expect(liveEmptyText({ waiting: true, progressCount: 120, allCount: 0, groupId: 'all' })).toBe('Loading channels… 120');
  });
  test('a source without live channels', () => {
    expect(NO_LIVE_TEXT).toBe('This source has no live channels. Movies and series are in the menu on the left.');
    expect(liveEmptyText({ waiting: false, allCount: 0, groupId: undefined })).toBe(NO_LIVE_TEXT);
    expect(liveEmptyText({ waiting: false, allCount: 0, groupId: 'news' })).toBe(NO_LIVE_TEXT);
    expect(hasNoLive({ waiting: false, allCount: 0 })).toBe(true);
    expect(hasNoLive({ waiting: true, allCount: 0 })).toBe(false);
    expect(hasNoLive({ waiting: false, allCount: 3 })).toBe(false);
  });
  test('the first read of the groups failed: not "no live channels", but a retry note', () => {
    expect(hasNoLive({ waiting: false, allCount: 0, failed: true })).toBe(false);
    expect(liveEmptyText({ waiting: false, failed: true, allCount: 0, groupId: undefined })).toBe(GROUPS_FAILED_TEXT);
    expect(GROUPS_FAILED_TEXT).toBe('Could not read the channels. Trying again…');
    // Loading wins: the channels are on their way.
    expect(liveEmptyText({ waiting: true, failed: true, allCount: 0, groupId: undefined })).toBe('Loading channels…');
  });
  test('the groups are read again with a growing delay, at most once a minute', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(groupsRetryMs)).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  });
  test('an empty group or list', () => {
    expect(liveEmptyText({ waiting: false, allCount: 5, groupId: 'news' })).toBe('No channels here yet.');
    expect(liveEmptyText({ waiting: false, allCount: 5, groupId: 'list:abc' })).toBe('Empty – add channels from the channel menu');
  });
});

describe('sameCell', () => {
  const focus = { row: 3, place: 'grid' as const, focusStart: 1000 };
  test('the focused programme', () => {
    expect(sameCell({ area: 'grid', row: 3, start: 1000 }, focus)).toBe(true);
    expect(sameCell({ area: 'grid', row: 3, start: 2000 }, focus)).toBe(false);
    expect(sameCell({ area: 'grid', row: 4, start: 1000 }, focus)).toBe(false);
    expect(sameCell({ area: 'grid', row: 3, start: 1000 }, { ...focus, place: 'channels' })).toBe(false);
  });
  test('the focused channel cell', () => {
    expect(sameCell({ area: 'channels', row: 3 }, { ...focus, place: 'channels' })).toBe(true);
    expect(sameCell({ area: 'channels', row: 3 }, focus)).toBe(false);
    expect(sameCell({ area: 'channels', row: 2 }, { ...focus, place: 'channels' })).toBe(false);
  });
});

describe('infoTimeLine', () => {
  const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime();
  const now = at(20, 0, 30);

  test("today's programme: the time range only", () => {
    expect(infoTimeLine(at(20, 20), at(20, 21, 30), now)).toBe('20:00–21:30');
  });

  test('another day: the day label first', () => {
    expect(infoTimeLine(at(19, 23), at(20, 1), now)).toBe('Yesterday · 23:00–01:00');
    expect(infoTimeLine(at(21, 9), at(21, 10), now)).toBe('Tomorrow · 09:00–10:00');
    expect(infoTimeLine(at(23, 9), at(23, 10), now)).toMatch(/^\w{3} 23 \w{3} · 09:00–10:00$/);
  });
});

describe('livePlaceOnOpen', () => {
  test('channels first; a target or a return from catch-up opens on the grid', () => {
    expect(livePlaceOnOpen({ hasTarget: false, fromCatchup: false })).toBe('channels');
    expect(livePlaceOnOpen({ hasTarget: true, fromCatchup: false })).toBe('grid');
    expect(livePlaceOnOpen({ hasTarget: false, fromCatchup: true })).toBe('grid');
    expect(livePlaceOnOpen({ hasTarget: true, fromCatchup: true })).toBe('grid');
  });
});

describe('liveProgramme and liveChannelLine (the focused programme block)', () => {
  const ch = { id: 'c1', number: 7, name: 'Demo News', group: 'g', favourite: false, now: { title: 'Row now', start: 0, stop: 10 } };
  const block = { start: 0, stop: 10, title: 'Block now', filler: false };
  test('a real block wins over the row now', () => {
    expect(liveProgramme(block, ch)?.title).toBe('Block now');
  });
  test('a filler block counts as none', () => {
    expect(liveProgramme({ ...block, filler: true }, ch)).toBeUndefined();
  });
  test('no block falls back to the channel now', () => {
    expect(liveProgramme(undefined, ch)?.title).toBe('Row now');
    expect(liveProgramme(undefined, { ...ch, now: undefined })).toBeUndefined();
  });
  test('the channel line: number and name, plus sources for a combined channel; empty with no channel', () => {
    expect(liveChannelLine(ch)).toBe('7 · Demo News');
    expect(liveChannelLine({ ...ch, sourceCount: 3, quality: '4K' })).toBe('7 · Demo News · 4K · 3 sources');
    expect(liveChannelLine(undefined)).toBe('');
  });
});
