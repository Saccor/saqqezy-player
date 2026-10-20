import { describe, expect, test } from 'vitest';
import {
  GRID_Y, INFO_W, INFO_X, LIVE_PREVIEW_RECT, NO_LIVE_TEXT, hasNoLive, liveEmptyText, liveKey, liveTypedChar, locateFocus, sameCell, sameInfo,
  LIVE_POINTER_LABELS, liveMenuItems, liveOkAction, timeLeftLabel, INFO_TRACK, infoTimeLine, GROUPS_FAILED_TEXT, groupsRetryMs,
} from './liveLogic.ts';
import { TYPE } from '../../shell/theme.ts';

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
    expect(liveKey('rail', 'right', ctx)).toBe('grid');
    expect(liveKey('rail', 'right', { ...ctx, total: 0 })).toBe('groups');
    expect(liveKey('rail', 'back', ctx)).toBe('exit');
  });
  test('group dropdown', () => {
    expect(liveKey('groups', 'down', ctx)).toBe('grid');
    expect(liveKey('groups', 'left', ctx)).toBe('rail');
    expect(liveKey('groups', 'up', ctx)).toBe('groups');
    expect(liveKey('groups', 'back', ctx)).toBe('grid');
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
    expect(liveKey('grid', 'back', ctx)).toBe('rail');
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
  /** The estimate the track must clear: 0.6 em a character at meta size. */
  const textW = (s: string) => s.length * 0.6 * TYPE.meta;

  test("today's programme: the time range only, the track at its usual place", () => {
    expect(infoTimeLine(at(20, 20), at(20, 21, 30), now)).toEqual({ text: '20:00–21:30', trackX: INFO_TRACK.minX });
  });

  test('another day: the day label first, and the track after the longer text', () => {
    const y = infoTimeLine(at(19, 23), at(20, 1), now);
    expect(y.text).toBe('Yesterday · 23:00–01:00');
    expect(y.trackX).toBeGreaterThanOrEqual(textW(y.text) + 8);
    expect(infoTimeLine(at(21, 9), at(21, 10), now).text).toBe('Tomorrow · 09:00–10:00');
    const far = infoTimeLine(at(23, 9), at(23, 10), now);
    expect(far.text).toMatch(/^\w{3} 23 \w{3} · 09:00–10:00$/);
    expect(far.trackX).toBeGreaterThanOrEqual(textW(far.text) + 8);
  });

  test('the track and the longest time-left label still fit in the info block', () => {
    const y = infoTimeLine(at(19, 23), at(20, 1), now);
    expect(y.trackX + INFO_TRACK.w + INFO_TRACK.gap + textW('1 h 59 min left')).toBeLessThanOrEqual(INFO_W);
  });
});
