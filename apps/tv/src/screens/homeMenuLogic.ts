/**
 * Pure helpers for Live TV's channel menu, list picker and refresh focus (unit-tested).
 *
 * `NAME_MAX` and `MAX_LISTS` mirror the layout reducer's limits in `@iptv/core`. They are copied rather than
 * imported because core must stay out of the main-thread bundle (it lives in the worker chunk); the test
 * asserts they are equal to core's.
 */

import { favToggleLabel, SOURCE_COPY } from '../copy.ts';

export const NAME_MAX = 60;
export const MAX_LISTS = 50;

const FAV_LIST_ID = 'fav';
const LIST_PREFIX = 'list:';

export type ChannelMenuAction =
  | 'toggleFavourite' | 'addToList' | 'chooseSource' | 'removeFromList' | 'hide' | 'unhide' | 'rename' | 'cancel';
export interface MenuItem { action: ChannelMenuAction; label: string }
export interface ListLite { id: string; name: string }

/** Collapses runs of whitespace: canvas text measures repeated spaces as one and clips the label. */
const oneSpace = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * The channel menu. The first item adds the channel to Favourites (or removes it) in one step. "Remove from"
 * appears only while the user browses a list (`inListId`) that still exists, and not in Favourites, where the
 * first item already removes it. A hidden channel offers "Show channel" instead of "Hide channel". A combined
 * channel (`sources` > 1) offers "Choose source…".
 */
export function buildChannelMenu(o: {
  inListId?: string; isHidden: boolean; isFavourite: boolean; lists: readonly ListLite[]; sources?: number;
}): MenuItem[] {
  const items: MenuItem[] = [
    { action: 'toggleFavourite', label: favToggleLabel(o.isFavourite) },
    { action: 'addToList', label: 'Add to list…' },
  ];
  if (o.sources !== undefined && o.sources > 1) items.push({ action: 'chooseSource', label: `${SOURCE_COPY.choose}…` });
  const list = o.inListId === undefined || o.inListId === FAV_LIST_ID ? undefined
    : o.lists.find((l) => l.id === o.inListId);
  if (list) items.push({ action: 'removeFromList', label: oneSpace(`Remove from "${list.name}"`) });
  items.push(o.isHidden ? { action: 'unhide', label: 'Show channel' } : { action: 'hide', label: 'Hide channel' });
  items.push({ action: 'rename', label: 'Rename…' }, { action: 'cancel', label: 'Cancel' });
  return items;
}

/** The list id behind a browsable group id ('fav' or 'list:<id>'), else undefined. */
export function listIdOfGroup(groupId: string | undefined): string | undefined {
  if (groupId === FAV_LIST_ID) return FAV_LIST_ID;
  if (groupId?.startsWith(LIST_PREFIX)) return groupId.slice(LIST_PREFIX.length) || undefined;
  return undefined;
}

export type PickerRow =
  | { kind: 'list'; id: string; label: string; checked: boolean; /** Shown in the footer while the row is selected. */ help?: string }
  | { kind: 'new'; label: string };

/** Picker rows: every list (checked when it holds the channel), then "New list…" while under the limit. */
export function pickerRows(lists: readonly ListLite[], member: ReadonlySet<string>): PickerRow[] {
  const rows: PickerRow[] = lists.map((l) => ({ kind: 'list', id: l.id, label: oneSpace(l.name), checked: member.has(l.id) }));
  if (lists.length < MAX_LISTS) rows.push({ kind: 'new', label: 'New list…' });
  return rows;
}

/** A fresh list id: `l-` plus a short base36 string, not in `taken`. Matches the reducer's `[a-z0-9-]{1,32}`. */
export function newListId(taken: ReadonlySet<string>, rand: () => number = Math.random): string {
  for (let i = 0; i < 20; i++) {
    const id = `l-${(Math.floor(rand() * 36 ** 8) + i).toString(36)}`;
    if (!taken.has(id)) return id;
  }
  // 20 collisions in a row: fall back to a time-based suffix.
  return `l-${Date.now().toString(36)}`;
}

export type NameResult<T> = { ok: true; name: T } | { ok: false; message: string };

const tooLong = (): { ok: false; message: string } => ({ ok: false, message: `Use at most ${NAME_MAX} characters.` });

/** A list name: trimmed, 1..NAME_MAX characters. */
export function validateListName(raw: string): NameResult<string> {
  const t = raw.trim();
  if (t.length === 0) return { ok: false, message: 'Enter a name for the list.' };
  if (t.length > NAME_MAX) return tooLong();
  return { ok: true, name: t };
}

/** A channel rename: trimmed, at most NAME_MAX characters; empty clears the override (`null`). */
export function validateRename(raw: string): NameResult<string | null> {
  const t = raw.trim();
  if (t.length === 0) return { ok: true, name: null };
  if (t.length > NAME_MAX) return tooLong();
  return { ok: true, name: t };
}

export type RenameOutcome =
  | { kind: 'unchanged' }
  | { kind: 'apply'; name: string | null }
  | { kind: 'error'; message: string };

/**
 * Keyboard Done on "Rename…": nothing to do when the trimmed text equals the channel's current display name
 * (also for a long playlist name over NAME_MAX), else `validateRename`.
 */
export function renameOutcome(raw: string, current: string): RenameOutcome {
  const t = raw.trim();
  if (t === current || t === current.trim()) return { kind: 'unchanged' };
  const v = validateRename(raw);
  return v.ok ? { kind: 'apply', name: v.name } : { kind: 'error', message: v.message };
}

/**
 * Keyboard edits: typing stops at NAME_MAX characters, but a longer prefilled name is shown in full and can
 * still be shortened (it is validated on Done).
 */
export function limitTyping(prev: string, next: string): string {
  return next.length > NAME_MAX && next.length > prev.length ? prev : next;
}

/**
 * Row to focus after a layout change re-read the group: the channel's new row when it is still there
 * (`found >= 0`), else the row it was on (now holding its neighbour), clamped to the shorter list.
 */
export function focusAfterRefresh(found: number, oldIndex: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(found >= 0 ? found : oldIndex, total - 1));
}

/** Text for an empty group: user lists say how to fill them. */
export function emptyGroupText(groupId: string | undefined): string {
  return listIdOfGroup(groupId) !== undefined ? 'Empty – add channels from the channel menu' : 'No channels here yet.';
}
