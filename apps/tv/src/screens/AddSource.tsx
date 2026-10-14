import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import type { AppEvent } from '@iptv/app-api';
import { api, onEvent } from '../api.ts';
import { Button, BUTTON_H } from '../components/Button.tsx';
import { Keyboard, KEYBOARD_W } from '../components/Keyboard.tsx';
import { FIELD_H, TextField } from '../components/TextField.tsx';
import { playback } from '../playback/playback.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { showToast } from '../shell/Toast.tsx';
import {
  backFromTypeStep, errorMessage, formFromSource, progressText, toUpdatedSource, validateM3u, validateXtream,
  type M3uForm, type XtreamForm,
} from './addSourceLogic.ts';

type Kind = 'xtream' | 'm3u';
type Step = 'type' | Kind;
type Progress = Extract<AppEvent, { type: 'progress' }>;

interface FieldDef { key: string; label: string; placeholder?: string; secret?: boolean }

const FIELDS: Record<Kind, FieldDef[]> = {
  xtream: [
    { key: 'name', label: 'Name (optional)', placeholder: 'My TV' },
    { key: 'server', label: 'Server' },
    { key: 'username', label: 'Username' },
    { key: 'password', label: 'Password', secret: true },
  ],
  m3u: [
    { key: 'name', label: 'Name (optional)', placeholder: 'My TV' },
    { key: 'playlistUrl', label: 'Playlist URL' },
    { key: 'epgUrl', label: 'TV guide URL (optional)' },
  ],
};
const SUBMIT_LABEL: Record<Kind, string> = { xtream: 'Log in', m3u: 'Add' };
const FORM_TITLE: Record<Kind, string> = { xtream: 'Xtream login', m3u: 'M3U link' };

const KEYBOARD_ID = 'keyboard';
const X = LAYOUT.safeX;
const FORM_Y = 170;
const FIELD_STEP = FIELD_H + 20;
const FORM_W = 880;
const TILE_W = 600;
const TILE_H = 260;
const TILE_FOCUS_FILL = 0x1b2436ff;
const ERROR_COLOR = 0xff8a80ff;

function TypeTile(props: {
  ref: (el: ElementNode) => void; x: number; title: string; body: string; badge?: string;
  onPress: () => void; onLeft?: () => boolean; onRight?: () => boolean;
}) {
  const [focused, setFocused] = createSignal(false);
  return (
    <View ref={props.ref} x={props.x} y={0} width={TILE_W} height={TILE_H} borderRadius={LAYOUT.radius}
      color={focused() ? TILE_FOCUS_FILL : COLORS.surface} border={{ width: 3, color: focused() ? COLORS.focus : 0x00000000 }}
      scale={focused() ? 1.03 : 1} onFocusChanged={setFocused}
      onEnter={() => { props.onPress(); return true; }}
      onLeft={() => props.onLeft?.() ?? false} onRight={() => props.onRight?.() ?? false}>
      <Text x={40} y={56} fontSize={40} color={COLORS.text}>{props.title}</Text>
      <Text x={40} y={120} width={TILE_W - 80} maxWidth={TILE_W - 80} contain="width" fontSize={FONT.body}
        color={COLORS.muted}>{props.body}</Text>
      {props.badge ? <Text x={40} y={196} fontSize={FONT.small} color={COLORS.focus}>{props.badge}</Text> : null}
    </View>
  );
}

/**
 * Add source: step 1 picks the login type, step 2 shows only that form. Fields are edited with the
 * on-screen keyboard (a Back-closable overlay). The password is masked unless Yellow toggles it, and it is
 * never logged.
 *
 * Edit mode (`params.sourceId`, from Settings > Sources): the form of the source's kind, prefilled from
 * `api.getSource`, saved with `api.updateSource`; there is no type step, and Back returns to Settings.
 */
export function AddSourceScreen(props: { entry?: ScreenEntry }) {
  const editId = (props.entry?.params as { sourceId?: string } | undefined)?.sourceId;
  const [step, setStep] = createSignal<Step>('type');
  // Edit mode draws nothing until the stored source has been loaded into the form.
  const [ready, setReady] = createSignal(editId === undefined);
  let activeId: string | undefined;
  const [xtream, setXtream] = createSignal<XtreamForm>({ name: '', server: '', username: '', password: '' });
  const [m3u, setM3u] = createSignal<M3uForm>({ name: '', playlistUrl: '', epgUrl: '' });
  const [editing, setEditing] = createSignal<string | undefined>(undefined);
  const [revealed, setRevealed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [progress, setProgress] = createSignal<Progress | undefined>(undefined);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [hasSources, setHasSources] = createSignal(false);

  const tiles: ElementNode[] = [];
  const items: ElementNode[] = [];
  let keyboard: ElementNode | undefined;
  let removeKeyboard: (() => void) | undefined;
  let lastTile = 0;
  let lastItem = 0;
  let alive = true;
  let offProgress: (() => void) | undefined;

  const kind = (): Kind => (step() === 'm3u' ? 'm3u' : 'xtream');
  const fields = () => FIELDS[kind()];
  const values = (): Record<string, string> => ({ ...(kind() === 'xtream' ? xtream() : m3u()) });
  const setValue = (key: string, v: string) => {
    if (kind() === 'xtream') setXtream((f) => ({ ...f, [key]: v }));
    else setM3u((f) => ({ ...f, [key]: v }));
  };

  const focusTile = (i: number) => {
    lastTile = i;
    tiles[i]?.setFocus();
    return true;
  };
  const focusItem = (i: number) => {
    const n = fields().length + 1;
    const next = Math.max(0, Math.min(n - 1, i));
    lastItem = next;
    items[next]?.setFocus();
    return true;
  };
  /** Focus after a step change or a modal closing; nodes of a new step exist only after this tick. */
  const restoreFocus = () => queueMicrotask(() => {
    if (!alive) return;
    if (editing() !== undefined) keyboard?.setFocus();
    else if (step() === 'type') focusTile(lastTile);
    else focusItem(lastItem);
  });

  const openStep = (s: Kind) => {
    setError(undefined);
    setRevealed(false);
    lastItem = 0;
    setStep(s);
    restoreFocus();
  };

  const closeKeyboard = () => {
    setEditing(undefined);
    removeKeyboard = undefined;
    restoreFocus();
  };
  const openKeyboard = (key: string) => {
    if (busy()) return;
    setEditing(key);
    removeKeyboard = router.pushOverlay(KEYBOARD_ID, closeKeyboard);
    restoreFocus();
  };
  const doneKeyboard = () => {
    // Done moves on to the next field (or the button), like Enter on a form.
    const i = fields().findIndex((f) => f.key === editing());
    if (i >= 0) lastItem = i + 1;
    removeKeyboard?.();
    closeKeyboard();
  };

  const submit = async () => {
    if (busy()) return;
    const v = kind() === 'xtream' ? validateXtream(xtream()) : validateM3u(m3u());
    if (!v.ok) {
      setError(v.message);
      focusItem(fields().findIndex((f) => f.key === v.field));
      return;
    }
    setError(undefined);
    setProgress(undefined);
    setBusy(true);
    offProgress = onEvent('progress', (p) => setProgress(p as Progress));
    try {
      if (editId !== undefined) {
        await api.updateSource(toUpdatedSource(editId, v.input));
        offProgress();
        // The running stream may use the old login or address.
        if (editId === activeId) playback.stop();
        // Pop first: a toast is a Back layer, so `back()` after it would only close the toast.
        if (alive) router.back();
        showToast('Source saved');
        return;
      }
      await api.addSource(v.input);
      offProgress();
      if (alive) router.replace('home');
    } catch (err) {
      offProgress();
      if (!alive) return;
      // Only the name: the message is shown on screen, and nothing about the login reaches the console.
      console.warn(editId !== undefined ? 'Save source failed' : 'Add source failed', err instanceof Error ? err.name : 'Error');
      setBusy(false);
      setError(errorMessage(err));
      focusItem(0);
    }
  };

  const onBack = () => {
    if (router.topOverlay() !== undefined) return false; // layered Back: the shell closes the overlay first
    if (busy()) return true;
    if (editId !== undefined) return false; // back to Settings, nothing saved
    if (step() !== 'type') {
      setError(undefined);
      setStep('type');
      restoreFocus();
      return true;
    }
    const action = backFromTypeStep({ hasSources: hasSources(), depth: router.depth() });
    if (action === 'settings') router.replace('settings');
    return action !== 'bubble';
  };

  /** Edit mode: loads the stored source into the form of its kind. */
  const loadForEdit = async (id: string) => {
    try {
      const src = await api.getSource(id);
      if (!alive) return;
      if (!src) {
        router.back();
        showToast("This source doesn't exist any more.");
        return;
      }
      const form = formFromSource(src);
      if (form.kind === 'xtream') setXtream(form.xtream);
      else setM3u(form.m3u);
      setReady(true);
      openStep(form.kind);
    } catch (err) {
      console.warn('Load source failed', err instanceof Error ? err.name : 'Error');
      if (!alive) return;
      router.back();
      showToast("Couldn't load this source.");
    }
  };

  onMount(() => {
    restoreFocus();
    api.listSources().then((s) => {
      if (!alive) return;
      setHasSources(s.length > 0);
      activeId = s.find((x) => x.active)?.id;
    }, () => { /* treat as none */ });
    if (editId !== undefined) void loadForEdit(editId);
  });
  onCleanup(() => {
    alive = false;
    offProgress?.();
    removeKeyboard?.();
  });

  const tileW2 = TILE_W * 2 + LAYOUT.gap * 2;
  const statusText = () => (busy() ? progressText(progress()) : error() ?? '');
  const editingField = () => fields().find((f) => f.key === editing());

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background} onBack={onBack}
      forwardFocus={() => { restoreFocus(); return true; }}>
      <Show when={ready() && step() === 'type'}>
        <Text x={X} y={LAYOUT.safeY + 60} fontSize={56} color={COLORS.text}>{'Add your TV source'}</Text>
        <Text x={X} y={LAYOUT.safeY + 140} fontSize={FONT.heading} color={COLORS.muted}>
          {'Use the login details from your own provider.'}
        </Text>
        <View x={X} y={340} width={tileW2} height={TILE_H}>
          <TypeTile ref={(el) => { tiles[0] = el; }} x={0} title="Xtream login" body="Server, username and password"
            badge="Most common" onPress={() => openStep('xtream')} onRight={() => focusTile(1)} />
          <TypeTile ref={(el) => { tiles[1] = el; }} x={TILE_W + LAYOUT.gap * 2} title="M3U link"
            body="Playlist URL + optional TV guide (EPG) URL" onPress={() => openStep('m3u')} onLeft={() => focusTile(0)} />
        </View>
        <Text x={X} y={700} fontSize={FONT.body} color={COLORS.muted}>
          {'This app contains no channels. You can only add sources you have the right to use.'}
        </Text>
      </Show>

      <Show when={ready() && step() !== 'type'}>
        <Text x={X} y={LAYOUT.safeY + 40} fontSize={FONT.title} color={COLORS.text}>
          {editId !== undefined ? `Edit source · ${FORM_TITLE[kind()]}` : FORM_TITLE[kind()]}
        </Text>
        <For each={fields()}>{(f, i) => (
          <TextField ref={(el) => { items[i()] = el; }} x={X} y={FORM_Y + i() * FIELD_STEP} width={FORM_W}
            label={f.label} placeholder={f.placeholder} value={values()[f.key] ?? ''} secret={f.secret}
            revealed={f.secret ? revealed() : undefined} editing={editing() === f.key}
            hint={f.secret ? `Yellow: ${revealed() ? 'hide' : 'show'}` : undefined}
            onEnter={() => openKeyboard(f.key)}
            onUp={() => focusItem(i() - 1)} onDown={() => focusItem(i() + 1)}
            onYellow={f.secret ? () => { setRevealed((r) => !r); return true; } : undefined} />
        )}</For>
        <Button ref={(el) => { items[fields().length] = el; }} x={X} y={FORM_Y + fields().length * FIELD_STEP + 16}
          width={260} label={editId !== undefined ? 'Save' : SUBMIT_LABEL[kind()]} dimmed={busy()} onPress={() => void submit()}
          onUp={() => focusItem(fields().length - 1)} onDown={() => true} />
        <Text x={X + 260 + LAYOUT.gap * 2} y={FORM_Y + fields().length * FIELD_STEP + 16 + (BUTTON_H - FONT.body) / 2 - 4}
          width={FORM_W - 260 - LAYOUT.gap * 2} maxWidth={FORM_W - 260 - LAYOUT.gap * 2} contain="width" maxLines={2}
          fontSize={FONT.body} color={busy() ? COLORS.text : ERROR_COLOR}>{statusText()}</Text>
        <Text x={X} y={LAYOUT.height - LAYOUT.safeY - 40} fontSize={FONT.small} color={COLORS.muted}>
          {editId !== undefined ? 'Ok edits a field · Back cancels' : 'Ok edits a field · Back returns to the login type'}
        </Text>
        <Show when={editingField()}>{(f) => (
          <Keyboard ref={(el) => { keyboard = el; }} x={LAYOUT.width - LAYOUT.safeX - KEYBOARD_W} y={130}
            label={f().label} value={values()[f().key] ?? ''} secret={f().secret} revealed={revealed()}
            onChange={(v) => setValue(f().key, v)} onDone={doneKeyboard}
            onToggleReveal={f().secret ? () => setRevealed((r) => !r) : undefined} />
        )}</Show>
      </Show>
    </View>
  );
}
