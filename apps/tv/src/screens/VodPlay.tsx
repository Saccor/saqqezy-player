import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { VodPlayable, VodTracks } from '@iptv/app-api';
import { cueAt, type LoadedSubtitle, type SubtitleInput } from '@iptv/core';
import { api } from '../api.ts';
import { ActionBar, type Action } from '../components/ActionBar.tsx';
import { Keyboard, KEYBOARD_H, KEYBOARD_W } from '../components/Keyboard.tsx';
import { ListPicker } from '../components/ListPicker.tsx';
import { MESSAGE_BOXES, fitsBox, messageTop } from '../components/messageFit.ts';
import { onLogicalKey } from '../input/keys.ts';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { SHELL_BACK_LABEL } from '../shell/logic.ts';
import { failureText } from '../playback/failureText.ts';
import { playback } from '../playback/playback.ts';
import type { PickerRow } from './homeMenuLogic.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { BACKGROUND_RGB, COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { activeMaxConnections } from '../state/activeLimit.ts';
import { platformId, settings } from '../state/appState.ts';
import { isTvPlatform } from '../video/engineConfig.ts';
import { showToast, useToastFloor } from '../shell/Toast.tsx';
import { scrimTexture } from '../vod/scrim.ts';
import { Timeline, TIMELINE_H } from '../components/Timeline.tsx';
import { VolumeControl, VolumeOsd } from '../components/VolumeOsd.tsx';
import { volumeStep, volumeSupported } from '../video/volume.ts';
import { BUTTON_H } from '../components/Button.tsx';
import { iconTexture } from '../vod/icons.ts';
import {
  commitDelayMs, dragScrub, holdPress, pressScrub, SEEK_STEP_MS, seekStep, SKIP_LONG_MS, type HoldRun, type Scrub,
} from '../vod/seekLogic.ts';
import { bufferedEndMs, elapsedText, groupXs, remainingText } from '../vod/timelineLogic.ts';
import {
  NEXT_COUNTDOWN_S, PROGRESS_SAVE_MS, SUBTITLE_KEY_OFF, SUBTITLES_OFF, cueText, findTrack, knownDuration, nextCardText, noSoundText,
  oneSpace, overlayVisible, pauseOnHidden, progressSaveArmed, shapeCheckDue, trackKey, trackRows, trackShape, tracksDue, tracksKeyId,
} from '../vod/vodPlayerLogic.ts';
import {
  ANOTHER_VERSION_ROW, DELAY_EARLIER_ROW, DELAY_LATER_ROW, DELAY_POINTER_STEP_MS, DELAY_ROW, FIND_ONLINE_ROW, LOAD_FILE_ROW, LOAD_URL_ROW,
  REMOVE_EXT_ROW, SUBTITLE_EXT_ROW, SUBTITLE_KEY_EXT, onlineFileId, onlineLanguageLabel, onlineLanguageRows, stepDelay, type OnlineLanguage,
  pickSubtitle, subtitleExtraRows,
} from '../vod/subtitleLogic.ts';

const TICK_MS = 250;
const TRACKS_ID = 'vodTracks';
const SUB_URL_ID = 'vodSubtitleLink';
const SUB_ONLINE_ID = 'vodSubtitleOnline';
/** OpenSubtitles' free plan asks for this line wherever its subtitles are picked. */
const ONLINE_ATTRIBUTION = 'Subtitles provided by OpenSubtitles.com';
/** How often a loaded subtitle file's cue is looked up (the engines' own subtitles poll at the same rate). */
const EXT_SUB_POLL_MS = 250;
/** A file picker exists on computers only (TV engines have no file dialog). */
const CAN_LOAD_FILE = !isTvPlatform(platformId);
const SUBTITLE_FILE_TYPES = '.srt,.vtt,text/vtt,application/x-subrip';
const CANT_PLAY_NOW = failureText({ reason: 'unavailable' }, 'video');

/** The controls' dark band: tall enough that the title (y 596) sits where it is still ~75% dark. */
const BAND_H = 620;
const BAND_Y = LAYOUT.height - BAND_H;
const CONTENT_X = LAYOUT.safeX;
const CONTENT_W = LAYOUT.width - LAYOUT.safeX * 2;
const TITLE_Y = 596;
const LABEL_Y = 654;
/** The timeline's hit area; the scrub bubble (88 px) sits above it, clear of the label (ends ~690). */
const TIMELINE_Y = 788;
const TIMES_Y = TIMELINE_Y + TIMELINE_H + 6;
const TIME_W = 600;
const ACTIONS_Y = 916;
/** Control row: the transport icons (round) and the text buttons. */
const ROUND_W = BUTTON_H;
const BACK_W = 180;
const TRACKS_W = 320;
const NEXT_W = 280;
/** The volume control at the row's left end (desktop only: TVs keep their remote's volume). */
const VOLUME_W = 300;
const SUB_LINE_H = 54;
const SUB_OUTLINE: [number, number][] = [[-2, -2], [2, -2], [-2, 2], [2, 2], [0, 3]];
const SUB_OUTLINE_COLOR = 0x000000e6;
const SUB_FONT = 40;
const CARD_W = 1000;
const CARD_H = 260;
/** The card's text area, between its top margin (24) and its buttons (y 148). */
const CARD_TEXT_H = 124;

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
  /** A pending seek (keys, ±10 or a drag): Ok or its idle timer commits it, Back cancels it. */
  const [scrub, setScrub] = createSignal<Scrub | undefined>(undefined);
  /** A pointer drag on the timeline is held (the overlay stays up). */
  const [dragging, setDragging] = createSignal(false);
  const [bufEnd, setBufEnd] = createSignal<number | undefined>(undefined);
  const [cue, setCue] = createSignal('');
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [rowsTick, setRowsTick] = createSignal(0);
  const [countdown, setCountdown] = createSignal<number | undefined>(undefined);
  /** Subtitles the user loaded for this title (a link or a file), and whether they show instead of the stream's. */
  const [external, setExternal] = createSignal<LoadedSubtitle | undefined>(undefined);
  const [extOn, setExtOn] = createSignal(false);
  /** The link being typed for "Load subtitles from a link…" (undefined: the keyboard is closed). */
  const [linkText, setLinkText] = createSignal<string | undefined>(undefined);
  const [linkError, setLinkError] = createSignal<string | undefined>(undefined);
  const [subBusy, setSubBusy] = createSignal(false);
  /** "Find subtitles online" is set up (the worker has the service's key). */
  const [onlineOk, setOnlineOk] = createSignal(false);
  /** The "Subtitles online" picker's rows (undefined: closed). */
  const [onlineRows, setOnlineRows] = createSignal<PickerRow[] | undefined>(undefined);
  /** The loaded file's delay: how much later (positive) or earlier its cues show. Kept with the file. */
  const [subDelay, setSubDelay] = createSignal(0);
  /** The loaded file came from "Find subtitles online": its language's versions, best first, and which one shows. */
  const [onlineVersion, setOnlineVersion] = createSignal<{ label: string; files: number[]; index: number } | undefined>(undefined);

  let root: ElementNode | undefined;
  let barNode: ElementNode | undefined;
  let timelineNode: ElementNode | undefined;
  let pickerNode: ElementNode | undefined;
  let keyboardNode: ElementNode | undefined;
  let removeLinkEntry: (() => void) | undefined;
  let onlineNode: ElementNode | undefined;
  let removeOnline: (() => void) | undefined;
  /** Bumped per search, so a search answered after its picker closed changes nothing. */
  let onlineSearch = 0;
  /** The languages of the last online search (each with its versions). */
  let onlineLangs: OnlineLanguage[] = [];
  let delaySaveTimer: ReturnType<typeof setTimeout> | undefined;
  let cardNode: ElementNode | undefined;
  let barFocused = false;
  let timelineFocused = false;
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
  /** The no-sound toast was shown (once per title). */
  let soundWarned = false;
  /** The choices to (re)apply whenever the stream starts playing; updated by the picker. */
  const chosen: VodTracks = { ...p.tracks };
  /** The `startedAttempts` value the remembered tracks were last applied for (once per engine attempt). */
  let tracksAppliedAt: number | undefined;
  /** The track lists' shape when they were last applied (`trackShape`): late tracks re-apply the choices. */
  let tracksAppliedShape: string | undefined;
  /** Ticks since the tracks were last applied (`shapeCheckDue`). */
  let shapeTicks = 0;
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
  const visible = () => overlayVisible({
    paused: paused(),
    seeking: scrub() !== undefined || dragging(),
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
    closeLinkEntry();
    closeOnline();
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

  const clearCommit = () => {
    if (commitTimer !== undefined) clearTimeout(commitTimer);
    commitTimer = undefined;
  };
  /** Drops a pending seek without seeking (Back, a failure, the end). A held drag stops following the pointer. */
  const dropSeek = () => {
    clearCommit();
    setScrub(undefined);
    setDragging(false);
  };

  const commitSeek = () => {
    const s = scrub();
    dropSeek();
    if (!s || !alive) return;
    arm({ userSeeked: true }); // the user chose this position
    playback.seek(s.targetMs);
    setPos(s.targetMs);
    setBufEnd(undefined); // the buffer reading is the old position's until the engine reports again
    lastPos = s.targetMs;
  };

  /** The duration a seek may use now; undefined while the title failed, ended or has no known length. */
  const seekableDur = () => {
    if (failed() || ended()) return undefined;
    const d = trustedDur();
    return d !== undefined && Number.isFinite(d) && d > 0 ? d : undefined;
  };
  const playhead = () => trustedPos() ?? pos();

  /** One press of a scrub (Left/Right) or skip (±10): moves the target; it commits after its source's idle delay. */
  const scrubPress = (dir: 1 | -1, stepMs: number, source: 'keys' | 'skip') => {
    bump();
    const d = seekableDur();
    if (d === undefined || dragging()) return true;
    const s = pressScrub(scrub(), playhead(), d, dir, stepMs, source);
    setScrub(s);
    clearCommit();
    const wait = commitDelayMs(s.source);
    if (wait !== undefined) commitTimer = setTimeout(commitSeek, wait);
    return true;
  };
  const scrubKey = (key: 'Left' | 'Right') => {
    const r = holdPress(hold, key, Date.now());
    hold = r.run;
    return scrubPress(key === 'Right' ? 1 : -1, seekStep(r.heldMs), 'keys');
  };

  /** A click on the timeline: seek there at once. */
  const pointerSeek = (fraction: number) => {
    bump();
    const d = seekableDur();
    if (d === undefined) return;
    setScrub(dragScrub(scrub(), playhead(), d, fraction));
    commitSeek();
  };
  /** A drag on the timeline moves the target live; the release commits it, Back (or a lost drag) drops it. */
  const onDrag = (fraction: number, phase: 'start' | 'move' | 'end' | 'cancel') => {
    bump();
    if (phase === 'cancel') {
      if (dragging()) dropSeek();
      return;
    }
    if (phase !== 'start' && !dragging()) return; // Back cancelled this drag: ignore it until the release
    const d = seekableDur();
    if (d === undefined) {
      dropSeek();
      return;
    }
    if (phase === 'start') {
      clearCommit();
      setDragging(true);
    }
    setScrub(dragScrub(scrub(), playhead(), d, fraction));
    if (phase === 'end') commitSeek();
  };

  // ---- tracks ----

  const applyTracks = () => {
    tracksAppliedAt = playback.startedAttempts();
    const audios = playback.audioTracks();
    const texts = playback.textTracks();
    tracksAppliedShape = trackShape(audios, texts);
    shapeTicks = 0;
    const a = findTrack(audios, chosen.audio);
    if (a && !a.active) playback.selectAudioTrack(a.id);
    applySubtitle(texts);
  };

  /** The remembered subtitle choice, else the preferred language from Settings (`pickSubtitle`). */
  const applySubtitle = (texts = playback.textTracks()) => {
    const pick = pickSubtitle({
      chosen: chosen.subtitle, texts, hasExternal: external() !== undefined, preferred: settings()?.subtitleLanguage ?? 'off',
    });
    if (pick.kind === 'external' || pick.kind === 'off') {
      if (texts.some((t) => t.active)) playback.selectTextTrack(null);
    } else if (pick.kind === 'track') {
      const t = texts.find((x) => x.id === pick.id);
      if (t && !t.active) playback.selectTextTrack(t.id);
    }
    showExternal(pick.kind === 'external');
  };

  /** Shows (or stops showing) the loaded subtitle file; the cue on screen is cleared either way. */
  const showExternal = (on: boolean) => {
    if (on === extOn()) return;
    setExtOn(on);
    setCue('');
  };

  const rows = (): PickerRow[] => {
    rowsTick();
    const ext = external();
    const on = extOn();
    // A loaded file showing: "Subtitles off" is not checked (the stream's tracks are all off).
    const base = trackRows(playback.audioTracks(), playback.textTracks())
      .map((r) => (r.kind === 'list' && r.id === SUBTITLES_OFF && on ? { ...r, checked: false } : r));
    return [...base, ...subtitleExtraRows({
      external: ext && { name: oneSpace(ext.name), active: on }, canLoadFile: CAN_LOAD_FILE, canSearchOnline: onlineOk(),
      delayMs: subDelay(), pointer: pointerMode(),
      ...(onlineVersion() ? { another: { label: onlineVersion()!.label, index: onlineVersion()!.index, total: onlineVersion()!.files.length } } : {}),
    })];
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
    if (row.id === DELAY_EARLIER_ROW || row.id === DELAY_LATER_ROW) {
      changeDelay(row.id === DELAY_LATER_ROW ? 1 : -1, DELAY_POINTER_STEP_MS);
      return;
    }
    if (row.id === DELAY_ROW) return; // Left/Right change it
    if (row.id === ANOTHER_VERSION_ROW) {
      closePicker();
      anotherVersion();
      return;
    }
    if (row.id === FIND_ONLINE_ROW) {
      closePicker();
      openOnline();
      return;
    }
    if (row.id === LOAD_URL_ROW) {
      closePicker();
      openLinkEntry();
      return;
    }
    if (row.id === LOAD_FILE_ROW) {
      closePicker();
      pickFile();
      return;
    }
    if (row.id === REMOVE_EXT_ROW) {
      removeExternal();
      refreshRows();
      return;
    }
    if (row.id === SUBTITLE_EXT_ROW) {
      useExternal();
    } else if (row.id === SUBTITLES_OFF) {
      playback.selectTextTrack(null);
      showExternal(false);
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
      showExternal(false);
      chosen.subtitle = trackKey(t);
      remember({ subtitle: chosen.subtitle });
    }
    refreshRows();
  };

  // ---- subtitles from a link or a file ----

  /** The loaded file on, the stream's subtitles off; remembered like any other subtitle choice. */
  const useExternal = () => {
    if (!external()) return;
    if (playback.textTracks().some((t) => t.active)) playback.selectTextTrack(null);
    showExternal(true);
    chosen.subtitle = SUBTITLE_KEY_EXT;
    remember({ subtitle: SUBTITLE_KEY_EXT });
  };

  /** Left/Right on the delay row (or a pointer row): move the loaded file's cues; saved shortly after the last press. */
  const changeDelay = (dir: 1 | -1, step?: number) => {
    const next = stepDelay(subDelay(), dir, step);
    setSubDelay(next);
    refreshRows();
    if (delaySaveTimer !== undefined) clearTimeout(delaySaveTimer);
    delaySaveTimer = setTimeout(() => {
      delaySaveTimer = undefined;
      api.setSubtitleDelay(p.itemId, next).catch((err) => console.warn('Subtitle delay save failed', errName(err)));
    }, 400);
  };
  const adjustRow = (row: PickerRow, dir: 1 | -1) => {
    if (row.kind !== 'list' || row.id !== DELAY_ROW) return false;
    changeDelay(dir);
    return true;
  };

  /** The next version of the same language from the last online search (wrapping). */
  const anotherVersion = () => {
    const v = onlineVersion();
    if (!v || v.files.length < 2 || subBusy()) return;
    const index = (v.index + 1) % v.files.length;
    const fileId = v.files[index];
    if (fileId === undefined) return;
    void loadWith(() => api.loadOnlineSubtitle(p.itemId, fileId, v.label), `${v.label} (version ${index + 1} of ${v.files.length})`).then((error) => {
      if (!alive) return;
      if (error) showToast(error);
      else setOnlineVersion({ ...v, index });
    });
  };

  const removeExternal = () => {
    api.clearSubtitle(p.itemId).catch((err) => console.warn('Subtitle remove failed', errName(err)));
    setOnlineVersion(undefined);
    setExternal(undefined);
    showExternal(false);
    // It was the choice: the preferred language takes over (the choice stays for the series' other episodes).
    if (chosen.subtitle === SUBTITLE_KEY_EXT) applySubtitle();
  };

  /** Loads, keeps and turns on a subtitle file; returns the error to show (a message meant for the user). */
  const loadSubtitle = (input: SubtitleInput) => loadWith(() => api.loadSubtitle(p.itemId, input)).then((error) => {
    if (!error) setOnlineVersion(undefined); // a link or file: not one of the online versions
    return error;
  });

  /** A newly loaded file starts with no delay. `toastName`: what the toast calls it (default: its name). */
  const loadWith = async (load: () => Promise<LoadedSubtitle>, toastName?: string): Promise<string | undefined> => {
    if (subBusy()) return undefined;
    setSubBusy(true);
    try {
      const loaded = await load();
      if (!alive) return undefined;
      setExternal(loaded);
      setSubDelay(loaded.delayMs ?? 0);
      useExternal();
      showToast(`Subtitles on: ${oneSpace(toastName ?? loaded.name)}`);
      return undefined;
    } catch (err) {
      console.warn('Subtitle load failed', errName(err));
      return err instanceof Error && err.name === 'SubtitleError' ? err.message : "Couldn't load the subtitles.";
    } finally {
      setSubBusy(false);
    }
  };

  // ---- subtitles found online ----

  function closeOnline() {
    onlineSearch++;
    removeOnline?.();
    removeOnline = undefined;
    setOnlineRows(undefined);
  }

  /** The "Subtitles online" picker: a searching row at once, then one row per language found for this title. */
  const openOnline = () => {
    const search = ++onlineSearch;
    setOnlineRows([{ kind: 'list', id: 'searching', label: 'Searching…', checked: false }]);
    removeOnline = router.pushOverlay(SUB_ONLINE_ID, () => {
      onlineSearch++;
      removeOnline = undefined;
      setOnlineRows(undefined);
      focusBarOrRoot();
    });
    queueMicrotask(() => { if (alive) onlineNode?.setFocus(); });
    api.findSubtitlesOnline(p.itemId, p.series?.id).then((langs) => {
      if (!alive || search !== onlineSearch) return;
      if (langs.length === 0) {
        closeOnline();
        focusBarOrRoot();
        showToast('No subtitles found online for this title.');
        return;
      }
      onlineLangs = langs;
      setOnlineRows(onlineLanguageRows(langs));
    }, (err) => {
      console.warn('Subtitle search failed', errName(err));
      if (!alive || search !== onlineSearch) return;
      closeOnline();
      focusBarOrRoot();
      showToast(err instanceof Error && err.name === 'SubtitleError' ? err.message : "Couldn't search for subtitles.");
    });
  };

  /** A language picked: download its best file and turn it on. */
  const pickOnline = (row: PickerRow) => {
    if (row.kind !== 'list') return;
    const fileId = onlineFileId(row.id);
    if (fileId === undefined || subBusy()) return;
    const lang = onlineLangs.find((l) => l.fileId === fileId);
    const label = lang ? onlineLanguageLabel(lang.language) : row.label;
    void loadWith(() => api.loadOnlineSubtitle(p.itemId, fileId, label)).then((error) => {
      if (!alive) return;
      closeOnline();
      focusBarOrRoot();
      if (error) showToast(error);
      else setOnlineVersion({ label, files: lang?.files?.length ? lang.files : [fileId], index: 0 });
    });
  };

  function closeLinkEntry() {
    removeLinkEntry?.();
    removeLinkEntry = undefined;
    setLinkText(undefined);
    setLinkError(undefined);
  }
  const openLinkEntry = () => {
    setLinkText('');
    setLinkError(undefined);
    removeLinkEntry = router.pushOverlay(SUB_URL_ID, () => {
      removeLinkEntry = undefined;
      setLinkText(undefined);
      setLinkError(undefined);
      focusBarOrRoot();
    });
    queueMicrotask(() => { if (alive) keyboardNode?.setFocus(); });
  };
  /** Done on the keyboard: load the link; on failure the keyboard stays open with the error. */
  const submitLink = async () => {
    const url = (linkText() ?? '').trim();
    if (!url || subBusy()) return;
    setLinkError(undefined);
    const error = await loadSubtitle({ url });
    if (!alive || linkText() === undefined) return;
    if (error) {
      setLinkError(error);
    } else {
      closeLinkEntry();
      focusBarOrRoot();
    }
  };

  /** The computer's file dialog (opened from the key press or click itself, which the browser requires). */
  const pickFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = SUBTITLE_FILE_TYPES;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (!file || !alive) return;
      void file.arrayBuffer().then(async (buf) => {
        const error = await loadSubtitle({ bytes: new Uint8Array(buf), name: file.name });
        if (error && alive) showToast(error);
      }, () => showToast("Couldn't read that file."));
    }, { once: true });
    input.addEventListener('cancel', () => input.remove(), { once: true });
    document.body.appendChild(input);
    input.click();
    focusBarOrRoot();
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

  /**
   * The control row, one focus row in three groups: pointer Back and the volume on the left (the shell's Back pill would
   * sit on the row, so it is off here), the transport icons centred, the track and episode buttons on the right. The
   * volume is pointer-only (the keyboard has + and -): it takes its place in the left group but is no focus stop.
   */
  const row = createMemo(() => {
    const left: Action[] = pointerMode() ? [{ id: 'back', label: SHELL_BACK_LABEL, width: BACK_W }] : [];
    const centre: Action[] = [
      { id: 'back30', label: 'Back 30 seconds', width: ROUND_W, round: true, icon: iconTexture('back30') },
      { id: 'back10', label: 'Back 10 seconds', width: ROUND_W, round: true, icon: iconTexture('back10') },
      { id: 'toggle', label: paused() ? 'Play' : 'Pause', width: ROUND_W, round: true, icon: iconTexture(paused() ? 'play' : 'pause') },
      { id: 'fwd10', label: 'Forward 10 seconds', width: ROUND_W, round: true, icon: iconTexture('fwd10') },
      { id: 'fwd30', label: 'Forward 30 seconds', width: ROUND_W, round: true, icon: iconTexture('fwd30') },
    ];
    const right: Action[] = [
      { id: 'tracks', label: 'Audio & subtitles', width: TRACKS_W },
      ...(p.next ? [{ id: 'next', label: 'Next episode', width: NEXT_W }] : []),
    ];
    const leftWs = [...left.map((a) => a.width), ...(volumeSupported ? [VOLUME_W] : [])];
    const xs = groupXs(CONTENT_W, 16, leftWs, centre.map((a) => a.width), right.map((a) => a.width));
    const volumeX = volumeSupported ? xs[left.length] : undefined;
    const rest = xs.slice(leftWs.length);
    const actions: Action[] = [
      ...left.map((a, i) => ({ ...a, x: xs[i] })),
      ...[...centre, ...right].map((a, i) => ({ ...a, x: rest[i] })),
    ];
    return { actions, volumeX };
  });
  const actions = () => row().actions;
  const onAction = (id: string) => {
    if (id === 'back') { onBack(); return; }
    bump();
    // Failed or ended: only the card's buttons act (Next episode still may).
    if ((failed() || ended()) && id !== 'next') return;
    if (id === 'toggle') togglePause();
    else if (id === 'back10') scrubPress(-1, SEEK_STEP_MS, 'skip');
    else if (id === 'fwd10') scrubPress(1, SEEK_STEP_MS, 'skip');
    else if (id === 'back30') scrubPress(-1, SKIP_LONG_MS, 'skip');
    else if (id === 'fwd30') scrubPress(1, SKIP_LONG_MS, 'skip');
    else if (id === 'tracks') openPicker();
    else if (id === 'next') nextNow();
  };
  /** Shows the overlay and puts the focus on its timeline (the overlay's first row). */
  const focusTimeline = () => {
    bump();
    queueMicrotask(() => { if (alive && visible()) timelineNode?.setFocus(); });
    return true;
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

  /** Ok on the root (the overlay hidden, or shown by a pause): pause, and the timeline takes the focus. */
  const onEnter = () => {
    if (failed() || ended()) return true;
    if (!visible()) {
      bump();
      if (!playback.paused()) togglePause();
    } else {
      togglePause();
    }
    return focusTimeline();
  };
  /** Ok on the timeline: commit a pending scrub at once, else play/pause. */
  const onTimelineEnter = () => {
    if (failed() || ended()) return true;
    if (dragging()) return true;
    if (scrub()) {
      bump();
      commitSeek();
      return true;
    }
    return togglePause();
  };
  /** Left/Right on the root: the overlay shows with the timeline focused, and the press already scrubs. */
  const rootScrub = (key: 'Left' | 'Right') => {
    focusTimeline();
    return scrubKey(key);
  };
  const onBack = () => {
    if (router.topOverlay() !== undefined) return false; // the shell closes the picker first
    if (scrub() !== undefined || dragging()) {
      bump();
      dropSeek(); // Back cancels a pending scrub: nothing seeks
      return true;
    }
    stopCountdown();
    leave(!ended());
    return true;
  };

  // The whole screen: moving the pointer shows the overlay, so its buttons can be clicked; the wheel sets the volume.
  usePointerTarget({
    node: () => root,
    onHover: (pt) => { if (pt) bump(); },
    onClick: () => bump(),
    onWheel: (dy) => {
      if (dy !== 0) volumeStep(dy < 0 ? 1 : -1);
      return true;
    },
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

  // A loaded subtitle file showing: its cue is looked up from the playhead (no engine track carries it).
  createEffect(() => {
    const ext = external();
    if (!extOn() || !ext) return;
    const show = () => {
      const at = trustedPos();
      // A positive delay shows each cue later: look up the cue for that much earlier.
      setCue(at === undefined || !Number.isFinite(at) ? '' : cueText(cueAt(ext.cues, at - subDelay())));
    };
    show();
    const timer = setInterval(show, EXT_SUB_POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  // The overlay hid while its bar had the focus: give it back to the root (focus is never on a hidden node).
  createEffect(on(visible, (v) => {
    if (!v && (barFocused || timelineFocused) && !pickerOpen()) focusRoot();
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
      const d = knownDuration(trustedDur(), p.durationMs);
      setDur(d);
      setBufEnd(d === undefined ? undefined : bufferedEndMs(at ?? pos(), playback.bufferedAheadMs(), d));
      setPaused(playback.paused());
      // A new engine attempt plays (a quick reopen may never leave 'playing'): re-apply the remembered tracks.
      const playing = status()?.kind === 'playing';
      shapeTicks++;
      const shape = playing && shapeCheckDue(shapeTicks) ? trackShape(playback.audioTracks(), playback.textTracks()) : tracksAppliedShape;
      if (tracksDue(tracksAppliedAt, playback.startedAttempts(), playing, tracksAppliedShape, shape)) applyTracks();
      // Arm progress saves as soon as the start seek has landed.
      if (!saveArmed) arm();
      // A silent picture (a sound format this device cannot decode): say so once instead of playing on in silence.
      if (!soundWarned && playing && !playback.paused() && playback.soundUndecodable()) {
        soundWarned = true;
        showToast(noSoundText(playback.audioTracks().length));
      }
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
    const offSubs = playback.onSubtitle((text) => { if (alive && !extOn()) setCue(cueText(text)); });
    // The subtitles loaded earlier for this title: shown when chosen (the tracks may already have been applied).
    api.onlineSubtitlesAvailable().then((ok) => { if (alive) setOnlineOk(ok); }, () => { /* not offered */ });
    api.getSubtitle(p.itemId).then((loaded) => {
      if (!alive || !loaded) return;
      setExternal(loaded);
      setSubDelay(loaded.delayMs ?? 0);
      if (chosen.subtitle === SUBTITLE_KEY_EXT) applySubtitle();
    }, (err) => console.warn('Subtitle read failed', errName(err)));
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
    // A delay changed just before leaving: save it now.
    if (delaySaveTimer !== undefined) {
      clearTimeout(delaySaveTimer);
      api.setSubtitleDelay(p.itemId, subDelay()).catch((err) => console.warn('Subtitle delay save failed', errName(err)));
    }
    removePicker?.();
    router.removeOverlay(TRACKS_ID);
    removeLinkEntry?.();
    router.removeOverlay(SUB_URL_ID);
    removeOnline?.();
    router.removeOverlay(SUB_ONLINE_ID);
    stopOurs();
  });

  // ---- drawing ----

  const title = oneSpace(p.title);
  const label = p.episodeLabel ? oneSpace(p.episodeLabel) : '';
  const statusText = () => {
    const s = status();
    // No status: the open is held (refusal cooldown or open-rate cap) and will start by itself.
    return s === undefined || s.kind === 'loading' ? 'Loading…' : s.kind === 'reconnecting' ? 'Reconnecting…' : '';
  };
  /**
   * The card's text (the failure: its cause and status, spec 2026-10-16-source-retry §2.8; else the next-episode
   * countdown) and the box it fits: heading size, or body size for a long refusal that names the account's limit.
   */
  const card = createMemo(() => {
    const f = failed();
    const text = f
      ? failureText({ reason: f.reason, httpStatus: f.httpStatus, maxConnections: activeMaxConnections() }, 'video')
      : nextCardText(oneSpace(p.next?.label ?? ''), countdown() ?? 0);
    const small = !fitsBox(text, MESSAGE_BOXES.vodCard);
    return { text, box: small ? MESSAGE_BOXES.vodCardSmall : MESSAGE_BOXES.vodCard, font: small ? FONT.body : FONT.heading };
  });
  const subLines = () => cue().split('\n').length;
  const subY = () => (visible() ? TITLE_Y - LAYOUT.gap : LAYOUT.height - LAYOUT.safeY - 20) - subLines() * SUB_LINE_H;
  // Toasts end above a subtitle, else above the overlay's title.
  useToastFloor(() => (cue() ? subY() - LAYOUT.gap : visible() ? TITLE_Y - LAYOUT.gap : undefined));
  const PILL_W = 420;

  return (
    <View ref={(el) => { root = el; }} width={LAYOUT.width} height={LAYOUT.height}
      onBack={onBack} onEnter={onEnter}
      onLeft={() => rootScrub('Left')} onRight={() => rootScrub('Right')}
      onUp={focusTimeline} onDown={focusTimeline}
      onPlayPause={() => (failed() || ended() ? true : togglePause())}
      onChannelUp={nextNow} onChannelDown={prevNow}>

      {/* Subtitles: above the video, below the overlay; lifted above the band while it shows. */}
      {/* A dark outline (offset copies) keeps the text readable on bright pictures without a font shadow. */}
      <Show when={cue()}>
        <View zIndex={5}>
          <For each={SUB_OUTLINE}>{([dx, dy]) => (
            <Text x={CONTENT_X + dx} y={subY() + dy} width={CONTENT_W} maxWidth={CONTENT_W} contain="width" textAlign="center"
              maxLines={3} fontSize={SUB_FONT} lineHeight={SUB_LINE_H} color={SUB_OUTLINE_COLOR}>{cue()}</Text>
          )}</For>
          <Text x={CONTENT_X} y={subY()} width={CONTENT_W} maxWidth={CONTENT_W} contain="width" textAlign="center"
            maxLines={3} fontSize={SUB_FONT} lineHeight={SUB_LINE_H} color={COLORS.text}>{cue()}</Text>
        </View>
      </Show>

      <Show when={visible()}>
        <View zIndex={10} width={LAYOUT.width} height={LAYOUT.height}>
          <View y={BAND_Y} width={LAYOUT.width} height={BAND_H} src={scrimTexture('player', BACKGROUND_RGB)} />
          <Text x={CONTENT_X} y={TITLE_Y} width={CONTENT_W} maxWidth={CONTENT_W} contain="width" maxLines={1}
            fontSize={FONT.title} color={COLORS.text}>{title}</Text>
          <Show when={label}>
            <Text x={CONTENT_X} y={LABEL_Y} width={CONTENT_W} maxWidth={CONTENT_W} contain="width"
              maxLines={1} fontSize={FONT.body} color={COLORS.muted}>{label}</Text>
          </Show>
          <Timeline ref={(el) => { timelineNode = el; }} x={CONTENT_X} y={TIMELINE_Y} width={CONTENT_W}
            posMs={pos()} durMs={dur()} bufferedEndMs={bufEnd()} scrub={scrub()}
            onLeft={() => scrubKey('Left')} onRight={() => scrubKey('Right')} onEnter={onTimelineEnter}
            onDown={focusBar} onFocusChanged={(f) => { timelineFocused = f; }}
            onPointerSeek={pointerSeek} onDrag={onDrag} onHover={bump} />
          <Text x={CONTENT_X} y={TIMES_Y} width={TIME_W} maxWidth={TIME_W} contain="width" maxLines={1}
            fontSize={FONT.body} color={COLORS.text}>{elapsedText(pos(), dur())}</Text>
          <Show when={dur() !== undefined}>
            <Text x={CONTENT_X + CONTENT_W - TIME_W} y={TIMES_Y} width={TIME_W} maxWidth={TIME_W} contain="width" textAlign="right"
              maxLines={1} fontSize={FONT.body} color={COLORS.muted}>{remainingText(pos(), dur() ?? 0, now())}</Text>
          </Show>
          <ActionBar ref={(el) => { barNode = el; }} x={CONTENT_X} y={ACTIONS_Y} actions={actions()} onAction={onAction}
            initial="toggle" onUp={focusTimeline} onDown={() => true}
            onFocusChanged={(f) => { barFocused = f; }} />
          {/* After the bar: its hit area spans the row, and the later target wins where they overlap. */}
          <Show when={row().volumeX !== undefined}>
            <VolumeControl x={CONTENT_X + (row().volumeX ?? 0)} y={ACTIONS_Y} width={VOLUME_W} height={BUTTON_H} fill={COLORS.surface}
              onActive={bump} />
          </Show>
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
          {/* The text area above the buttons: y 24 to 148. */}
          <Text x={40} y={24 + messageTop(card().text, card().box, CARD_TEXT_H)} width={CARD_W - 80} maxWidth={CARD_W - 80}
            contain="width" textAlign="center" maxLines={card().box.maxLines} lineHeight={card().box.lineH}
            fontSize={card().font} color={COLORS.text}>{card().text}</Text>
          <Show when={failed()?.reason !== 'unsupported'}>
            <ActionBar ref={(el) => { cardNode = el; }}
              x={(CARD_W - cardActions().reduce((w, a) => w + a.width + 16, -16)) / 2} y={CARD_H - 72 - 40}
              actions={cardActions()} onAction={onCardAction} />
          </Show>
        </View>
      </Show>

      {/* Desktop volume: + and - keys and the wheel; with the controls hidden a change shows a short top-right pill. */}
      <VolumeOsd inBar={visible()} />

      <Show when={pickerOpen()}>
        <ListPicker ref={(el) => { pickerNode = el; }} title="Audio & subtitles" rows={rows()} onPick={pickTrack} onAdjust={adjustRow}
          hint="Ok chooses · Back closes" />
      </Show>

      <Show when={onlineRows()}>{(list) => (
        <ListPicker ref={(el) => { onlineNode = el; }} title="Subtitles online" rows={list()} onPick={pickOnline}
          hint={subBusy() ? 'Loading subtitles…' : ONLINE_ATTRIBUTION} />
      )}</Show>

      <Show when={linkText() !== undefined}>
        <View zIndex={40} width={LAYOUT.width} height={LAYOUT.height} color={0x000000b3}>
          <Keyboard ref={(el) => { keyboardNode = el; }} x={(LAYOUT.width - KEYBOARD_W) / 2} y={(LAYOUT.height - KEYBOARD_H) / 2}
            label="Subtitle link (.srt or .vtt)" value={linkText() ?? ''}
            onChange={(v) => { setLinkText(v); setLinkError(undefined); }} onDone={() => void submitLink()}
            hint={subBusy() ? 'Loading subtitles…' : 'Done loads the link · Back cancels'} error={linkError()} />
        </View>
      </Show>
    </View>
  );
}
