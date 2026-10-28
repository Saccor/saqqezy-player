/**
 * Live TV's Groups sheet (the dropdown and the search button in the ruler): other countries fold into one row (spec
 * 2026-10-22-your-countries-flags), and a keyboard beside the sheet filters the folders as the user types. Back goes up
 * a level (a query is cleared first); a pick hands the group to the screen. Not unit-tested: the pure rules live in
 * foldPickerLogic.ts and groupSearch.ts.
 */
import { Show, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal } from 'solid-js';
import type { GroupInfo } from '@iptv/core';
import { flagFor } from '../../assets/flags/index.ts';
import { KEYBOARD_H, KEYBOARD_W, Keyboard } from '../../components/Keyboard.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { SHEET_W, fromPickerRow } from '../../components/sheetLogic.ts';
import {
  TOP_LEVEL, effectiveLevel as foldEffectiveLevel, foldPick, foldView, levelRowId, levelUp, openLevel, type FoldLevel,
} from '../../components/foldPickerLogic.ts';
import { LIVE_COPY } from '../../copy.ts';
import { router } from '../../shell/router.ts';
import { LAYOUT, SPACE } from '../../shell/theme.ts';
import { settings } from '../../state/appState.ts';
import type { PickerRow } from '../homeMenuLogic.ts';
import { isGroupSearchRow, withGroupSearch } from './groupSearch.ts';

const PICKER_ID = 'liveGroups';
const GROUP_KEYBOARD_ID = 'liveGroupsKeyboard';
/** The folder search keyboard opens left of the Groups sheet (the sheet stays on the right). */
const GROUP_KB_GAP = SPACE.xl;
const GROUP_KB_X = LAYOUT.width - LAYOUT.safeX - SHEET_W - GROUP_KB_GAP - KEYBOARD_W;

export function createGroupPicker(d: {
  alive: () => boolean;
  groups: () => GroupInfo[];
  groupId: () => string | undefined;
  /** Focus back on what opened the picker (the dropdown or the search button). */
  focusPlace: (p: 'groups' | 'groupSearch') => void;
  /** A group was picked (the picker is already closed). */
  chooseGroup: (id: string) => void;
}) {
  const { alive, groups, groupId } = d;
  const [picking, setPicking] = createSignal(false);
  const [pickerLevel, setPickerLevel] = createSignal<FoldLevel>(TOP_LEVEL);
  const [pickerFocusId, setPickerFocusId] = createSignal<string | undefined>(undefined);
  let pickerNode: ElementNode | undefined;
  let removePicker: (() => void) | undefined;
  const regionsOn = () => {
    const r = settings()?.regions;
    return r !== undefined && r.mode !== 'off' && r.codes.length > 0;
  };
  /** The open level, one level up when a refresh left its country without folders (never an empty list). */
  const effectiveLevel = (): FoldLevel => foldEffectiveLevel(pickerLevel(), groups());
  // Built only while the picker is open: a library can have 1,000+ groups, and groups() changes on every refresh.
  const groupLabel = (g: { name: string; count: number }) => `${g.name} · ${g.count}`;
  // ---- folder search: a keyboard beside the picker filters the folders as the user types ----
  const [groupQuery, setGroupQuery] = createSignal('');
  const [groupKbOpen, setGroupKbOpen] = createSignal(false);
  let groupKbNode: ElementNode | undefined;
  let removeGroupKb: (() => void) | undefined;
  const pickerView = createMemo(() => {
    if (!picking()) return undefined;
    const level = effectiveLevel();
    const view = foldView(groups(), level, {
      title: LIVE_COPY.state.groups, picked: regionsOn(), currentId: groupId(), focusId: pickerFocusId(),
      label: groupLabel, flagOf: flagFor,
      onlyCount: settings()?.regions.mode === 'only' ? settings()?.regions.codes.length ?? 0 : 0,
    });
    // The first level searches every folder (folded countries too); deeper levels are already short.
    return level.kind === 'top' ? withGroupSearch(view, groups(), groupQuery(), { label: groupLabel, currentId: groupId() }) : view;
  });
  const closeGroupKeyboard = () => {
    removeGroupKb = undefined;
    setGroupKbOpen(false);
    queueMicrotask(() => { if (alive() && picking()) pickerNode?.setFocus(); });
  };
  const openGroupKeyboard = () => {
    if (groupKbOpen()) return;
    setGroupKbOpen(true);
    removeGroupKb = router.pushOverlay(GROUP_KEYBOARD_ID, closeGroupKeyboard);
    queueMicrotask(() => { if (alive()) groupKbNode?.setFocus(); });
  };
  /** Done or Right on the keyboard: to the results (the keyboard closes; the query stays). */
  const toGroupResults = () => {
    removeGroupKb?.();
    closeGroupKeyboard();
  };
  const resetGroupSearch = () => {
    removeGroupKb?.();
    removeGroupKb = undefined;
    setGroupKbOpen(false);
    setGroupQuery('');
  };
  /** Where focus returns when the picker closes without a pick: the dropdown or the search button that opened it. */
  let pickerFrom: 'groups' | 'groupSearch' = 'groups';
  /** `search`: from the search button, at the top level with the keyboard open. */
  const openPicker = (search = false) => {
    if (picking() || groups().length === 0 || router.topOverlay() !== undefined) return;
    pickerFrom = search ? 'groupSearch' : 'groups';
    // Where the open group is: inside its country when it is folded.
    setPickerLevel(search ? TOP_LEVEL : openLevel(groups(), groupId()));
    setPickerFocusId(undefined);
    setPicking(true);
    removePicker = router.pushOverlay(PICKER_ID, closePicker);
    queueMicrotask(() => { if (alive()) pickerNode?.setFocus(); });
    if (search) openGroupKeyboard();
  };
  /** Back on the picker: up one level (focus on the row that opened it), or closed from the top level. */
  function closePicker() {
    removePicker = undefined;
    // Back with a query clears it first, so the full list returns before the picker closes.
    if (groupQuery().trim() !== '') {
      setGroupQuery('');
      removePicker = router.pushOverlay(PICKER_ID, closePicker);
      return;
    }
    const level = effectiveLevel();
    const up = levelUp(level);
    if (up) {
      setPickerFocusId(levelRowId(level));
      setPickerLevel(up);
      removePicker = router.pushOverlay(PICKER_ID, closePicker);
      return;
    }
    resetGroupSearch();
    setPicking(false);
    queueMicrotask(() => { if (alive()) d.focusPlace(pickerFrom); });
  }
  /** Closes the picker at any level (a source change, cleanup). */
  const dismissPicker = () => {
    if (!picking()) return;
    removePicker?.();
    removePicker = undefined;
    setPickerLevel(TOP_LEVEL);
    resetGroupSearch();
    setPicking(false);
    queueMicrotask(() => { if (alive()) d.focusPlace(pickerFrom); });
  };
  /** OK: a level opens in place; a group goes to the screen (`chooseGroup`); "Choose countries" opens Settings. */
  const pick = (r: PickerRow) => {
    if (isGroupSearchRow(r)) {
      openGroupKeyboard();
      return;
    }
    const act = foldPick(effectiveLevel(), r);
    if (act.kind === 'level') {
      setPickerFocusId(undefined);
      setPickerLevel(act.level);
      return;
    }
    if (act.kind === 'none') return;
    removePicker?.();
    removePicker = undefined;
    resetGroupSearch();
    setPicking(false);
    setPickerLevel(TOP_LEVEL);
    if (act.kind === 'choose') {
      router.push('settings', { page: 'countries' });
      return;
    }
    d.chooseGroup(act.id);
  };

  /** The sheet and, while it is open, the search keyboard beside it. */
  const PickerView = () => (
    <Show when={pickerView()}>{(view) => {
      const rows = createMemo(() => view().rows.map(fromPickerRow));
      return (
        <>
          <Sheet ref={(el) => { pickerNode = el; }} title={view().title} rows={rows()} backLayerId={PICKER_ID}
            initial={view().initial} resetKey={view().key} onSelect={(_, i) => { const r = view().rows[i]; if (r) pick(r); }}
            pointerEnabled={!groupKbOpen()} />
          <Show when={groupKbOpen()}>
            <View zIndex={61}>
              <Keyboard ref={(el) => { groupKbNode = el; }} x={GROUP_KB_X} y={(LAYOUT.height - KEYBOARD_H) / 2}
                label={LIVE_COPY.groupSearch.keyboardLabel} value={groupQuery()}
                onChange={setGroupQuery} onDone={toGroupResults} onEdgeRight={toGroupResults} />
            </View>
          </Show>
        </>
      );
    }}</Show>
  );

  return {
    picking, openPicker, dismissPicker, View: PickerView,
    /** Unmount: the picker's back layers go (without their close handlers). */
    cleanup: () => {
      removePicker?.();
      router.removeOverlay(PICKER_ID);
      router.removeOverlay(GROUP_KEYBOARD_ID);
    },
  };
}
