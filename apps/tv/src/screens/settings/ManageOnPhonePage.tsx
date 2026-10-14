import { For, Show, Text, View } from '@lightningtv/solid';
import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { api } from '../../api.ts';
import { BUTTON_H } from '../../components/Button.tsx';
import { QrCode } from '../../components/QrCode.tsx';
import { COLORS, FONT, LAYOUT } from '../../shell/theme.ts';
import { companionStatus, setCompanionStatus } from '../../state/appState.ts';
import {
  countdownLine, isPairingActive, pairingActions, shouldReuseSession, statusCopy,
  type PairingActionId, type PairingMode, type ShownPairing,
} from '../pairingLogic.ts';
import type { PageProps } from './shared.ts';

const COMPANION_ORIGIN = (import.meta.env.VITE_COMPANION_ORIGIN as string | undefined) || 'http://localhost:5174';
const PANEL_X = 28;
const QR_SIZE = 420;
const PANEL_W = 560;
const PANEL_H = QR_SIZE;
const COL_X = PANEL_X + PANEL_W + LAYOUT.gap * 2;
const ACTION_W = 480;
const ACTION_GAP = 20;
const ACTIONS_Y = 220;

/**
 * Module memory, so reopening the page shows the live session instead of replacing it (leaving the page
 * never stops the session; it runs until it expires or the user disconnects). The QR URL and code are
 * secrets: kept in memory only while their session can still be joined, drawn, never logged.
 */
const memory: { shown: ShownPairing | undefined; mode: PairingMode } = { shown: undefined, mode: 'qr' };
let startSeq = 0;

/** DEV only (`__iptv.pairing()`): what the pairing page shows, for the fake-phone dev tool. Never logged. */
export function devPairing(): ShownPairing | undefined {
  return import.meta.env.DEV ? memory.shown : undefined;
}

function companionHost(): string {
  try {
    return new URL(COMPANION_ORIGIN).host;
  } catch {
    return COMPANION_ORIGIN;
  }
}

/**
 * Settings → Manage on phone or computer: a QR code (or a 12-character code), the countdown, the connection
 * status and Show a new code / Disconnect. Opening it starts a QR session unless one is already live.
 * One focusable node: Up/Down pick an action, Ok runs it, Yellow switches between QR and code, Left → menu.
 */
export function ManageOnPhonePage(props: PageProps) {
  const [shown, setShown] = createSignal<ShownPairing | undefined>(memory.shown);
  const [mode, setMode] = createSignal<PairingMode>(memory.mode);
  const [starting, setStarting] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  /** Ticks once a second; the countdown reads the real clock when it re-evaluates (never a stale tick). */
  const [tick, setTick] = createSignal(0);
  /** The selected action by id, so it stays put when the list changes (e.g. the phone leaves). */
  const [selId, setSelId] = createSignal<PairingActionId | undefined>(undefined);
  const [focused, setFocused] = createSignal(false);
  let alive = true;

  const status = companionStatus;
  const remember = (next: ShownPairing | undefined) => {
    memory.shown = next;
    if (alive) setShown(next);
  };

  const start = async (m: PairingMode) => {
    const seq = ++startSeq;
    memory.mode = m;
    setMode(m);
    setFailed(false);
    setStarting(true);
    remember(undefined);
    try {
      const r = await api.companionStart(m);
      if (seq !== startSeq) return;
      const next: ShownPairing = { mode: m, expiresAt: r.expiresAt };
      if (r.qrUrl !== undefined) next.qrUrl = r.qrUrl;
      if (r.code !== undefined) next.code = r.code;
      remember(next);
    } catch (err) {
      if (seq !== startSeq) return;
      console.warn('Pairing start failed', err instanceof Error ? err.name : 'Error');
      if (alive) setFailed(true);
    } finally {
      if (seq === startSeq && alive) setStarting(false);
    }
  };

  const disconnect = async () => {
    ++startSeq;
    remember(undefined);
    setStarting(false);
    try {
      await api.companionStop();
    } catch (err) {
      console.warn('Pairing stop failed', err instanceof Error ? err.name : 'Error');
    }
  };

  const state = () => status().state;
  const actions = createMemo(() => pairingActions(starting() ? 'waiting' : state(), mode()));
  const selIndex = () => Math.max(0, actions().findIndex((a) => a.id === selId()));
  const moveSel = (d: 1 | -1) => {
    const list = actions();
    const next = list[Math.max(0, Math.min(list.length - 1, selIndex() + d))];
    if (next) setSelId(next.id);
    return true;
  };

  // Once the session has ended, its QR URL / code can no longer be joined: forget them.
  createEffect(on(state, (st) => {
    if (!isPairingActive(st) && !starting()) remember(undefined);
  }, { defer: true }));

  const run = (id: PairingActionId) => {
    if (id === 'toggleMode') void start(mode() === 'qr' ? 'code' : 'qr');
    else if (id === 'newCode') void start(mode());
    else void disconnect();
  };

  onMount(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    onCleanup(() => clearInterval(timer));
    void (async () => {
      let s = status();
      try {
        s = await api.companionStatus();
        if (alive) setCompanionStatus(s);
      } catch {
        // The event-fed status is good enough.
      }
      if (!alive) return;
      if (shouldReuseSession(s, memory.shown)) {
        if (memory.shown) setMode(memory.shown.mode);
        return;
      }
      void start(memory.mode);
    })();
  });
  onCleanup(() => {
    alive = false;
    props.register(undefined);
  });

  /** What the left panel shows. Secrets only while the code can still be joined. */
  const panel = (): 'qr' | 'code' | 'message' => {
    const sh = shown();
    if (starting() || failed() || !sh || state() !== 'waiting') return 'message';
    return sh.mode === 'qr' && sh.qrUrl ? 'qr' : sh.code ? 'code' : 'message';
  };
  const message = () => {
    if (failed()) return "Couldn't create a code. Check the connection and try again.";
    if (starting()) return 'Getting a code…';
    if (state() === 'connected' || state() === 'reconnecting') {
      return 'You can now manage sources, lists and groups from your phone or computer. Changes show up here right away.';
    }
    if (state() === 'waiting') return 'Getting a code…';
    return 'Show a new code to connect your phone or computer.';
  };
  const statusLine = () => {
    if (failed()) return "Couldn't create a code.";
    if (starting()) return 'Getting a code…';
    return statusCopy(status(), mode());
  };
  const countdown = () => {
    tick();
    return starting() ? '' : countdownLine(status(), Date.now());
  };
  const yellowHint = () => {
    if (state() === 'connected' || state() === 'reconnecting') return '';
    return mode() === 'qr' ? 'Yellow: use a code instead' : 'Yellow: show the QR code instead';
  };

  return (
    <View x={props.x} y={props.y} width={props.width} height={props.height}>
      <Show when={panel() === 'qr'}>
        <QrCode x={PANEL_X} size={QR_SIZE} text={shown()?.qrUrl ?? ''} />
      </Show>
      <Show when={panel() === 'code'}>
        <View x={PANEL_X} width={PANEL_W} height={PANEL_H} color={COLORS.surface} borderRadius={LAYOUT.radius}>
          <Text y={90} width={PANEL_W} maxWidth={PANEL_W} contain="width" textAlign="center" fontSize={FONT.body}
            color={COLORS.muted}>{'On your phone or computer, open'}</Text>
          <Text y={136} width={PANEL_W} maxWidth={PANEL_W} contain="width" textAlign="center" fontSize={FONT.heading}
            color={COLORS.text}>{companionHost()}</Text>
          <Text y={210} width={PANEL_W} maxWidth={PANEL_W} contain="width" textAlign="center" fontSize={FONT.body}
            color={COLORS.muted}>{'and type this code:'}</Text>
          <Text y={262} width={PANEL_W} maxWidth={PANEL_W} contain="width" textAlign="center" fontSize={60}
            color={COLORS.text}>{shown()?.code ?? ''}</Text>
        </View>
      </Show>
      <Show when={panel() === 'message'}>
        <View x={PANEL_X} width={PANEL_W} height={PANEL_H} color={COLORS.surface} borderRadius={LAYOUT.radius}>
          <Text x={32} y={40} width={PANEL_W - 64} maxWidth={PANEL_W - 64} contain="width" lineHeight={40}
            fontSize={FONT.body} color={COLORS.muted}>{message()}</Text>
        </View>
      </Show>

      <Text x={COL_X} y={0} width={props.width - COL_X - 28} maxWidth={props.width - COL_X - 28} contain="width"
        maxLines={2} lineHeight={42} fontSize={FONT.heading} color={COLORS.text}>{statusLine()}</Text>
      <Text x={COL_X} y={96} fontSize={FONT.body} color={COLORS.muted}>{countdown()}</Text>
      <Text x={COL_X} y={148} width={props.width - COL_X - 28} maxWidth={props.width - COL_X - 28} contain="width"
        fontSize={FONT.small} color={COLORS.muted}>{'The connection is end-to-end encrypted.'}</Text>

      <View ref={props.register} x={COL_X} y={ACTIONS_Y} width={ACTION_W}
        height={actions().length * (BUTTON_H + ACTION_GAP)} onFocusChanged={setFocused}
        onUp={() => moveSel(-1)} onDown={() => moveSel(1)}
        onLeft={() => props.onLeftEdge()} onRight={() => true}
        onEnter={() => { const a = actions()[selIndex()]; if (a) { setSelId(a.id); run(a.id); } return true; }}
        onYellow={() => { if (yellowHint()) run('toggleMode'); return true; }}>
        <For each={actions()}>{(a, i) => {
          const active = () => focused() && i() === selIndex();
          return (
            <View y={i() * (BUTTON_H + ACTION_GAP)} width={ACTION_W} height={BUTTON_H} borderRadius={LAYOUT.radius}
              color={active() ? COLORS.focus : COLORS.surface} border={{ width: 2, color: COLORS.focus }}>
              <Text y={(BUTTON_H - FONT.body) / 2 - 4} width={ACTION_W} maxWidth={ACTION_W} contain="width"
                textAlign="center" fontSize={FONT.body} color={active() ? COLORS.onFocus : COLORS.text}>{a.label}</Text>
            </View>
          );
        }}</For>
      </View>

      <Text x={PANEL_X} y={PANEL_H + 32} fontSize={FONT.small} color={COLORS.muted}>{yellowHint()}</Text>
    </View>
  );
}
