import { describe, expect, test } from 'vitest';
import { GRID_Y, INFO_W, INFO_X, LIVE_PREVIEW_RECT, liveKey, locateFocus, sameInfo, liveMenuItems, liveOkAction, timeLeftLabel } from './liveLogic.ts';

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

  test('no groups: nothing to open', async () => {
    const l = lookup();
    expect(await locateFocus({ groups: [], prefer: undefined, pinned: ['a'], others: [], indexOf: l.indexOf }))
      .toEqual({ g: undefined, index: 0 });
    expect(l.calls).toEqual([]);
  });
});
