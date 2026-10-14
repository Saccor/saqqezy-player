import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { AppEvent, ChannelRow, ListSummary } from '@iptv/app-api';
import type { GroupInfo, LayoutOp } from '@iptv/core';
import type { Rect } from '@iptv/player';
import { api, onEvent } from '../api.ts';
import { ChannelList, ROW_H } from '../components/ChannelList.tsx';
import { ContextMenu } from '../components/ContextMenu.tsx';
import { GroupList } from '../components/GroupList.tsx';
import { Keyboard, KEYBOARD_H, KEYBOARD_W } from '../components/Keyboard.tsx';
import { ListPicker } from '../components/ListPicker.tsx';
import { PREVIEW_H, PREVIEW_W, PreviewPanel } from '../components/PreviewPanel.tsx';
import { moveFocus, pageFocus, renderRange, scrollTopFor } from '../components/virtualWindow.ts';
import { createDebounce } from '../playback/debounce.ts';
import { playback, previewHold } from '../playback/playback.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { showToast } from '../shell/Toast.tsx';
import { WORDMARK_ZONE_X } from '../shell/Wordmark.tsx';
import { companionStatus, markStartup } from '../state/appState.ts';
import { panelChannel, pickGroup, playingInfoStale, resolveFocus, restoreIndex } from './homeLogic.ts';
import {
  buildChannelMenu, emptyGroupText, focusAfterRefresh, limitTyping, listIdOfGroup, newListId, pickerRows,
  renameOutcome, validateListName, type ChannelMenuAction, type ListLite, type MenuItem, type PickerRow,
} from './homeMenuLogic.ts';
import { showPhoneBadge } from './pairingLogic.ts';
import { SliceCache } from './sliceCache.ts';

// Layout A: groups 22 % | channel list | preview 34 % of the safe width.
const SAFE_W = LAYOUT.width - LAYOUT.safeX * 2;
const GROUP_X = LAYOUT.safeX;
const GROUP_W = Math.round(SAFE_W * 0.22);
const PREVIEW_X = LAYOUT.width - LAYOUT.safeX - PREVIEW_W;
const LIST_X = GROUP_X + GROUP_W + LAYOUT.gap;
const LIST_W = PREVIEW_X - LAYOUT.gap - LIST_X;
const HEAD_Y = 110;
const BODY_Y = 170;
const LIST_ROWS = 9;
const LIST_H = LIST_ROWS * ROW_H;
const HINT_Y = LAYOUT.height - LAYOUT.safeY - 34;
/** Home's preview box; also where opaque screens park a fullscreen video they cover (see Search). */
export const PREVIEW_RECT: Rect = { x: PREVIEW_X, y: BODY_Y, w: PREVIEW_W, h: PREVIEW_H };
const PREVIEW_DELAY_MS = 700;
const MENU_ID = 'contextMenu';
const PICKER_ID = 'listPicker';
const KEYBOARD_ID = 'keyboard';
const GROUP_ALL = 'all';
const FAV_LIST_ID = 'fav';

type Progress = Extract<AppEvent, { type: 'progress' }>;
type LayoutChanged = Extract<AppEvent, { type: 'layoutChanged' }>;

/** The channel menu, opened on a row; `inListId` is set while the user browses that list. */
interface MenuState { row: ChannelRow; items: MenuItem[]; inListId?: string; isFavourite: boolean }
/** "Add to list…": every list and the ids of those holding the channel. */
interface PickerState { row: ChannelRow; lists: ListSummary[]; member: Set<string> }
/** The on-screen keyboard for "New list…" (from the picker) or "Rename…" (from the menu). */
interface EditState { kind: 'newList' | 'rename'; row: ChannelRow; value: string; error?: string }

/**
 * In-memory position across Home visits (each push/pop re-creates the screen): the open group, the focused
 * channel and the last focused row per group.
 */
const memory: { groupId?: string; channelId?: string; rows: Map<string, number> } = { rows: new Map() };

const PHONE_BADGE_W = 300;
const PHONE_BADGE_H = 48;
/** Left of the brand wordmark's zone (top centre); the offline badge and the clock sit to its right. */
const PHONE_BADGE_X = WORDMARK_ZONE_X - LAYOUT.gap - PHONE_BADGE_W;

/** "Phone connected": shown on Home while a companion is connected (Settings → Manage on phone or computer). */
function PhoneBadge() {
  return (
    <View x={PHONE_BADGE_X} y={LAYOUT.safeY - 4} width={PHONE_BADGE_W} height={PHONE_BADGE_H} color={COLORS.surface}
      borderRadius={PHONE_BADGE_H / 2} border={{ width: 2, color: COLORS.focus }}>
      <Text y={(PHONE_BADGE_H - FONT.small) / 2 - 3} width={PHONE_BADGE_W} maxWidth={PHONE_BADGE_W} contain="width"
        textAlign="center" fontSize={FONT.small} color={COLORS.text}>{'Phone connected'}</Text>
    </View>
  );
}

/** Home: groups, a virtualised channel list with now/next, the live preview and the channel options menu. */
export function HomeScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as { lastGroupId?: string; lastChannelId?: string; focusChannelId?: string };
  // One-shot hint from the Player (last watched channel after a sleep-timer stop): consumed here.
  const focusHint = params.focusChannelId;
  delete params.focusChannelId;

  const [groups, setGroups] = createSignal<GroupInfo[]>([]);
  const [groupId, setGroupId] = createSignal<string | undefined>(undefined);
  const [focus, setFocus] = createSignal(0);
  const [version, setVersion] = createSignal(0);
  const [area, setArea] = createSignal<'groups' | 'list'>('list');
  const [ready, setReady] = createSignal(false);
  const [waiting, setWaiting] = createSignal(false);
  const [progress, setProgress] = createSignal<Progress | undefined>(undefined);
  const [menu, setMenu] = createSignal<MenuState | undefined>(undefined);
  const [picker, setPicker] = createSignal<PickerState | undefined>(undefined);
  const [edit, setEdit] = createSignal<EditState | undefined>(undefined);
  // A layout refresh has emptied the cache: hide the empty-group text until the group is re-read.
  const [reloading, setReloading] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  // A preview is scheduled (debounce running) for the focused channel.
  const [starting, setStarting] = createSignal(false);
  // Fresh now/next for the playing channel when it is not the focused row (refreshed on the 30 s tick).
  const [playingInfo, setPlayingInfo] = createSignal<{ row: ChannelRow; at: number } | undefined>(undefined);

  let groupNode: ElementNode | undefined;
  let listNode: ElementNode | undefined;
  let menuNode: ElementNode | undefined;
  let pickerNode: ElementNode | undefined;
  let keyboardNode: ElementNode | undefined;
  let removeMenu: (() => void) | undefined;
  let removePicker: (() => void) | undefined;
  let removeKeyboard: (() => void) | undefined;
  let alive = true;
  let startupMarked = false;
  // Playback was stopped on purpose (sleep timer): no resume and no auto-preview until the user moves.
  let held = previewHold.take();
  let lastTop = 0;
  // Only the latest openGroup call may write the selection and memory.
  let groupSeq = 0;
  // The channel a preview request is fetching right now (its getPlayable has not answered yet).
  let requestedId: string | undefined;

  // Bounded (6 pages around the latest window, current + previous group) and expiring (see sliceCache.ts).
  const cache = new SliceCache<ChannelRow>((g, o, c) => api.getChannelSlice(g, o, c), 40, () => setVersion((v) => v + 1),
    { maxPages: 6, now: () => Date.now() });

  const total = () => { version(); const g = groupId(); return g === undefined ? 0 : cache.total(g) ?? 0; };
  const rowAt = (i: number) => { version(); const g = groupId(); return g === undefined ? undefined : cache.row(g, i); };
  const top = createMemo(() => {
    const t = total();
    // While a reload has emptied the cache the total is unknown: keep the scroll position.
    if (t === 0) return lastTop;
    lastTop = scrollTopFor(focus(), lastTop, LIST_ROWS, t);
    return lastTop;
  });
  const focusedRow = () => rowAt(focus());
  // Keyed on the id only: a page (re)load that replaces the row object does not restart the preview timer.
  const focusedId = createMemo(() => focusedRow()?.id);
  const groupIndex = () => Math.max(0, groups().findIndex((g) => g.id === groupId()));

  const visibleRange = () => renderRange(top(), LIST_ROWS, Math.max(total(), 1));
  const load = () => {
    const g = groupId();
    if (g === undefined) return;
    const r = visibleRange();
    // Cached pages scrolled into view may hold rolled-over now/next: mark them so `ensure` refetches them now.
    cache.invalidateStale(g, r.from, r.to);
    cache.ensure(g, r.from, Math.max(r.to, 1)).catch((err: unknown) => {
      console.warn('Channel slice failed', err instanceof Error ? err.name : 'Error');
    });
  };
  createEffect(load);

  // Startup metric: the first render of cached channel rows (effects run once their nodes exist). Not
  // deferred to requestAnimationFrame, which background or throttled tabs delay by seconds.
  createEffect(() => {
    if (startupMarked || !rowAt(top())) return;
    startupMarked = true;
    markStartup();
  });

  // ---- preview ----

  /** Plays `id` in the preview unless a newer request (schedule, watch, stop) has superseded this one. */
  const playById = async (id: string) => {
    const token = playback.begin();
    requestedId = id;
    try {
      const ch = await api.getPlayable(id);
      if (alive && ch && playback.isLatest(token)) playback.playChannel(ch);
    } catch (err) {
      console.warn('Preview failed', err instanceof Error ? err.name : 'Error');
    } finally {
      if (playback.isLatest(token)) requestedId = undefined;
    }
  };
  const preview = createDebounce<string>(PREVIEW_DELAY_MS, (id) => {
    setStarting(false);
    if (alive && focusedId() === id && area() === 'list') void playById(id);
  });
  /** (Re)starts the 700 ms preview timer; supersedes any preview request still in flight. */
  const schedulePreview = (id: string) => {
    playback.begin();
    requestedId = undefined;
    preview.schedule(id);
    setStarting(true);
  };
  /** Cancels the timer only (a request already fetching the channel in question keeps going). */
  const cancelTimer = () => {
    preview.cancel();
    setStarting(false);
  };
  /** Cancels the timer and any preview request in flight. */
  const stopPreview = () => {
    cancelTimer();
    playback.begin();
    requestedId = undefined;
  };

  /** Moves the list focus and remembers it; a resting focus starts the preview after 700 ms. */
  const selectRow = (i: number) => {
    setFocus(i);
    const g = groupId();
    if (g !== undefined) memory.rows.set(g, i);
    memory.groupId = g;
    const r = rowAt(i);
    if (r) memory.channelId = r.id;
  };
  // Schedules the preview whenever the focused channel changes while the list has focus.
  // No preview starts while the channel menu, the list picker or the keyboard is open.
  const modalOpen = () => menu() !== undefined || picker() !== undefined || edit() !== undefined;
  createEffect(on([focusedId, area, ready, modalOpen], ([id, a, isReady, modal]) => {
    if (id === undefined || a !== 'list' || !isReady || modal) {
      cancelTimer(); // leaving the list drops a pending preview (and its "Starting…")
      return;
    }
    memory.channelId = id;
    if (held) return;
    if (playback.current()?.id === id || requestedId === id) cancelTimer();
    else schedulePreview(id);
  }));

  // Preview panel: the playing channel's info, or the focused one while its preview is starting.
  createEffect(on(() => playback.current(), (c) => setPlayingInfo(c ? { row: c, at: Date.now() } : undefined)));
  const playingRow = (): ChannelRow | undefined => {
    const c = playback.current();
    if (!c) return undefined;
    const f = focusedRow();
    if (f?.id === c.id) return f; // the cached row is kept fresh by the slice cache
    const info = playingInfo();
    return info?.row.id === c.id ? info.row : c;
  };
  const panel = () => panelChannel(focusedRow(), playingRow(), starting());

  /** Re-reads the playing channel's now/next once its programme has ended since it was last read. */
  const refreshPlayingInfo = () => {
    const info = playingInfo();
    const stop = info?.row.now?.stop;
    const t = Date.now();
    if (!info || stop === undefined || stop > t || stop <= info.at) return;
    const id = info.row.id;
    if (focusedRow()?.id === id) return; // shown from the slice cache, which refreshes itself
    rereadPlayingInfo(id);
  };
  const rereadPlayingInfo = (id: string) => {
    const t = Date.now();
    api.getPlayable(id).then((ch) => {
      if (alive && ch && playback.current()?.id === id) setPlayingInfo({ row: ch, at: t });
    }).catch(() => undefined);
  };

  /** 30 s tick: progress bars, rolled-over visible pages and the playing channel's info. */
  const onTick = () => {
    setNow(Date.now());
    load(); // refetches visible pages whose programmes rolled over
    refreshPlayingInfo();
  };

  // ---- groups ----

  /**
   * Opens group `g` and focuses the first of `keepIds` that is in it (else the remembered row, else the first
   * row). Resolves with the id it focused, or undefined. Only the latest call writes the selection.
   */
  const openGroup = async (g: string, keepIds: readonly (string | undefined)[] = [], keepScroll = false,
    fallbackIndex?: number): Promise<string | undefined> => {
    const seq = ++groupSeq;
    if (!keepScroll) lastTop = 0;
    setGroupId(g);
    await cache.ensure(g, 0, 1).catch(() => undefined);
    if (!alive || seq !== groupSeq) return undefined;
    const t = cache.total(g) ?? 0;
    const hit = await resolveFocus(keepIds, (id) => api.indexOf(g, id).catch(() => -1));
    if (!alive || seq !== groupSeq) return undefined;
    // After a layout change a channel that left the group hands its row to the neighbour that took its place.
    selectRow(fallbackIndex !== undefined ? focusAfterRefresh(hit.index, fallbackIndex, t)
      : restoreIndex(hit.index, memory.rows.get(g), t));
    return hit.id;
  };

  /**
   * Re-reads groups and the visible slice, keeping focus on the same channel id (`keepId`, else the focused
   * one) when it is still in the group. If it left (hidden, removed from the list), the neighbour that took
   * its row is focused. A group that disappeared falls back to All channels.
   */
  let reloadSeq = 0;
  const reload = async (keepId?: string) => {
    const seq = ++reloadSeq;
    const id = keepId ?? focusedRow()?.id ?? memory.channelId;
    const before = groupId();
    const oldIndex = focus();
    setReloading(true);
    try {
      const gs = await api.getGroups();
      if (!alive) return;
      setGroups(gs);
      cache.invalidate();
      const g = pickGroup(gs, before);
      if (g !== undefined) await openGroup(g, [id], g === before, g === before ? oldIndex : undefined);
    } finally {
      if (seq === reloadSeq) setReloading(false);
    }
    // The list emptied under the focus (e.g. its last channel was removed): move to the groups.
    if (alive && seq === reloadSeq && !modalOpen() && area() === 'list' && total() === 0) focusArea('groups');
  };

  // ---- actions ----

  /**
   * Channels in the open group. The group's count is known before its first slice arrives (and while a reload
   * has emptied the cache), so a quick Right or a closing overlay is not sent to the groups by mistake.
   */
  const listCount = () => total() || (groups().find((g) => g.id === groupId())?.count ?? 0);

  const focusArea = (a: 'groups' | 'list') => {
    if (a === 'list' && listCount() === 0) return true;
    setArea(a);
    (a === 'groups' ? groupNode : listNode)?.setFocus();
    return true;
  };

  const watch = () => {
    const r = focusedRow();
    const g = groupId();
    if (!r || g === undefined) return true;
    cancelTimer();
    const token = playback.begin();
    requestedId = undefined;
    memory.channelId = r.id;
    void (async () => {
      try {
        const ch = await api.getPlayable(r.id);
        if (!alive || !ch || !playback.isLatest(token)) return;
        // Same channel: the stream keeps running and only the rect changes (no reconnect).
        playback.playChannel(ch);
        playback.setRect('fullscreen');
        await api.markWatched(r.id, g).catch(() => undefined);
        if (alive && playback.isLatest(token)) router.push('player', { channelId: r.id, groupId: g });
      } catch (err) {
        console.warn('Open channel failed', err instanceof Error ? err.name : 'Error');
      }
    })();
    return true;
  };

  // ---- channel menu, list picker, keyboard (Back closes them top first: keyboard, picker, menu) ----

  /**
   * Focuses the topmost open layer (nodes of a layer just opened exist only after this tick). With none left,
   * the list keeps focus, also while a reload has emptied the cache; only a really empty group sends it to
   * the groups.
   */
  const focusTop = () => queueMicrotask(() => {
    if (!alive) return;
    if (edit()) keyboardNode?.setFocus();
    else if (picker()) pickerNode?.setFocus();
    else if (menu()) menuNode?.setFocus();
    else focusArea(listCount() > 0 ? 'list' : 'groups');
  });

  // `close*` are the overlays' onClose (Back): the router has already dropped the layer.
  const closeKeyboard = () => { removeKeyboard = undefined; setEdit(undefined); focusTop(); };
  const closePicker = () => { removePicker = undefined; setPicker(undefined); focusTop(); };
  const closeMenu = () => { removeMenu = undefined; setMenu(undefined); focusTop(); };
  // `dismiss*` close a layer from code.
  const dismissKeyboard = () => { if (edit()) { removeKeyboard?.(); closeKeyboard(); } };
  const dismissPicker = () => { if (picker()) { removePicker?.(); closePicker(); } };
  const dismissMenu = () => { if (menu()) { removeMenu?.(); closeMenu(); } };
  const dismissAll = () => { dismissKeyboard(); dismissPicker(); dismissMenu(); };

  /** User lists as shown in the group column (names and order), for the menu's "Remove from" label. */
  const listsFromGroups = (): ListLite[] => groups().flatMap((g) => {
    const id = listIdOfGroup(g.id);
    return id === undefined ? [] : [{ id, name: g.name }];
  });

  const openMenu = () => {
    const r = focusedRow();
    if (!r || modalOpen()) return true;
    stopPreview();
    const inListId = listIdOfGroup(groupId());
    // Home never shows hidden channels (they are hidden everywhere), so the menu always offers Hide.
    setMenu({ row: r, inListId, isFavourite: r.favourite, items: buildChannelMenu({
      inListId, isHidden: false, isFavourite: r.favourite, lists: listsFromGroups(),
    }) });
    removeMenu = router.pushOverlay(MENU_ID, closeMenu);
    focusTop();
    return true;
  };

  /**
   * Rebuilds the open menu's items from the current layout (after a remote change): the Favourites item
   * follows the channel's membership, and "Remove from" disappears when its list was deleted.
   */
  const rebuildMenu = async () => {
    const m = menu();
    if (!m) return;
    const ids = await api.channelLists(m.row.id);
    const cur = menu();
    if (!alive || cur?.row.id !== m.row.id) return;
    const isFavourite = ids.includes(FAV_LIST_ID);
    setMenu({ ...cur, isFavourite, items: buildChannelMenu({
      inListId: cur.inListId, isHidden: false, isFavourite, lists: listsFromGroups(),
    }) });
  };

  /** Applies layout ops; resolves false (after a toast) when the worker refused any of them. */
  const applyOps = async (ops: LayoutOp[]): Promise<boolean> => {
    try {
      const res = await api.applyLayoutOps(ops);
      if (res.rejected.length === 0) return true;
      console.warn('Layout change refused', res.rejected.map((x) => x.reason).join(', '));
    } catch (err) {
      console.warn('Layout change failed', err instanceof Error ? err.name : 'Error');
    }
    if (alive) showToast("Couldn't change this channel.");
    return false;
  };

  /** Re-reads the picker's lists and checks (after a toggle, a new list or a remote change). */
  const rereadPicker = async (row: ChannelRow) => {
    const [lists, ids] = await Promise.all([api.listLists(), api.channelLists(row.id)]);
    if (alive && picker()?.row.id === row.id) setPicker({ row, lists, member: new Set(ids) });
  };

  const openPicker = async (row: ChannelRow) => {
    try {
      const [lists, ids] = await Promise.all([api.listLists(), api.channelLists(row.id)]);
      if (!alive || menu()?.row.id !== row.id || picker()) return;
      setPicker({ row, lists, member: new Set(ids) });
      removePicker = router.pushOverlay(PICKER_ID, closePicker);
      focusTop();
    } catch (err) {
      console.warn('Load lists failed', err instanceof Error ? err.name : 'Error');
      showToast("Couldn't load your lists.");
    }
  };

  const openKeyboard = (kind: EditState['kind'], row: ChannelRow, value: string) => {
    // Prefilled in full: a playlist name longer than NAME_MAX is validated on Done, not cut.
    setEdit({ kind, row, value });
    removeKeyboard = router.pushOverlay(KEYBOARD_ID, closeKeyboard);
    focusTop();
  };

  const choose = async (action: ChannelMenuAction) => {
    const m = menu();
    if (!m) return;
    const r = m.row;
    if (action === 'cancel') { dismissMenu(); return; }
    if (action === 'addToList') { await openPicker(r); return; }
    if (action === 'rename') { openKeyboard('rename', r, r.name); return; }
    dismissMenu();
    let ok = false;
    if (action === 'toggleFavourite') {
      const isFav = m.isFavourite;
      ok = await applyOps([{ op: isFav ? 'removeFromList' : 'addToList', listId: FAV_LIST_ID, channelIds: [r.id] }]);
      if (ok) showToast(isFav ? 'Removed from Favourites' : 'Added to Favourites');
    } else if (action === 'removeFromList' && m.inListId !== undefined) {
      ok = await applyOps([{ op: 'removeFromList', listId: m.inListId, channelIds: [r.id] }]);
      const name = listsFromGroups().find((l) => l.id === m.inListId)?.name;
      if (ok) showToast(name ? `Removed from "${name}"` : 'Removed from the list');
    } else if (action === 'hide' || action === 'unhide') {
      ok = await applyOps([{ op: action === 'hide' ? 'hideChannels' : 'unhideChannels', ids: [r.id] }]);
      if (ok) showToast(action === 'hide' ? 'Channel hidden' : 'Channel shown');
    }
    if (ok && alive) await reload(r.id).catch(() => undefined);
  };

  /** Picker Ok: toggles the channel in a list, or opens the keyboard for a new one. The picker stays open. */
  const pick = async (p: PickerRow) => {
    const s = picker();
    if (!s || edit()) return;
    if (p.kind === 'new') { openKeyboard('newList', s.row, 'New list'); return; }
    const op: LayoutOp = p.checked
      ? { op: 'removeFromList', listId: p.id, channelIds: [s.row.id] }
      : { op: 'addToList', listId: p.id, channelIds: [s.row.id] };
    if (!(await applyOps([op])) || !alive) return;
    await Promise.all([rereadPicker(s.row), reload(s.row.id)]).catch(() => undefined);
  };

  /** Keyboard Done: creates the list (with the channel in it) or renames the channel. */
  const submitEdit = async () => {
    const e = edit();
    if (!e) return;
    if (e.kind === 'newList') {
      const v = validateListName(e.value);
      // Shown in the keyboard (not a toast, which would be a Back layer above it).
      if (!v.ok) { setEdit({ ...e, error: v.message }); return; }
      const id = newListId(new Set(picker()?.lists.map((l) => l.id) ?? []));
      dismissKeyboard(); // back to the picker, which shows the new list checked
      const ops: LayoutOp[] = [{ op: 'createList', id, name: v.name }, { op: 'addToList', listId: id, channelIds: [e.row.id] }];
      if (!(await applyOps(ops)) || !alive) return;
      await Promise.all([rereadPicker(e.row), reload(e.row.id)]).catch(() => undefined);
      return;
    }
    const r = renameOutcome(e.value, e.row.name);
    if (r.kind === 'error') { setEdit({ ...e, error: r.message }); return; }
    dismissAll();
    if (r.kind === 'unchanged') return; // Done on the current name: nothing to store
    if (!(await applyOps([{ op: 'renameChannel', id: e.row.id, name: r.name }])) || !alive) return;
    showToast(r.name === null ? 'Original name restored' : 'Channel renamed');
    await reload(e.row.id).catch(() => undefined);
  };

  const listKeys = {
    onMove: (d: number) => { held = false; selectRow(moveFocus(focus(), d, total())); return true; },
    onPage: (dir: 1 | -1) => { held = false; selectRow(pageFocus(focus(), dir, LIST_ROWS, total())); return true; },
    onLeft: () => focusArea('groups'),
    onOk: watch,
    onOptions: openMenu,
  };

  const onGroupSelect = (i: number) => {
    const g = groups()[i];
    if (!g) return;
    stopPreview();
    held = false;
    void openGroup(g.id);
  };

  // ---- lifecycle ----

  onMount(() => {
    playback.setRect(PREVIEW_RECT);
    const offs = [
      onEvent('progress', (p) => setProgress(p as Progress)),
      onEvent('refreshed', () => { setWaiting(false); void reload().catch(() => undefined); }),
      // A companion changed the layout (the shell shows "Updated from your phone"): re-read, keeping focus by
      // id. Changes made on this screen re-read on their own.
      onEvent('layoutChanged', (e) => {
        if ((e as LayoutChanged).origin !== 'remote') return;
        // An open channel menu is rebuilt from the fresh state once the groups are re-read.
        void reload().then(rebuildMenu).catch(() => undefined);
        const p = picker();
        if (p) void rereadPicker(p.row).catch(() => undefined);
      }),
      onEvent('refreshFailed', () => setWaiting(false)),
      // Background short-EPG answers: refetch the cached pages holding those channels (visible ones right away).
      // The playing channel's info outside the list rows (preview panel) is re-read too.
      onEvent('nowNextUpdated', (e) => {
        const ids = (e as { channelIds: string[] }).channelIds;
        if (cache.invalidateRows(ids) > 0) load();
        const playingId = playback.current()?.id;
        if (playingId !== undefined && playingInfoStale(ids, playingId, focusedRow()?.id)) rereadPlayingInfo(playingId);
      }),
    ];
    const tick = setInterval(onTick, 30_000);
    onCleanup(() => { for (const off of offs) off(); clearInterval(tick); });

    void (async () => {
      try {
        const gs = await api.getGroups();
        if (!alive) return;
        setGroups(gs);
        // Focus order: the playing channel (it may have zapped away in the Player), the remembered channel, the
        // last channel from init, then the remembered row / the first row.
        const playingId = playback.current()?.id;
        let g = pickGroup(gs, memory.groupId ?? params.lastGroupId);
        // An empty cache on first start: the list arrives with a later `refreshed` event.
        if ((gs.find((x) => x.id === GROUP_ALL)?.count ?? 0) === 0) setWaiting(true);
        // A channel reached by number entry may be outside the remembered group: show it in "All".
        if (playingId !== undefined && g !== undefined && g !== GROUP_ALL && gs.some((x) => x.id === GROUP_ALL)
          && await api.indexOf(g, playingId).catch(() => -1) < 0) g = GROUP_ALL;
        if (!alive) return;
        const found = g === undefined ? undefined
          : await openGroup(g, [playingId, focusHint, memory.channelId, params.lastChannelId]);
        if (!alive) return;
        // The preview resumes the last channel right away (no-op when it is already playing). A last channel
        // that is gone or hidden is not resumed; the focused row previews after the usual delay instead.
        // Started before `ready`, so the focus effect sees the request and does not schedule it again.
        const resume = playingId ?? found;
        if (resume && !held) void playById(resume);
        setReady(true);
        focusArea(total() > 0 ? 'list' : 'groups');
      } catch (err) {
        console.warn('Home load failed', err instanceof Error ? err.name : 'Error');
        setReady(true);
      }
    })();
  });

  onCleanup(() => {
    alive = false;
    preview.cancel();
    playback.begin(); // drops any preview request still in flight
    removeKeyboard?.();
    removePicker?.();
    removeMenu?.();
    router.removeOverlay(KEYBOARD_ID);
    router.removeOverlay(PICKER_ID);
    router.removeOverlay(MENU_ID);
  });

  const onBack = () => {
    if (router.topOverlay() !== undefined) return false; // the shell closes the top layer first
    if (area() === 'groups' && total() > 0) return focusArea('list');
    return false;
  };

  const groupName = () => groups().find((g) => g.id === groupId())?.name ?? '';
  const emptyText = () => {
    if (!ready()) return '';
    if (waiting()) {
      const p = progress();
      return p ? `Loading channels… ${p.count}` : 'Loading channels…';
    }
    return emptyGroupText(groupId());
  };

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} onBack={onBack}
      forwardFocus={() => { focusArea(area()); return true; }}
      onYellow={() => { router.push('search'); return true; }}
      onGreen={() => { router.push('guide', groupId() !== undefined ? { groupId: groupId() } : undefined); return true; }}
      onBlue={() => { router.push('settings'); return true; }}>
      {/* Opaque background everywhere except the preview box, which stays a hole onto the video. */}
      <View width={LAYOUT.width} height={PREVIEW_RECT.y} color={COLORS.background} />
      <View y={PREVIEW_RECT.y + PREVIEW_RECT.h} width={LAYOUT.width} height={LAYOUT.height - PREVIEW_RECT.y - PREVIEW_RECT.h}
        color={COLORS.background} />
      <View y={PREVIEW_RECT.y} width={PREVIEW_RECT.x} height={PREVIEW_RECT.h} color={COLORS.background} />
      <View x={PREVIEW_RECT.x + PREVIEW_RECT.w} y={PREVIEW_RECT.y} width={LAYOUT.width - PREVIEW_RECT.x - PREVIEW_RECT.w}
        height={PREVIEW_RECT.h} color={COLORS.background} />

      <Text x={GROUP_X} y={LAYOUT.safeY} fontSize={FONT.title} color={COLORS.text}>{'Channels'}</Text>
      <Show when={showPhoneBadge(companionStatus())}><PhoneBadge /></Show>
      <Text x={LIST_X} y={HEAD_Y} width={LIST_W} maxWidth={LIST_W} contain="width" maxLines={1} fontSize={FONT.body}
        color={COLORS.muted}>{groupName() ? `${groupName()} · ${total()}` : ''}</Text>

      <GroupList ref={(el) => { groupNode = el; }} x={GROUP_X} y={BODY_Y} width={GROUP_W} height={LIST_H}
        groups={groups()} selected={groupIndex()} onSelect={onGroupSelect} onRight={() => focusArea('list')} />

      <ChannelList ref={(el) => { listNode = el; }} x={LIST_X} y={BODY_Y} width={LIST_W} height={LIST_H}
        total={total()} top={top()} focus={focus()} row={rowAt} now={now()} playingId={playback.current()?.id}
        onFocusChanged={(f) => { if (f) setArea('list'); }} {...listKeys} />
      <Show when={ready() && !reloading() && total() === 0}>
        <Text x={LIST_X + 24} y={BODY_Y + 24} width={LIST_W - 48} maxWidth={LIST_W - 48} contain="width"
          fontSize={FONT.body} color={COLORS.muted}>{emptyText()}</Text>
      </Show>

      <PreviewPanel x={PREVIEW_X} y={BODY_Y} channel={panel().channel} starting={panel().starting}
        status={playback.status()} playing={playback.current() !== undefined} now={now()} />

      <Text x={GROUP_X} y={HINT_Y} width={SAFE_W} maxWidth={SAFE_W} contain="width" maxLines={1} fontSize={FONT.small}
        color={COLORS.muted}>
        {'Ok watch · Hold Ok or Menu: options · Yellow search · Green guide · Blue settings'}
      </Text>

      <Show when={menu()}>{(m) => (
        <ContextMenu ref={(el) => { menuNode = el; }} title={m().row.name} items={m().items} cancel="cancel"
          onChoose={(a) => void choose(a)} />
      )}</Show>
      <Show when={picker()}>{(p) => (
        <ListPicker ref={(el) => { pickerNode = el; }} title={`Add "${p().row.name}" to`}
          rows={pickerRows(p().lists, p().member)} onPick={(r) => void pick(r)} />
      )}</Show>
      <Show when={edit()}>{(e) => (
        <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim} zIndex={70}>
          <Keyboard ref={(el) => { keyboardNode = el; }} x={(LAYOUT.width - KEYBOARD_W) / 2}
            y={(LAYOUT.height - KEYBOARD_H) / 2}
            label={e().kind === 'newList' ? 'New list name' : 'Channel name (empty restores the original)'}
            value={e().value} onChange={(v) => { const cur = edit(); if (cur) setEdit({ kind: cur.kind, row: cur.row, value: limitTyping(cur.value, v) }); }}
            onDone={() => void submitEdit()} hint="Done saves · Back cancels" error={e().error} />
        </View>
      )}</Show>
    </View>
  );
}
