import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import type { AppEvent } from '@iptv/app-api';
// Type-only: @iptv/core must stay out of the main-thread bundle.
import type { SourceConfig } from '@iptv/core';
import { api, onEvent } from '../api.ts';
import { Button, BUTTON_H } from '../components/Button.tsx';
import { Keyboard, KEYBOARD_W } from '../components/Keyboard.tsx';
import { FULL_LAYOUT } from '../components/keyboardLogic.ts';
import { FIELD_H, TextField } from '../components/TextField.tsx';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { playback } from '../playback/playback.ts';
import { applyInitState, headerSupportHere } from '../state/appState.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, LAYOUT, STRONG, TYPE } from '../shell/theme.ts';
import { WORDMARK_BOTTOM, WORDMARK_ZONE_X } from '../shell/Wordmark.tsx';
import { showToast } from '../shell/Toast.tsx';
import {
  FIELD_MAX, HEADER_FIELD_MAX, HEADER_UNUSED_NOTE, advancedHelp, headerFieldDimmed, afterAdd, backFromTypeStep, clampField, errorMessage, formFromSource, httpFormFromSource,
  progressText, revealLabel, toUpdatedSource, validateM3u, validateXtream, withHttpSettings, type HttpForm, type M3uForm, type XtreamForm,
} from './addSourceLogic.ts';

type Kind = 'xtream' | 'm3u';
type Step = 'type' | Kind;
type Progress = Extract<AppEvent, { type: 'progress' }>;

/** `url`: a web address, so the keyboard shows the `http://`, `.com`… shortcuts. */
interface FieldDef { key: string; label: string; placeholder?: string; secret?: boolean; url?: boolean }

const FIELDS: Record<Kind, FieldDef[]> = {
  xtream: [
    { key: 'name', label: 'Name (optional)', placeholder: 'My TV' },
    { key: 'server', label: 'Server', url: true },
    { key: 'username', label: 'Username' },
    { key: 'password', label: 'Password', secret: true },
  ],
  m3u: [
    { key: 'name', label: 'Name (optional)', placeholder: 'My TV' },
    { key: 'playlistUrl', label: 'Playlist URL', url: true },
    { key: 'epgUrl', label: 'TV guide URL (optional)', url: true },
  ],
};
/** Settings → source → Advanced: free text, no presets; empty means the platform's own default. */
const ADVANCED_FIELDS: FieldDef[] = [
  { key: 'userAgent', label: 'User-Agent', placeholder: 'Default' },
  { key: 'referrer', label: 'Referer', placeholder: 'Default', url: true },
];
const SUBMIT_LABEL: Record<Kind, string> = { xtream: 'Log in', m3u: 'Add' };
const FORM_TITLE: Record<Kind, string> = { xtream: 'Xtream login', m3u: 'M3U link' };

const KEYBOARD_ID = 'keyboard';
const X = LAYOUT.safeX;
const TITLE_W = WORDMARK_ZONE_X - X - LAYOUT.gap;
const FORM_Y = 170;
/** Below the brand wordmark, whose right edge overlaps the keyboard's left edge. */
const KEYBOARD_Y = WORDMARK_BOTTOM + 10;
const FIELD_STEP = FIELD_H + 20;
const FORM_W = 880;
const TILE_W = 600;
const TILE_H = 260;
/** Pointer mode: the `Show password` / `Hide password` button inside the password field's right end. */
const REVEAL_W = 240;
/** The reveal button's inset from the field's right edge. */
const REVEAL_INSET = 14;

function TypeTile(props: {
  ref: (el: ElementNode) => void; x: number; title: string; body: string; badge?: string;
  onPress: () => void; onLeft?: () => boolean; onRight?: () => boolean;
}) {
  const [focused, setFocused] = createSignal(false);
  const [hovered, setHovered] = createSignal(false);
  let node: ElementNode | undefined;
  usePointerTarget({ node: () => node, onHover: (p) => setHovered(p !== undefined), onClick: () => props.onPress() });
  const ring = () => (hovered() && pointerMode() && !focused() ? COLORS.muted : COLORS.transparent);
  return (
    <View ref={(el) => { node = el; props.ref(el); }} x={props.x} y={0} width={TILE_W} height={TILE_H} borderRadius={LAYOUT.radius}
      color={focused() ? COLORS.focus : COLORS.surface} border={{ width: 2, color: ring() }}
      onFocusChanged={setFocused}
      onEnter={() => { props.onPress(); return true; }}
      onLeft={() => props.onLeft?.() ?? false} onRight={() => props.onRight?.() ?? false}>
      <Text x={40} y={56} fontSize={TYPE.title} {...STRONG} color={focused() ? COLORS.onFocus : COLORS.text}>{props.title}</Text>
      <Text x={40} y={120} width={TILE_W - 80} maxWidth={TILE_W - 80} contain="width" fontSize={TYPE.body}
        color={focused() ? COLORS.onFocusMuted : COLORS.muted}>{props.body}</Text>
      {props.badge ? <Text x={40} y={196} fontSize={TYPE.meta} {...STRONG} color={focused() ? COLORS.onFocusMuted : COLORS.muted}>{props.badge}</Text> : null}
    </View>
  );
}

/**
 * Add source: step 1 picks the login type, step 2 shows only that form. Fields are edited with the
 * on-screen keyboard (a Back-closable overlay). The password is masked unless Yellow toggles it, and it is
 * never logged.
 *
 * Edit mode (`params.sourceId`, from Settings > Sources): the form of the source's kind, prefilled from
 * `api.getSource`, saved with `api.updateSource`; there is no type step, and Back returns to Settings. The stored
 * User-Agent and Referer are carried through.
 *
 * Advanced mode (`params.advanced` with `params.sourceId`): only the source's User-Agent and Referer fields, saved on
 * the stored source through `api.updateSource` (spec 2026-10-16-source-retry §2.7).
 */
export function AddSourceScreen(props: { entry?: ScreenEntry }) {
  const params = props.entry?.params as { sourceId?: string; advanced?: boolean } | undefined;
  const editId = params?.sourceId;
  const advanced = editId !== undefined && params?.advanced === true;
  /** Edit and Advanced modes: the source as stored, so a save keeps what the form does not show. */
  let stored: SourceConfig | undefined;
  const [http, setHttp] = createSignal<HttpForm>({ userAgent: '', referrer: '' });
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
  const fields = () => (advanced ? ADVANCED_FIELDS : FIELDS[kind()]);
  const values = (): Record<string, string> => ({ ...(advanced ? http() : kind() === 'xtream' ? xtream() : m3u()) });
  const setValue = (key: string, raw: string) => {
    // The same limits as the companion protocol (headers: the stored cap): typing stops at the field's maximum.
    const max = advanced ? HEADER_FIELD_MAX : FIELD_MAX[key];
    const v = max === undefined ? raw : clampField(raw, max);
    if (advanced) setHttp((f) => ({ ...f, [key]: v }));
    else if (kind() === 'xtream') setXtream((f) => ({ ...f, [key]: v }));
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
    // The password is shown only while it is being typed or deliberately revealed on the form.
    setRevealed(false);
    removeKeyboard = undefined;
    restoreFocus();
  };
  const openKeyboard = (key: string) => {
    if (busy()) return;
    // A click on another field while the keyboard is open switches fields: the password is hidden again.
    if (editing() !== undefined && editing() !== key) setRevealed(false);
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
    // A click on the button while the keyboard is open (the remote cannot): close it first, so typing never goes on
    // into a field after a validation error moves focus.
    if (editing() !== undefined) {
      removeKeyboard?.();
      closeKeyboard();
    }
    if (advanced) {
      await saveAdvanced();
      return;
    }
    const v = kind() === 'xtream' ? validateXtream(xtream()) : validateM3u(m3u());
    if (!v.ok) {
      setError(v.message);
      setRevealed(false);
      focusItem(fields().findIndex((f) => f.key === v.field));
      return;
    }
    setError(undefined);
    setProgress(undefined);
    setBusy(true);
    offProgress = onEvent('progress', (p) => setProgress(p as Progress));
    try {
      if (editId !== undefined) {
        await api.updateSource(toUpdatedSource(editId, v.input, stored));
        offProgress();
        // Renamed sources must show their new name everywhere; a failed re-read must not fail the save.
        try {
          applyInitState(await api.init());
        } catch (err) {
          console.warn('Refresh state after edit failed', err instanceof Error ? err.name : 'Error');
        }
        // The running stream may use the old login or address.
        if (editId === activeId) playback.stop();
        // Pop first: a toast is a Back layer, so `back()` after it would only close the toast.
        if (alive) router.back();
        showToast('Source saved');
        return;
      }
      const added = await api.addSource(v.input);
      offProgress();
      // Settings must list the new source; a failed re-read must not fail the add.
      let becameActive = !hasSources();
      try {
        const next = await api.init();
        applyInitState(next);
        becameActive = next.activeSourceId === added.sourceId;
      } catch (err) {
        console.warn('Refresh state after add failed', err instanceof Error ? err.name : 'Error');
      }
      if (!alive) return;
      const go = afterAdd({ depth: router.depth(), becameActive });
      if (go === 'replaceHome') router.replace('home');
      else if (go === 'resetHome') router.reset('home');
      else {
        // Pop first: a toast is a Back layer, so `back()` after it would only close the toast.
        router.back();
        showToast('Source added. Set it as active to watch it.');
      }
    } catch (err) {
      offProgress();
      if (!alive) return;
      // Only the name: the message is shown on screen, and nothing about the login reaches the console.
      console.warn(editId !== undefined ? 'Save source failed' : 'Add source failed', err instanceof Error ? err.name : 'Error');
      setBusy(false);
      setError(errorMessage(err));
      setRevealed(false);
      focusItem(0);
    }
  };

  /** Advanced: the stored source with the new User-Agent and Referer (free text; empty fields mean the default). */
  const saveAdvanced = async () => {
    if (!stored) return;
    setError(undefined);
    setProgress(undefined);
    setBusy(true);
    offProgress = onEvent('progress', (p) => setProgress(p as Progress));
    try {
      await api.updateSource(withHttpSettings(stored, http()));
      offProgress();
      if (stored.id === activeId) playback.stop(); // the next open uses the new headers
      if (alive) router.back();
      showToast('Source saved');
    } catch (err) {
      offProgress();
      if (!alive) return;
      console.warn('Save source failed', err instanceof Error ? err.name : 'Error');
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
      stored = src;
      setHttp(httpFormFromSource(src));
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
        <Text x={X} y={LAYOUT.safeY + 60} fontSize={TYPE.display} color={COLORS.text}>{'Add your TV source'}</Text>
        <Text x={X} y={LAYOUT.safeY + 140} fontSize={TYPE.body} color={COLORS.muted}>
          {'Use the login details from your own provider.'}
        </Text>
        <View x={X} y={340} width={tileW2} height={TILE_H}>
          <TypeTile ref={(el) => { tiles[0] = el; }} x={0} title="Xtream login" body="Server, username and password"
            badge="Most common" onPress={() => openStep('xtream')} onRight={() => focusTile(1)} />
          <TypeTile ref={(el) => { tiles[1] = el; }} x={TILE_W + LAYOUT.gap * 2} title="M3U link"
            body="Playlist URL + optional TV guide (EPG) URL" onPress={() => openStep('m3u')} onLeft={() => focusTile(0)} />
        </View>
        <Text x={X} y={700} fontSize={TYPE.body} color={COLORS.muted}>
          {'This app contains no channels. You can only add sources you have the right to use.'}
        </Text>
      </Show>

      <Show when={ready() && step() !== 'type'}>
        {/* Ends before the wordmark zone: "Advanced · <long source name>" ran under the wordmark. */}
        <Text x={X} y={LAYOUT.safeY + 40} width={TITLE_W} maxWidth={TITLE_W} contain="width" maxLines={1} fontSize={TYPE.title} color={COLORS.text}>
          {advanced ? `Advanced · ${stored?.name ?? ''}` : editId !== undefined ? `Edit source · ${FORM_TITLE[kind()]}` : FORM_TITLE[kind()]}
        </Text>
        <Show when={advanced}>
          <Text x={X} y={FORM_Y + fields().length * FIELD_STEP + 16 + BUTTON_H + 32} width={FORM_W} maxWidth={FORM_W} contain="width"
            maxLines={3} fontSize={TYPE.body} color={COLORS.muted}>
            {advancedHelp(headerSupportHere)}
          </Text>
        </Show>
        <For each={fields()}>{(f, i) => (
          <TextField ref={(el) => { items[i()] = el; }} x={X} y={FORM_Y + i() * FIELD_STEP} width={FORM_W}
            label={f.label} placeholder={f.placeholder} value={values()[f.key] ?? ''} secret={f.secret}
            revealed={f.secret ? revealed() : undefined} editing={editing() === f.key}
            hint={f.secret && !pointerMode() ? `Yellow: ${revealed() ? 'hide' : 'show'}` : undefined}
            endInset={f.secret && pointerMode() ? REVEAL_W + REVEAL_INSET : undefined}
            dimmed={advanced && headerFieldDimmed(headerSupportHere, f.key as keyof HttpForm)}
            note={advanced && headerFieldDimmed(headerSupportHere, f.key as keyof HttpForm) ? HEADER_UNUSED_NOTE : undefined}
            onEnter={() => { lastItem = i(); openKeyboard(f.key); }}
            onUp={() => focusItem(i() - 1)} onDown={() => focusItem(i() + 1)}
            onYellow={f.secret ? () => { setRevealed((r) => !r); return true; } : undefined} />
        )}</For>
        <Button ref={(el) => { items[fields().length] = el; }} x={X} y={FORM_Y + fields().length * FIELD_STEP + 16}
          width={260} label={editId !== undefined ? 'Save' : SUBMIT_LABEL[kind()]} dimmed={busy()} onPress={() => void submit()}
          onUp={() => focusItem(fields().length - 1)} onDown={() => true} />
        {/* Pointer mode: the Yellow key's action as a button inside the password field's right end. */}
        <Show when={pointerMode() && fields().some((f) => f.secret === true)}>
          <Button x={X + FORM_W - REVEAL_W - REVEAL_INSET} y={FORM_Y + fields().findIndex((f) => f.secret === true) * FIELD_STEP + (FIELD_H - BUTTON_H) / 2}
            width={REVEAL_W} label={revealLabel(revealed())} onPress={() => setRevealed((r) => !r)} />
        </Show>
        <Text x={X + 260 + LAYOUT.gap * 2} y={FORM_Y + fields().length * FIELD_STEP + 16 + (BUTTON_H - TYPE.body) / 2 - 4}
          width={FORM_W - 260 - LAYOUT.gap * 2} maxWidth={FORM_W - 260 - LAYOUT.gap * 2} contain="width" maxLines={2}
          fontSize={TYPE.body} color={busy() ? COLORS.text : COLORS.error}>{statusText()}</Text>
        {/* Pointer mode: the shell's Back button stands on this line instead. */}
        <Show when={!pointerMode()}>
          <Text x={X} y={LAYOUT.height - LAYOUT.safeY - 40} fontSize={TYPE.meta} color={COLORS.muted}>
            {editId !== undefined ? 'Ok edits a field · Back cancels' : 'Ok edits a field · Back returns to the login type'}
          </Text>
        </Show>
        <Show when={editingField()}>{(f) => (
          <Keyboard ref={(el) => { keyboard = el; }} x={LAYOUT.width - LAYOUT.safeX - KEYBOARD_W} y={KEYBOARD_Y}
            label={f().label} value={values()[f().key] ?? ''} secret={f().secret} revealed={revealed()}
            layout={f().url ? FULL_LAYOUT : undefined}
            onChange={(v) => setValue(f().key, v)} onDone={doneKeyboard}
            onToggleReveal={f().secret ? () => setRevealed((r) => !r) : undefined} />
        )}</Show>
      </Show>
    </View>
  );
}
