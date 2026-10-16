import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { VodPlayable, VodTracks } from '@iptv/app-api';
import { api } from '../api.ts';
import { ActionBar, type Action } from '../components/ActionBar.tsx';
import { ListPicker } from '../components/ListPicker.tsx';
import { onLogicalKey } from '../input/keys.ts';
import { usePointerTarget } from '../input/pointer.ts';
import { failureText } from '../playback/failureText.ts';
import { playback } from '../playback/playback.ts';
import type { PickerRow } from './homeMenuLogic.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { BACKGROUND_RGB, COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { activeMaxConnections } from '../state/activeLimit.ts';
import { showToast } from '../shell/Toast.tsx';
import { scrimTexture } from '../vod/scrim.ts';
import { holdPress, pressSeek, SEEK_COMMIT_MS, SEEK_STEP_MS, seekStep, type HoldRun, type SeekMarker } from '../vod/seekLogic.ts';
import {
  NEXT_COUNTDOWN_S, PROGRESS_SAVE_MS, SUBTITLE_KEY_OFF, SUBTITLES_OFF, clock, cueText, findTrack, knownDuration, nextCardText,
  oneSpace, overlayVisible, pauseOnHidden, progressSaveArmed, remaining, trackKey, trackRows, tracksDue, tracksKeyId,
} from '../vod/vodPlayerLogic.ts';

const TICK_MS = 250;
const TRACKS_ID = 'vodTracks';
const CANT_PLAY_NOW = failureText({ reason: 'unavailable' }, 'video');

const BAND_H = 420;
const BAND_Y = LAYOUT.height - BAND_H;
const CONTENT_X = LAYOUT.safeX;
const CONTENT_W = LAYOUT.width - LAYOUT.safeX * 2;
const TITLE_Y = 716;
const LABEL_Y = 776;
const BAR_Y = 866;
const BAR_H = 8;
const TIMES_Y = 888;
const TIME_W = 300;
const ACTIONS_Y = 944;
const MARKER_W = 6;
const MARKER_H = 28;
const MARKER_LABEL_W = 160;
const SUB_LINE_H = 54;
const SUB_FONT = 40;
const CARD_W = 1000;
const CARD_H = 260;

const errName = (err: unknown) => (err instanceof Error ? err.name : 'Error');

/**
 * The VOD player: fullscreen video with a bottom overlay (title, progress, times, actions), pause, a seek marker that
 * commits 500 ms after the last press, resume, progress saves, audio and subtitle choices remembered per title (per series for episodes), drawn
 * subtitles for engines that cannot draw them, the next-episode card, and the failure messages.
 */
export function VodPlayScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as { playable: VodPlayable; fromStart?: boolean };
  const p = params.playable;
  const startMs = params.fromStart ? 0 : p.resumeMs;
  const standId = `vod:${p.itemId}`;

  const [now, setNow] = createSignal(Date.now());
  const [lastKeyAt, setLastKeyAt] = createSignal(Date.now());
  const [pos, setPos] = createSignal(startMs);
  const [dur, setDur] = createSignal<number | undefined>(knownDuration(undefined, p.durationMs));
  const [paused, setPaused] = createSignal(false);
  const [marker, setMarker] = createSignal<SeekMarker | undefined>(undefined);
  const [cue, setCue] = createSignal('');
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [rowsTick, setRowsTick] = createSignal(0);
  const [countdown, setCountdown] = createSignal<number | undefined>(undefined);

  let root: ElementNode | undefined;
  let barNode: ElementNode | undefined;
  let pickerNode: ElementNode | undefined;
  let cardNode: ElementNode | undefined;
  let barFocused = false;
  let alive = true;
  let lastPos: number | undefined = startMs;
  let commitTimer: ReturnType<typeof setTimeout> | undefined;
  let countdownTimer: ReturnType<typeof setInterval> | undefined;
  let rowsTimer: ReturnType<typeof setTimeout> | undefined;
  let removePicker: (() => void) | undefined;
  let hold: HoldRun | undefined;
  let endedHandled = false;
  /** One episode switch (next or previous) in flight at a time. */
  let switchBusy = false;
  /** The choices to (re)apply whenever the stream starts playing; updated by the picker. */
  const chosen: VodTracks = { ...p.tracks };
  /** The `startedAttempts` value the remembered tracks were last applied for (once per engine attempt). */
  let tracksAppliedAt: number | undefined;
  /**
   * Playhead saves wait until this attempt played near the start position (or the user seeked, or paused while it
   * played): see `progressSaveArmed`. A start at 0 is armed at once.
   */
  let saveArmed = progressSaveArmed({ armed: false, startMs, playing: false, posMs: undefined });
  /** Re-evaluates the arming from what the stream shows now (plus a user action). */
  const arm = (user: { userSeeked?: boolean; userPaused?: boolean } = {}) => {
    saveArmed = progressSaveArmed({ armed: saveArmed, startMs, playing: status()?.kind === 'playing', posMs: trustedPos(), ...user });
  };

  const status = () => playback.status();
  const failed = () => {
    const s = status();
    return s?.kind === 'failed' ? s : undefined;
  };
  const ended = () => status()?.kind === 'ended';
  /** The failure card's text: the cause and the status when known (spec 2026-10-16-source-retry §2.8). */
  const failText = () => {
    const f = failed();
    return f ? failureText({ reason: f.reason, httpStatus: f.httpStatus, maxConnections: activeMaxConnections() }, 'video') : '';
  };
  const visible = () => overlayVisible({
    paused: paused(),
    seeking: marker() !== undefined,
    problem: failed() !== undefined || ended(),
    lastKeyAt: lastKeyAt(),
    now: now(),
  });
  const bump = () => {
    const t = Date.now();
    setNow(t);
    setLastKeyAt(t);
  };
  /** The playhead and duration only while the stream is this title's (never a held title's or another one's). */
  const ours = () => playback.current()?.id === standId;
  const trustedPos = () => (ours() ? playback.positionMs() : undefined);
  const trustedDur = () => (ours() ? playback.durationMs() : undefined);
  const focusRoot = () => queueMicrotask(() => { if (alive) root?.setFocus(); });

  // ---- progress ----

  /**
   * Saves `atMs` (default: the trusted playhead, once saves are armed) when the duration is known. Never after
   * unmount.
   */
  const save = (atMs?: number) => {
    if (!alive) return;
    const d = knownDuration(trustedDur(), p.durationMs);
    if (atMs === undefined) {
      arm();
      if (!saveArmed) return;
    }
    const at = atMs ?? trustedPos();
    if (d === undefined || at === undefined || !Number.isFinite(at)) return;
    api.saveVodProgress(p.itemId, Math.max(0, Math.min(at, d)), d, p.series).catch((err) => console.warn('Progress save failed', errName(err)));
  };

  /** Stops the stream only while it is still this title's (a replace to the next episode has already started that one). */
  const stopOurs = () => {
    if (playback.current()?.id === standId) playback.stop();
  };

  const closePicker = () => {
    removePicker?.();
    removePicker = undefined;
    setPickerOpen(false);
  };

  /** Back: save, stop, leave. */
  const leave = (saveFirst = true) => {
    if (!alive) return;
    closePicker();
    if (saveFirst) save();
    stopOurs();
    alive = false;
    router.back();
  };

  // ---- pause and seek ----

  const togglePause = () => {
    bump();
    if (playback.paused()) {
      playback.resume();
    } else {
      playback.pause();
      arm({ userPaused: true }); // paused while it played: this is where they are
      save();
    }
    setPaused(playback.paused());
    return true;
  };

  const dropSeek = () => {
    if (commitTimer !== undefined) clearTimeout(commitTimer);
    commitTimer = undefined;
    setMarker(undefined);
  };

  const commitSeek = () => {
    commitTimer = undefined;
    const m = marker();
    setMarker(undefined);
    if (!m || !alive) return;
    arm({ userSeeked: true }); // the user chose this position
    playback.seek(m.targetMs);
    setPos(m.targetMs);
    lastPos = m.targetMs;
  };

  /** One press of a seek burst: moves the marker; the seek itself fires SEEK_COMMIT_MS after the last press. */
  const seekPress = (dir: 1 | -1, stepMs: number) => {
    bump();
    if (failed() || ended()) return true;
    const d = trustedDur();
    if (d === undefined || !Number.isFinite(d) || d <= 0) return true;
    setMarker(pressSeek(marker(), trustedPos() ?? pos(), d, dir, stepMs));
    if (commitTimer !== undefined) clearTimeout(commitTimer);
    commitTimer = setTimeout(commitSeek, SEEK_COMMIT_MS);
    return true;
  };
  const seekKey = (key: 'Left' | 'Right') => {
    const r = holdPress(hold, key, Date.now());
    hold = r.run;
    return seekPress(key === 'Right' ? 1 : -1, seekStep(r.heldMs));
  };

  // ---- tracks ----

  const applyTracks = () => {
    tracksAppliedAt = playback.startedAttempts();
    const a = findTrack(playback.audioTracks(), chosen.audio);
    if (a && !a.active) playback.selectAudioTrack(a.id);
    const texts = playback.textTracks();
    if (chosen.subtitle === SUBTITLE_KEY_OFF) {
      if (texts.some((t) => t.active)) playback.selectTextTrack(null);
    } else {
      const s = findTrack(texts, chosen.subtitle);
      if (s && !s.active) playback.selectTextTrack(s.id);
    }
  };

  const rows = (): PickerRow[] => {
    rowsTick();
    return trackRows(playback.audioTracks(), playback.textTracks());
  };
  /** Engines may report the new active track a moment later: read the rows now and once more shortly after. */
  const refreshRows = () => {
    setRowsTick((v) => v + 1);
    if (rowsTimer !== undefined) clearTimeout(rowsTimer);
    rowsTimer = setTimeout(() => { if (alive) setRowsTick((v) => v + 1); }, 300);
  };

  const remember = (tracks: VodTracks) => {
    // Episodes remember their choices per series; movies per title.
    api.setVodTracks(tracksKeyId(p), tracks).catch((err) => console.warn('Track save failed', errName(err)));
  };

  const pickTrack = (row: PickerRow) => {
    if (row.kind !== 'list') return;
    if (row.id === SUBTITLES_OFF) {
      playback.selectTextTrack(null);
      chosen.subtitle = SUBTITLE_KEY_OFF;
      remember({ subtitle: SUBTITLE_KEY_OFF });
      setCue('');
    } else if (row.id.startsWith('a:')) {
      const t = playback.audioTracks().find((x) => x.id === row.id.slice(2));
      if (!t) return;
      playback.selectAudioTrack(t.id);
      chosen.audio = trackKey(t);
      remember({ audio: chosen.audio });
    } else if (row.id.startsWith('s:')) {
      const t = playback.textTracks().find((x) => x.id === row.id.slice(2));
      if (!t) return;
      playback.selectTextTrack(t.id);
      chosen.subtitle = trackKey(t);
      remember({ subtitle: chosen.subtitle });
    }
    refreshRows();
  };

  const openPicker = () => {
    if (pickerOpen()) return;
    refreshRows();
    setPickerOpen(true);
    removePicker = router.pushOverlay(TRACKS_ID, () => {
      removePicker = undefined;
      setPickerOpen(false);
      focusBarOrRoot();
    });
    queueMicrotask(() => { if (alive) pickerNode?.setFocus(); });
  };

  // ---- next episode ----

  const stopCountdown = () => {
    if (countdownTimer !== undefined) clearInterval(countdownTimer);
    countdownTimer = undefined;
    setCountdown(undefined);
  };

  /**
   * Replaces this player with another episode of the same series (the next or the previous one). It starts at its own
   * `resumeMs` (0 when none). Callers save progress first.
   */
  const switchTo = async (target: { id: string } | undefined) => {
    const seriesId = p.series?.id;
    if (!target || !seriesId || switchBusy || !alive) return;
    switchBusy = true;
    stopCountdown();
    let np: VodPlayable | undefined;
    try {
      np = await api.getVodPlayable(target.id, seriesId);
    } catch (err) {
      console.warn('Episode switch failed', errName(err));
    }
    switchBusy = false;
    if (!alive) return;
    if (!np) {
      showToast(CANT_PLAY_NOW);
      if (ended()) leave(false);
      return;
    }
    closePicker();
    router.replace('vodPlay', { playable: np });
  };
  const playNext = () => switchTo(p.next);

  const startCountdown = () => {
    stopCountdown();
    setCountdown(NEXT_COUNTDOWN_S);
    countdownTimer = setInterval(() => {
      const left = (countdown() ?? 0) - 1;
      if (left <= 0) {
        void playNext();
        return;
      }
      setCountdown(left);
    }, 1000);
    queueMicrotask(() => { if (alive) cardNode?.setFocus(); });
  };

  /** Save where we are, then switch (ignored while another switch is in flight). */
  const saveAndSwitch = (target: { id: string } | undefined) => {
    if (!target || !p.series || switchBusy) return true;
    // The end card already saved the end position; the engine's playhead may now read short of it.
    if (!ended()) save();
    void switchTo(target);
    return true;
  };
  /** Channel up and the overlay's Next episode button: the next episode. */
  const nextNow = () => saveAndSwitch(p.next);
  /** Channel down: the previous episode. */
  const prevNow = () => saveAndSwitch(p.prev);

  // ---- overlay actions ----

  const actions = (): Action[] => [
    { id: 'toggle', label: paused() ? 'Play' : 'Pause', width: 180 },
    { id: 'back10', label: '−10 s', width: 160 },
    { id: 'fwd10', label: '+10 s', width: 160 },
    { id: 'tracks', label: 'Audio & subtitles', width: 320 },
    ...(p.next ? [{ id: 'next', label: 'Next episode', width: 280 }] : []),
  ];
  const onAction = (id: string) => {
    bump();
    // Failed or ended: only the card's buttons act (Next episode still may).
    if ((failed() || ended()) && id !== 'next') return;
    if (id === 'toggle') togglePause();
    else if (id === 'back10') seekPress(-1, SEEK_STEP_MS);
    else if (id === 'fwd10') seekPress(1, SEEK_STEP_MS);
    else if (id === 'tracks') openPicker();
    else if (id === 'next') nextNow();
  };
  const focusBar = () => {
    bump();
    queueMicrotask(() => { if (alive && visible()) barNode?.setFocus(); });
    return true;
  };
  /** After an overlay closes: the bar when it still shows, else the root. */
  function focusBarOrRoot() {
    queueMicrotask(() => {
      if (!alive) return;
      if (visible() && barNode) barNode.setFocus();
      else root?.setFocus();
    });
  }

  const retry = () => {
    bump();
    // Until saves are armed the playhead is not the title's real position (it never played, or dropped the start seek).
    playback.playVod(p, saveArmed ? (lastPos ?? startMs) : startMs);
    focusRoot();
  };
  const cardActions = (): Action[] => (failed()
    ? [{ id: 'retry', label: 'Try again', width: 260 }]
    : [{ id: 'nextNow', label: 'Play now', width: 260 }, { id: 'cancel', label: 'Cancel', width: 220 }]);
  const onCardAction = (id: string) => {
    if (id === 'retry') retry();
    else if (id === 'nextNow') void playNext();
    else if (id === 'cancel') { stopCountdown(); leave(false); }
  };

  // ---- keys ----

  const onEnter = () => {
    if (failed() || ended()) return true;
    if (!visible()) {
      bump();
      if (!playback.paused()) togglePause();
      return true;
    }
    return togglePause();
  };
  const onBack = () => {
    if (router.topOverlay() !== undefined) return false; // the shell closes the picker first
    stopCountdown();
    leave(!ended());
    return true;
  };

  // The whole screen: moving the pointer shows the overlay, so its buttons can be clicked.
  usePointerTarget({
    node: () => root,
    onHover: (pt) => { if (pt) bump(); },
    onClick: () => bump(),
  });

  // ---- reactions ----

  // A (re)start that reaches 'playing': re-apply the remembered tracks at once (the tick catches a quick reopen).
  createEffect(on(() => status()?.kind, (kind) => {
    if (kind === 'playing') applyTracks();
  }));

  // Ended: save the end position; offer the next episode, else return to the detail.
  createEffect(on(ended, (isEnded) => {
    if (!isEnded || endedHandled) return;
    endedHandled = true;
    dropSeek();
    const d = knownDuration(trustedDur(), p.durationMs);
    if (d !== undefined) save(d);
    closePicker();
    if (p.next && p.series) startCountdown();
    else queueMicrotask(() => { if (alive) leave(false); });
  }));

  // A failure with a Try again button takes the focus; any other failure leaves it on the root (Back still works).
  createEffect(on(() => failed()?.reason, (reason) => {
    if (reason === undefined) return;
    dropSeek();
    closePicker();
    if (reason !== 'unsupported') queueMicrotask(() => { if (alive) cardNode?.setFocus(); });
    else focusRoot();
  }));

  // The overlay hid while its bar had the focus: give it back to the root (focus is never on a hidden node).
  createEffect(on(visible, (v) => {
    if (!v && barFocused && !pickerOpen()) focusRoot();
  }));

  // ---- lifecycle ----

  onMount(() => {
    playback.setRect('fullscreen');
    playback.playVod(p, startMs);
    root?.setFocus();

    const tick = setInterval(() => {
      setNow(Date.now());
      const at = trustedPos();
      if (at !== undefined && Number.isFinite(at)) {
        setPos(at);
        lastPos = at;
      }
      setDur(knownDuration(trustedDur(), p.durationMs));
      setPaused(playback.paused());
      // A new engine attempt plays (a quick reopen may never leave 'playing'): re-apply the remembered tracks.
      if (tracksDue(tracksAppliedAt, playback.startedAttempts(), status()?.kind === 'playing')) applyTracks();
      // Arm progress saves as soon as the start seek has landed.
      if (!saveArmed) arm();
    }, TICK_MS);
    const saver = setInterval(() => {
      if (status()?.kind === 'playing' && !playback.paused()) save();
    }, PROGRESS_SAVE_MS);
    // Hidden: save and pause; visible again stays paused until the user presses Ok.
    const onVisibility = () => {
      if (!document.hidden) return;
      save();
      if (pauseOnHidden({ hidden: true, paused: playback.paused(), problem: failed() !== undefined || ended() })) {
        playback.pause();
        setPaused(playback.paused());
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    // A released Left/Right ends the hold run (the next press steps 10 s again).
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === 'Left' || e.key === 'Right') hold = undefined; };
    document.addEventListener('keyup', onKeyUp);
    const offKeys = onLogicalKey(() => bump());
    const offSubs = playback.onSubtitle((text) => { if (alive) setCue(cueText(text)); });
    onCleanup(() => {
      clearInterval(tick);
      clearInterval(saver);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('keyup', onKeyUp);
      offKeys();
      offSubs();
    });
  });

  onCleanup(() => {
    alive = false;
    dropSeek();
    if (rowsTimer !== undefined) clearTimeout(rowsTimer);
    if (countdownTimer !== undefined) clearInterval(countdownTimer);
    removePicker?.();
    router.removeOverlay(TRACKS_ID);
    stopOurs();
  });

  // ---- drawing ----

  const fraction = (ms: number) => {
    const d = dur();
    return d === undefined ? 0 : Math.max(0, Math.min(1, ms / d));
  };
  const title = oneSpace(p.title);
  const label = p.episodeLabel ? oneSpace(p.episodeLabel) : '';
  const statusText = () => {
    const s = status();
    // No status: the open is held (refusal cooldown or open-rate cap) and will start by itself.
    return s === undefined || s.kind === 'loading' ? 'Loading…' : s.kind === 'reconnecting' ? 'Reconnecting…' : '';
  };
  const subLines = () => cue().split('\n').length;
  const subY = () => (visible() ? BAND_Y + 40 : LAYOUT.height - LAYOUT.safeY - 20) - subLines() * SUB_LINE_H;
  const PILL_W = 420;

  return (
    <View ref={(el) => { root = el; }} width={LAYOUT.width} height={LAYOUT.height}
      onBack={onBack} onEnter={onEnter}
      onLeft={() => seekKey('Left')} onRight={() => seekKey('Right')}
      onUp={focusBar} onDown={focusBar}
      onPlayPause={() => (failed() || ended() ? true : togglePause())}
      onChannelUp={nextNow} onChannelDown={prevNow}>

      {/* Subtitles: above the video, below the overlay; lifted above the band while it shows. */}
      <Show when={cue()}>
        <Text zIndex={5} x={CONTENT_X} y={subY()} width={CONTENT_W} maxWidth={CONTENT_W} contain="width" textAlign="center"
          maxLines={3} fontSize={SUB_FONT} lineHeight={SUB_LINE_H} color={COLORS.text}>{cue()}</Text>
      </Show>

      <Show when={visible()}>
        <View zIndex={10} width={LAYOUT.width} height={LAYOUT.height}>
          <View y={BAND_Y} width={LAYOUT.width} height={BAND_H} src={scrimTexture('down', BACKGROUND_RGB)} />
          <Text x={CONTENT_X} y={TITLE_Y} width={CONTENT_W} maxWidth={CONTENT_W} contain="width" maxLines={1}
            fontSize={FONT.title} color={COLORS.text}>{title}</Text>
          <Show when={label}>
            <Text x={CONTENT_X} y={LABEL_Y} width={CONTENT_W - MARKER_LABEL_W} maxWidth={CONTENT_W - MARKER_LABEL_W} contain="width"
              maxLines={1} fontSize={FONT.body} color={COLORS.muted}>{label}</Text>
          </Show>
          <View x={CONTENT_X} y={BAR_Y} width={CONTENT_W} height={BAR_H} borderRadius={BAR_H / 2} color={COLORS.surface} />
          <View x={CONTENT_X} y={BAR_Y} width={Math.max(BAR_H, CONTENT_W * fraction(pos()))} height={BAR_H} borderRadius={BAR_H / 2}
            color={COLORS.focus} />
          <Show when={marker()}>{(m) => {
            const mx = () => CONTENT_X + CONTENT_W * fraction(m().targetMs);
            return (
              <View>
                <View x={mx() - MARKER_W / 2} y={BAR_Y + BAR_H / 2 - MARKER_H / 2} width={MARKER_W} height={MARKER_H}
                  borderRadius={MARKER_W / 2} color={COLORS.text} />
                <Text x={Math.max(CONTENT_X, Math.min(CONTENT_X + CONTENT_W - MARKER_LABEL_W, mx() - MARKER_LABEL_W / 2))}
                  y={BAR_Y - 50} width={MARKER_LABEL_W} maxWidth={MARKER_LABEL_W} contain="width" textAlign="center" maxLines={1}
                  fontSize={FONT.body} color={COLORS.text}>{clock(m().targetMs)}</Text>
              </View>
            );
          }}</Show>
          <Text x={CONTENT_X} y={TIMES_Y} width={TIME_W} maxWidth={TIME_W} contain="width" maxLines={1}
            fontSize={FONT.small} color={COLORS.text}>{clock(pos())}</Text>
          <Show when={dur() !== undefined}>
            <Text x={CONTENT_X + CONTENT_W - TIME_W} y={TIMES_Y} width={TIME_W} maxWidth={TIME_W} contain="width" textAlign="right"
              maxLines={1} fontSize={FONT.small} color={COLORS.text}>{remaining(pos(), dur() ?? 0)}</Text>
          </Show>
          <ActionBar ref={(el) => { barNode = el; }} x={CONTENT_X} y={ACTIONS_Y} actions={actions()} onAction={onAction}
            onUp={() => { root?.setFocus(); return true; }} onDown={() => true}
            onFocusChanged={(f) => { barFocused = f; }} />
        </View>
      </Show>

      <Show when={statusText() && !failed()}>
        <View zIndex={20} x={(LAYOUT.width - PILL_W) / 2} y={LAYOUT.safeY} width={PILL_W} height={64} color={COLORS.panel}
          borderRadius={32}>
          <Text y={(64 - FONT.body) / 2 - 4} width={PILL_W} maxWidth={PILL_W} contain="width" textAlign="center"
            fontSize={FONT.body} color={COLORS.text}>{statusText()}</Text>
        </View>
      </Show>

      <Show when={failed() || (countdown() !== undefined && p.next)}>
        <View zIndex={30} x={(LAYOUT.width - CARD_W) / 2} y={(LAYOUT.height - CARD_H) / 2 - 120} width={CARD_W} height={CARD_H}
          color={COLORS.panel} borderRadius={LAYOUT.radius * 2}>
          {/* A refusal that names the account's limit is long: it takes three body-size lines above the buttons. */}
          <Text x={40} y={failText().length > 80 ? 36 : 48} width={CARD_W - 80} maxWidth={CARD_W - 80} contain="width"
            textAlign="center" maxLines={failText().length > 80 ? 3 : 2}
            fontSize={failText().length > 80 ? FONT.body : FONT.heading} color={COLORS.text}>
            {failed() ? failText() : nextCardText(oneSpace(p.next?.label ?? ''), countdown() ?? 0)}
          </Text>
          <Show when={failed()?.reason !== 'unsupported'}>
            <ActionBar ref={(el) => { cardNode = el; }}
              x={(CARD_W - cardActions().reduce((w, a) => w + a.width + 16, -16)) / 2} y={CARD_H - 72 - 40}
              actions={cardActions()} onAction={onCardAction} />
          </Show>
        </View>
      </Show>

      <Show when={pickerOpen()}>
        <ListPicker ref={(el) => { pickerNode = el; }} title="Audio & subtitles" rows={rows()} onPick={pickTrack}
          hint="Ok chooses · Back closes" />
      </Show>
    </View>
  );
}
