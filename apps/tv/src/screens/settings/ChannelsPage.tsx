import { Show, View, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import type { AppEvent, ChannelRow, ListSummary } from '@iptv/app-api';
// Type-only: @iptv/core must stay out of the main-thread bundle.
import type { GroupInfo, LayoutOp } from '@iptv/core';
import { api, onEvent } from '../../api.ts';
import { Keyboard, KEYBOARD_H, KEYBOARD_W } from '../../components/Keyboard.tsx';
import { SettingsList, type SettingItem } from '../../components/SettingsList.tsx';
import { shellBack, usePointerTarget } from '../../input/pointer.ts';
import { router } from '../../shell/router.ts';
import { COLORS, LAYOUT } from '../../shell/theme.ts';
import { COMMON_COPY, SETTINGS_COPY, SOURCE_COPY } from '../../copy.ts';
import { showToast } from '../../shell/Toast.tsx';
import { settings } from '../../state/appState.ts';
import { externalLayoutChange } from '../../state/events.ts';
import { limitTyping, validateListName } from '../homeMenuLogic.ts';
import {
  AUTO_REFRESH_OPTIONS, autoRefreshLabel, cycleOption, guideLoaded, hideNoEpgRow, listActions, listMoveTarget,
  onOff, type GuideStatus,
} from '../settingsLogic.ts';
import { saveSetting, type PageProps } from './shared.ts';

const KEYBOARD_ID = 'channelsKeyboard';
const LIST_PREFIX = 'list:';
const GROUP_PREFIX = 'group:';
const CHANNEL_PREFIX = 'channel:';
const NONE = 'none';
const RETRY = 'retry';
const NO_GUIDE: GuideStatus = { coverageKnown: false, hasGuideUrl: false };

interface PageData {
  hideNoEpg: boolean;
  guide: GuideStatus;
  /** The last load failed: show a retry row instead of (empty) lists. */
  failed?: boolean;
  lists: ListSummary[];
  hiddenGroups: GroupInfo[];
  hiddenChannels: ChannelRow[];
}

/** "Rename…" of a list: the on-screen keyboard over the page. */
interface EditState { listId: string; current: string; value: string; error?: string }

const C = SETTINGS_COPY.channels;
const countLabel = (n: number) => (n === 1 ? C.count1 : C.count(n));

/**
 * Channels: auto-refresh interval, "Hide channels without TV guide", the user's lists (rename, move, delete),
 * hidden provider groups and hidden channels (Ok shows one again), and a note about organising from a phone.
 */
export function ChannelsPage(props: PageProps) {
  const [data, setData] = createSignal<PageData | undefined>(undefined);
  const [sel, setSel] = createSignal(0);
  const [edit, setEdit] = createSignal<EditState | undefined>(undefined);
  let alive = true;
  /** Bumped by every `load()`; only the newest call may apply its data (an older one finishing late is stale). */
  let loadSeq = 0;
  let listNode: ElementNode | undefined;
  let keyboardNode: ElementNode | undefined;
  let removeKeyboard: (() => void) | undefined;
  const auto = (): number => settings()?.autoRefreshHours ?? 12;
  const combine = (): boolean => settings()?.combineChannels ?? false;

  const load = async () => {
    const seq = ++loadSeq;
    try {
      const [layout, lists, hiddenGroups, hiddenChannels, guide] = await Promise.all([
        api.getLayout(), api.listLists(), api.hiddenGroups(), api.hiddenChannels(), api.guideStatus(),
      ]);
      if (!alive || seq !== loadSeq) return;
      setData({ hideNoEpg: layout.hideNoEpg, guide, lists, hiddenGroups, hiddenChannels });
    } catch (err) {
      console.warn('Channels page failed', err instanceof Error ? err.name : 'Error');
      if (alive && seq === loadSeq) {
        setData({ hideNoEpg: false, guide: NO_GUIDE, failed: true, lists: [], hiddenGroups: [], hiddenChannels: [] });
      }
    }
  };

  const items = (): SettingItem[] => {
    const d = data();
    const noEpg = hideNoEpgRow(d?.guide ?? NO_GUIDE, d?.hideNoEpg ?? false);
    const out: SettingItem[] = [
      { id: 'auto', label: C.refresh, value: autoRefreshLabel(auto()), adjustable: true,
        help: C.refreshHelp },
      { id: 'noEpg', label: C.hideNoGuide, value: noEpg.value, adjustable: !noEpg.disabled,
        disabled: noEpg.disabled, help: noEpg.help },
      { id: 'combine', label: SOURCE_COPY.setting, value: onOff(combine()), adjustable: true, help: SOURCE_COPY.settingHelp },
    ];
    if (!d) return [...out, { id: NONE, label: COMMON_COPY.loading }];
    if (d.failed) return [...out, { id: RETRY, label: C.loadFailed }];
    out.push({ id: 'h:lists', label: C.lists, heading: true });
    for (const l of d.lists) out.push({ id: LIST_PREFIX + l.id, label: l.name, value: countLabel(l.count) });
    out.push({ id: 'h:groups', label: C.hiddenGroups, heading: true });
    if (d.hiddenGroups.length === 0) out.push({ id: `${NONE}:groups`, label: C.noHiddenGroups });
    for (const g of d.hiddenGroups) {
      out.push({ id: GROUP_PREFIX + g.id, label: g.name, value: SETTINGS_COPY.values.hidden });
    }
    out.push({ id: 'h:channels', label: C.hiddenChannels, heading: true });
    if (d.hiddenChannels.length === 0) {
      out.push({ id: `${NONE}:channels`, label: C.noHiddenChannels, help: C.hideFromOptions });
    }
    for (const c of d.hiddenChannels) {
      out.push({ id: CHANNEL_PREFIX + c.id, label: C.channelRow(c.number, c.name), value: SETTINGS_COPY.values.hidden });
    }
    return out;
  };

  /** Keeps the selection on `id` after a reload (else on the same row, clamped). */
  const reloadKeeping = async (id?: string) => {
    await load();
    if (!alive) return;
    const list = items();
    const i = id === undefined ? -1 : list.findIndex((it) => it.id === id);
    setSel((cur) => (i >= 0 ? i : Math.min(cur, list.length - 1)));
  };

  /** Applies layout ops; false (after a toast) when the worker refused any. */
  const applyOps = async (ops: LayoutOp[], failure: string): Promise<boolean> => {
    try {
      const res = await api.applyLayoutOps(ops);
      if (res.rejected.length === 0) return true;
      console.warn('Layout change refused', res.rejected.map((x) => x.reason).join(', '));
    } catch (err) {
      console.warn('Layout change failed', err instanceof Error ? err.name : 'Error');
    }
    if (alive) showToast(failure);
    return false;
  };

  const toggleNoEpg = async () => {
    const d = data();
    if (!d || !guideLoaded(d.guide)) return;
    if (await applyOps([{ op: 'setHideNoEpg', value: !d.hideNoEpg }], C.changeFailed)) {
      await reloadKeeping('noEpg');
    }
  };

  const onAdjust = (id: string, dir: 1 | -1) => {
    if (id === 'auto') {
      void saveSetting({ autoRefreshHours: cycleOption<number>(AUTO_REFRESH_OPTIONS, auto(), dir) });
      return true;
    }
    if (id === 'combine') {
      void saveSetting({ combineChannels: !combine() });
      return true;
    }
    if (id === 'noEpg') {
      const d = data();
      if (!d || !guideLoaded(d.guide)) return false; // disabled: Left still returns to the menu
      void toggleNoEpg();
      return true;
    }
    return false;
  };

  // ---- list rename keyboard (a Back layer: Back closes it and returns to the list) ----

  const focusList = () => queueMicrotask(() => { if (alive && !edit()) listNode?.setFocus(); });
  const closeKeyboard = () => {
    removeKeyboard = undefined;
    setEdit(undefined);
    focusList();
    // Events skipped while the keyboard was open are applied now.
    void reloadKeeping(items()[sel()]?.id);
  };
  const dismissKeyboard = () => { if (edit()) { removeKeyboard?.(); closeKeyboard(); } };
  const openKeyboard = (l: ListSummary) => {
    setEdit({ listId: l.id, current: l.name, value: l.name });
    removeKeyboard = router.pushOverlay(KEYBOARD_ID, closeKeyboard);
    queueMicrotask(() => keyboardNode?.setFocus());
  };
  const submitRename = async () => {
    const e = edit();
    if (!e) return;
    const v = validateListName(e.value);
    if (v.ok && v.name === e.current) { dismissKeyboard(); return; } // unchanged: nothing to store
    // Shown in the keyboard (not a toast, which would be a Back layer above it).
    if (!v.ok) { setEdit({ ...e, error: v.message }); return; }
    dismissKeyboard();
    if (await applyOps([{ op: 'renameList', listId: e.listId, name: v.name }], C.renameFailed)) {
      showToast(C.renamed);
      await reloadKeeping(LIST_PREFIX + e.listId);
    }
  };

  const onList = async (listId: string) => {
    const lists = data()?.lists ?? [];
    const index = lists.findIndex((l) => l.id === listId);
    const l = lists[index];
    if (!l) return;
    const choice = await props.choose(l.name, listActions(l.id, index, lists.length));
    if (!alive || !choice) return;
    if (choice === 'rename') { openKeyboard(l); return; }
    if (choice === 'moveUp' || choice === 'moveDown') {
      const to = listMoveTarget(index, choice === 'moveUp' ? -1 : 1, lists.length);
      if (to === undefined) return;
      if (await applyOps([{ op: 'moveList', listId: l.id, toIndex: to }], C.moveFailed)) {
        await reloadKeeping(LIST_PREFIX + l.id);
      }
      return;
    }
    if (choice === 'delete') {
      if (!(await props.confirm(C.deleteTitle, C.deleteConfirm, { line: l.name }))) return;
      if (await applyOps([{ op: 'deleteList', listId: l.id }], C.deleteFailed)) {
        showToast(C.deleted);
        await reloadKeeping();
      }
    }
  };

  const onOk = async (id: string) => {
    if (id === 'auto' || id === 'noEpg' || id === 'combine') { onAdjust(id, 1); return; }
    if (id === RETRY) { setData(undefined); await reloadKeeping(RETRY); return; }
    if (id.startsWith(LIST_PREFIX)) { await onList(id.slice(LIST_PREFIX.length)); return; }
    if (id.startsWith(GROUP_PREFIX)) {
      if (await applyOps([{ op: 'unhideGroups', ids: [id.slice(GROUP_PREFIX.length)] }], C.showGroupFailed)) {
        showToast(C.groupShown);
        await reloadKeeping();
      }
      return;
    }
    if (id.startsWith(CHANNEL_PREFIX)) {
      if (await applyOps([{ op: 'unhideChannels', ids: [id.slice(CHANNEL_PREFIX.length)] }], C.showChannelFailed)) {
        showToast(C.channelShown);
        await reloadKeeping();
      }
    }
  };

  onMount(() => {
    void load();
    const offs = [
      // A phone changed the layout, a backup was restored, or a guide download made the no-guide filter available.
      // Changes made on this page re-read on their own.
      onEvent('layoutChanged', (e) => {
        if (externalLayoutChange(e as Extract<AppEvent, { type: 'layoutChanged' }>) && !edit()) void reloadKeeping(items()[sel()]?.id);
      }),
      onEvent('refreshed', () => { if (!edit()) void reloadKeeping(items()[sel()]?.id); }),
    ];
    onCleanup(() => { for (const off of offs) off(); });
  });
  onCleanup(() => {
    alive = false;
    removeKeyboard?.();
    router.removeOverlay(KEYBOARD_ID);
    props.register(undefined);
  });

  return (
    <>
      <SettingsList ref={(el) => { listNode = el; props.register(el); }} x={props.x} y={props.y} width={props.width}
        height={props.height} items={items()} selected={sel()} onSelect={setSel} onAdjust={onAdjust}
        onOk={(id) => void onOk(id)} onLeftEdge={props.onLeftEdge} />
      <Show when={edit()}>{(e) => {
        let scrim: ElementNode | undefined;
        // A click outside the keyboard is Back (cancel). The keyboard is a screen-layer target, so this backdrop is
        // one too (an overlay backdrop would be modal and block the keys): registered before the keyboard, it loses
        // to the keys and beats the list and menu under the scrim.
        usePointerTarget({
          node: () => scrim, onClick: () => shellBack(), onContextMenu: () => shellBack(), onWheel: () => true,
        });
        return (
          <View ref={(el) => { scrim = el; }} x={0} y={0} width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim} zIndex={70}>
            <Keyboard ref={(el) => { keyboardNode = el; }} x={(LAYOUT.width - KEYBOARD_W) / 2} y={(LAYOUT.height - KEYBOARD_H) / 2}
              label={C.listName} value={e().value} error={e().error}
              onChange={(v) => { const cur = edit(); if (cur) setEdit({ ...cur, value: limitTyping(cur.value, v), error: undefined }); }}
              onDone={() => void submitRename()} />
          </View>
        );
      }}</Show>
    </>
  );
}
