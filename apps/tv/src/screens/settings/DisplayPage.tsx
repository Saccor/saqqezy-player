import { Show, View, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup } from 'solid-js';
import { Keyboard, KEYBOARD_H, KEYBOARD_W } from '../../components/Keyboard.tsx';
import { SettingsList } from '../../components/SettingsList.tsx';
import { shellBack, usePointerTarget } from '../../input/pointer.ts';
import { router } from '../../shell/router.ts';
import { COLORS, LAYOUT } from '../../shell/theme.ts';
import { settings } from '../../state/appState.ts';
import { limitTyping } from '../homeMenuLogic.ts';
import { addTeamError, displayItems } from '../settingsLogic.ts';
import { saveSetting, type PageProps } from './shared.ts';

const KEYBOARD_ID = 'displayKeyboard';

/** Display: the clock, where the app opens, and the teams whose matches come first on Start. */
export function DisplayPage(props: PageProps) {
  const [sel, setSel] = createSignal(0);
  const [edit, setEdit] = createSignal<{ value: string; error?: string } | undefined>(undefined);
  let alive = true;
  let listNode: ElementNode | undefined;
  let keyboardNode: ElementNode | undefined;
  let removeKeyboard: (() => void) | undefined;
  const clock = () => settings()?.showClock ?? true;
  const openOn = () => settings()?.openOn ?? 'lastChannel';
  const teams = () => settings()?.followedTeams ?? [];
  const items = () => displayItems({ showClock: clock(), openOn: openOn(), followedTeams: teams() });

  const onAdjust = (id: string) => {
    if (id === 'clock') { void saveSetting({ showClock: !clock() }); return true; }
    if (id === 'openOn') { void saveSetting({ openOn: openOn() === 'start' ? 'lastChannel' : 'start' }); return true; }
    return false;
  };

  // The keyboard is a Back layer: Back closes it and returns to the list.
  const focusList = () => queueMicrotask(() => { if (alive && !edit()) listNode?.setFocus(); });
  const closeKeyboard = () => { removeKeyboard = undefined; setEdit(undefined); focusList(); };
  const dismissKeyboard = () => { if (edit()) { removeKeyboard?.(); closeKeyboard(); } };
  const openKeyboard = () => {
    setEdit({ value: '' });
    removeKeyboard = router.pushOverlay(KEYBOARD_ID, closeKeyboard);
    queueMicrotask(() => keyboardNode?.setFocus());
  };
  const submit = () => {
    const e = edit();
    if (!e) return;
    // Shown in the keyboard (not a toast, which would be a Back layer above it).
    const error = addTeamError(teams(), e.value);
    if (error) { setEdit({ ...e, error }); return; }
    dismissKeyboard();
    void saveSetting({ followedTeams: [...teams(), e.value.trim()] });
  };

  const onOk = async (id: string) => {
    if (onAdjust(id)) return;
    if (id === 'addTeam') { openKeyboard(); return; }
    if (id.startsWith('team:')) {
      const name = teams()[Number(id.slice(5))];
      if (name !== undefined && await props.confirm(`Stop following ${name}?`, 'Remove')) {
        // By name, captured before the dialog: the list may have changed while it was open.
        void saveSetting({ followedTeams: teams().filter((t) => t !== name) });
      }
    }
  };

  onCleanup(() => { alive = false; removeKeyboard?.(); router.removeOverlay(KEYBOARD_ID); props.register(undefined); });
  return (
    <>
      <SettingsList ref={(el) => { listNode = el; props.register(el); }} x={props.x} y={props.y} width={props.width} height={props.height}
        items={items()} selected={sel()} onSelect={setSel} onAdjust={(id) => onAdjust(id)} onOk={(id) => void onOk(id)}
        onLeftEdge={props.onLeftEdge} />
      <Show when={edit()}>{(e) => {
        let scrim: ElementNode | undefined;
        // As in ChannelsPage: a click outside the keyboard is Back (cancel).
        usePointerTarget({ node: () => scrim, onClick: () => shellBack(), onContextMenu: () => shellBack(), onWheel: () => true });
        return (
          <View ref={(el) => { scrim = el; }} x={0} y={0} width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim} zIndex={70}>
            <Keyboard ref={(el) => { keyboardNode = el; }} x={(LAYOUT.width - KEYBOARD_W) / 2} y={(LAYOUT.height - KEYBOARD_H) / 2}
              label="Team name" value={e().value} error={e().error} hint="Done adds · Back cancels"
              onChange={(v) => { const cur = edit(); if (cur) setEdit({ value: limitTyping(cur.value, v) }); }}
              onDone={submit} />
          </View>
        );
      }}</Show>
    </>
  );
}
