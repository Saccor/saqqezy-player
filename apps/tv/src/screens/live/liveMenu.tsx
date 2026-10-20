/**
 * Live TV's one menu (Menu / long OK on the grid and the channel cell), ported from Home's channel menu runner
 * (openMenu / rebuildMenu / choose / applyOps, the list picker and the rename keyboard) plus the Guide's programme items
 * ("From the start", "Go to day…") and a combined channel's "Choose source…". Back closes the layers top first: keyboard, picker, menu. Not unit-tested: the pure
 * rules live in liveLogic.ts and homeMenuLogic.ts.
 */
import { Show, View, type ElementNode, type JSX } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import type { ChannelRow, ListSummary } from '@iptv/app-api';
import type { GroupInfo, LayoutOp } from '@iptv/core';
import { api } from '../../api.ts';
import { createChoiceMenu } from '../../components/choiceMenu.tsx';
import { ContextMenu } from '../../components/ContextMenu.tsx';
import { Keyboard, KEYBOARD_H, KEYBOARD_W } from '../../components/Keyboard.tsx';
import { ListPicker } from '../../components/ListPicker.tsx';
import { favChangedToast, CATCHUP_COPY, SOURCE_COPY } from '../../copy.ts';
import { shellBack, usePointerTarget } from '../../input/pointer.ts';
import { playback } from '../../playback/playback.ts';
import { sourceOptions } from '../../playback/sourceLogic.ts';
import { router } from '../../shell/router.ts';
import { COLORS, LAYOUT } from '../../shell/theme.ts';
import { showToast } from '../../shell/Toast.tsx';
import {
  limitTyping, listIdOfGroup, newListId, pickerRows, renameOutcome, validateListName, type ListLite, type PickerRow,
} from '../homeMenuLogic.ts';
import { liveMenuItems, type LiveMenuAction } from './liveLogic.ts';

const MENU_ID = 'contextMenu';
const PICKER_ID = 'listPicker';
const KEYBOARD_ID = 'keyboard';
const DAYS_ID = 'liveDays';
const SOURCES_ID = 'liveSources';
const FAV_LIST_ID = 'fav';

/** The menu, opened on a channel; `inListId` is set while the user browses that list. */
interface MenuState {
  row: ChannelRow; items: { action: LiveMenuAction; label: string }[];
  inListId?: string; isFavourite: boolean; fromStart?: () => void; goToDay: boolean;
}
/** "Add to list…": every list and the ids of those holding the channel. */
interface PickerState { row: ChannelRow; lists: ListSummary[]; member: Set<string> }
/** The on-screen keyboard for "New list…" (from the picker) or "Rename…" (from the menu). */
interface EditState { kind: 'newList' | 'rename'; row: ChannelRow; value: string; error?: string }

export interface LiveMenuDeps {
  alive: () => boolean;
  groups: () => readonly GroupInfo[];
  groupId: () => string | undefined;
  /** Cancels a preview request in flight (as Home did when its menu opened). */
  stopPreview: () => void;
  /** Re-reads the groups and the guide, focusing `keepId` when it is still in the group, else the nearest row. */
  reload: (keepId: string) => Promise<unknown>;
  /** Focus back to the screen once no layer is left. */
  refocus: () => void;
  /** "Go to day…": the day targets, and what a pick does. */
  dayTargets: () => { label: string; at: number }[];
  goToDay: (at: number) => void;
  /** "Choose source…": `sourceId` plays now for row `rowId`, and first from now on. */
  playSource: (rowId: string, sourceId: string) => void;
}

export function createLiveMenu(d: LiveMenuDeps) {
  const [menu, setMenu] = createSignal<MenuState | undefined>(undefined);
  const [picker, setPicker] = createSignal<PickerState | undefined>(undefined);
  const [edit, setEdit] = createSignal<EditState | undefined>(undefined);
  let menuNode: ElementNode | undefined;
  let pickerNode: ElementNode | undefined;
  let keyboardNode: ElementNode | undefined;
  let removeMenu: (() => void) | undefined;
  let removePicker: (() => void) | undefined;
  let removeKeyboard: (() => void) | undefined;

  const days = createChoiceMenu(DAYS_ID, () => { if (d.alive()) d.refocus(); });
  const sources = createChoiceMenu(SOURCES_ID, () => { if (d.alive()) d.refocus(); });

  /** Focuses the topmost open layer (a layer just opened has its node only after this tick), else the screen. */
  const focusTop = () => queueMicrotask(() => {
    if (!d.alive()) return;
    if (edit()) keyboardNode?.setFocus();
    else if (picker()) pickerNode?.setFocus();
    else if (menu()) menuNode?.setFocus();
    else d.refocus();
  });

  // `close*` are the overlays' onClose (Back): the router has already dropped the layer.
  const closeKeyboard = () => { removeKeyboard = undefined; setEdit(undefined); focusTop(); };
  const closePicker = () => { removePicker = undefined; setPicker(undefined); focusTop(); };
  const closeMenu = () => { removeMenu = undefined; setMenu(undefined); focusTop(); };
  // `dismiss*` close a layer from code.
  const dismissKeyboard = () => { if (edit()) { removeKeyboard?.(); closeKeyboard(); } };
  const dismissPicker = () => { if (picker()) { removePicker?.(); closePicker(); } };
  const dismissMenu = () => { if (menu()) { removeMenu?.(); closeMenu(); } };
  // The day choice closes like Back: its pending choice answers undefined and focus returns to the screen.
  const dismissAll = () => {
    dismissKeyboard(); dismissPicker(); dismissMenu(); days.close({ answer: true }); sources.close({ answer: true });
  };

  const open = () => menu() !== undefined || picker() !== undefined || edit() !== undefined || days.isOpen()
    || sources.isOpen();

  /** User lists as the groups show them (names and order), for the menu's "Remove from" label. */
  const listsFromGroups = (): ListLite[] => d.groups().flatMap((g) => {
    const id = listIdOfGroup(g.id);
    return id === undefined ? [] : [{ id, name: g.name }];
  });

  const itemsFor = (s: Omit<MenuState, 'items'>) => liveMenuItems({
    // The guide never shows hidden channels (they are hidden everywhere), so the menu always offers Hide.
    channel: {
      inListId: s.inListId, isHidden: false, isFavourite: s.isFavourite, lists: listsFromGroups(), sources: s.row.sourceCount,
    },
    fromStart: s.fromStart !== undefined, goToDay: s.goToDay,
  });

  /**
   * Opens the menu on `row`. The programme items (see `liveMenuItems`): `fromStart` (set for an on-air programme whose
   * channel keeps an archive) runs it; `goToDay` offers the day choice.
   */
  const openMenu = (row: ChannelRow, o: { fromStart?: () => void; goToDay: boolean }) => {
    if (open() || router.topOverlay() !== undefined) return;
    d.stopPreview();
    const s = { row, inListId: listIdOfGroup(d.groupId()), isFavourite: row.favourite, ...o };
    setMenu({ ...s, items: itemsFor(s) });
    removeMenu = router.pushOverlay(MENU_ID, closeMenu);
    focusTop();
  };

  /**
   * Rebuilds the open menu's items from the current layout (after a remote change): the Favourites item follows the
   * channel's membership, and "Remove from" disappears when its list was deleted.
   */
  const rebuildMenu = async () => {
    const m = menu();
    if (!m) return;
    const ids = await api.channelLists(m.row.id);
    const cur = menu();
    if (!d.alive() || cur?.row.id !== m.row.id) return;
    const next = { ...cur, isFavourite: ids.includes(FAV_LIST_ID) };
    setMenu({ ...next, items: itemsFor(next) });
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
    if (d.alive()) showToast("Couldn't change this channel.");
    return false;
  };

  /** Re-reads the picker's lists and checks (after a toggle, a new list or a remote change). */
  const rereadPicker = async (row: ChannelRow) => {
    const [lists, ids] = await Promise.all([api.listLists(), api.channelLists(row.id)]);
    if (d.alive() && picker()?.row.id === row.id) setPicker({ row, lists, member: new Set(ids) });
  };
  const rereadOpenPicker = () => {
    const p = picker();
    if (p) void rereadPicker(p.row).catch(() => undefined);
  };

  const openPicker = async (row: ChannelRow) => {
    try {
      const [lists, ids] = await Promise.all([api.listLists(), api.channelLists(row.id)]);
      if (!d.alive() || menu()?.row.id !== row.id || picker()) return;
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

  /** "Go to day…": the day choice; a pick moves the guide there. */
  const chooseDay = async () => {
    const targets = d.dayTargets();
    const pick = await days.choose(CATCHUP_COPY.goToDay, targets.map((t, i) => ({ id: String(i), label: t.label })));
    const at = pick === undefined ? undefined : targets[Number(pick)]?.at;
    if (d.alive() && at !== undefined) d.goToDay(at);
  };

  /** "Choose source…": the row's streams, best first; a pick plays it and remembers it. */
  const chooseSource = async (row: ChannelRow) => {
    let list;
    try {
      list = await api.liveSources(row.id);
    } catch (err) {
      console.warn('Load sources failed', err instanceof Error ? err.name : 'Error');
      if (d.alive()) showToast(SOURCE_COPY.loadFailed);
      return;
    }
    if (!d.alive() || list.length === 0 || open()) return;
    const playing = playback.currentRowId() === row.id ? playback.current()?.id : undefined;
    const pick = await sources.choose(`${SOURCE_COPY.choose} · ${row.name}`, sourceOptions(list, playing));
    if (d.alive() && pick !== undefined) d.playSource(row.id, pick);
  };

  const choose = async (action: LiveMenuAction) => {
    const m = menu();
    if (!m) return;
    const r = m.row;
    if (action === 'cancel') { dismissMenu(); return; }
    if (action === 'addToList') { await openPicker(r); return; }
    if (action === 'rename') { openKeyboard('rename', r, r.name); return; }
    dismissMenu();
    if (action === 'fromStart') { m.fromStart?.(); return; }
    if (action === 'goToDay') { await chooseDay(); return; }
    if (action === 'chooseSource') { await chooseSource(r); return; }
    let ok = false;
    if (action === 'toggleFavourite') {
      const isFav = m.isFavourite;
      ok = await applyOps([{ op: isFav ? 'removeFromList' : 'addToList', listId: FAV_LIST_ID, channelIds: [r.id] }]);
      if (ok) showToast(favChangedToast(!isFav));
    } else if (action === 'removeFromList' && m.inListId !== undefined) {
      ok = await applyOps([{ op: 'removeFromList', listId: m.inListId, channelIds: [r.id] }]);
      const name = listsFromGroups().find((l) => l.id === m.inListId)?.name;
      if (ok) showToast(name ? `Removed from "${name}"` : 'Removed from the list');
    } else if (action === 'hide' || action === 'unhide') {
      ok = await applyOps([{ op: action === 'hide' ? 'hideChannels' : 'unhideChannels', ids: [r.id] }]);
      if (ok) showToast(action === 'hide' ? 'Channel hidden' : 'Channel shown');
    }
    if (ok && d.alive()) await d.reload(r.id).catch(() => undefined);
  };

  /** Picker OK: toggles the channel in a list, or opens the keyboard for a new one. The picker stays open. */
  const pick = async (p: PickerRow) => {
    const s = picker();
    if (!s || edit()) return;
    if (p.kind === 'new') { openKeyboard('newList', s.row, 'New list'); return; }
    const op: LayoutOp = p.checked
      ? { op: 'removeFromList', listId: p.id, channelIds: [s.row.id] }
      : { op: 'addToList', listId: p.id, channelIds: [s.row.id] };
    if (!(await applyOps([op])) || !d.alive()) return;
    await Promise.all([rereadPicker(s.row), d.reload(s.row.id)]).catch(() => undefined);
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
      if (!(await applyOps(ops)) || !d.alive()) return;
      await Promise.all([rereadPicker(e.row), d.reload(e.row.id)]).catch(() => undefined);
      return;
    }
    const r = renameOutcome(e.value, e.row.name);
    if (r.kind === 'error') { setEdit({ ...e, error: r.message }); return; }
    dismissAll();
    if (r.kind === 'unchanged') return; // Done on the current name: nothing to store
    if (!(await applyOps([{ op: 'renameChannel', id: e.row.id, name: r.name }])) || !d.alive()) return;
    showToast(r.name === null ? 'Original name restored' : 'Channel renamed');
    await d.reload(e.row.id).catch(() => undefined);
  };

  /** Removes every layer without its onClose (the screen is going away). */
  const cleanup = () => {
    removeKeyboard?.();
    removePicker?.();
    removeMenu?.();
    days.close({ answer: true }); // settles the pending choice; its refocus and pick are no-ops once not alive
    sources.close({ answer: true });
    for (const id of [KEYBOARD_ID, PICKER_ID, MENU_ID]) router.removeOverlay(id);
  };

  /** The layers, over the rail (zIndex 50): menu 60, picker 64, keyboard 70, day and source choices 80. */
  const LayersView = (): JSX.Element => {
    const pointerOn = () => edit() === undefined;
    return (
      <>
        <Show when={menu()}>{(m) => (
          <View zIndex={60}>
            <ContextMenu ref={(el) => { menuNode = el; }} title={m().row.name} items={m().items} cancel="cancel"
              onChoose={(a) => void choose(a)} pointerEnabled={pointerOn()} />
          </View>
        )}</Show>
        <Show when={picker()}>{(p) => (
          <View zIndex={64}>
            <ListPicker ref={(el) => { pickerNode = el; }} title={`Add "${p().row.name}" to`}
              rows={pickerRows(p().lists, p().member)} onPick={(r) => void pick(r)} pointerEnabled={pointerOn()} />
          </View>
        )}</Show>
        <Show when={edit()}>{(e) => {
          let scrim: ElementNode | undefined;
          // A click outside the keyboard is Back (cancel). The keyboard is a screen-layer target, so this backdrop is
          // one too (an overlay backdrop would be modal and block the keys): registered before the keyboard, it loses.
          usePointerTarget({
            node: () => scrim, onClick: () => shellBack(), onContextMenu: () => shellBack(), onWheel: () => true,
          });
          return (
            <View ref={(el) => { scrim = el; }} width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim} zIndex={70}>
              <Keyboard ref={(el) => { keyboardNode = el; }} x={(LAYOUT.width - KEYBOARD_W) / 2}
                y={(LAYOUT.height - KEYBOARD_H) / 2}
                label={e().kind === 'newList' ? 'New list name' : 'Channel name (empty restores the original)'}
                value={e().value}
                onChange={(v) => { const cur = edit(); if (cur) setEdit({ kind: cur.kind, row: cur.row, value: limitTyping(cur.value, v) }); }}
                onDone={() => void submitEdit()} hint="Done saves · Back cancels" error={e().error} />
            </View>
          );
        }}</Show>
        <days.View />
        <sources.View />
      </>
    );
  };

  /** The rename / new-list keyboard is open: it is modal for the pointer (no other target takes it). */
  const editing = () => edit() !== undefined;

  return { openMenu, rebuildMenu, rereadOpenPicker, dismissAll, cleanup, isOpen: open, editing, View: LayersView };
}
