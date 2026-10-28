/**
 * The VOD player's audio and subtitle choices: re-applied whenever an engine attempt plays (or late tracks change the
 * lists), remembered per title (per series for episodes), and the Subtitles picker (the stream's tracks, then the
 * loaded file's rows: source subtitles, online, a link or a file, delay and speed). Not unit-tested: the pure rules
 * live in vodPlayerLogic.ts, tracks.ts and subtitleLogic.ts.
 */
import { createSignal } from 'solid-js';
import type { ElementNode } from '@lightningtv/solid';
import type { VodTracks } from '@iptv/app-api';
import { api } from '../../api.ts';
import { pointerMode } from '../../input/pointer.ts';
import type { PickerRow } from '../homeMenuLogic.ts';
import { playback } from '../../playback/playback.ts';
import { router } from '../../shell/router.ts';
import { platformId, settings } from '../../state/appState.ts';
import { showToast } from '../../shell/Toast.tsx';
import { isTvPlatform } from '../../video/engineConfig.ts';
import { cueLanguageCollector } from '../../vod/cueLanguage.ts';
import { SUBTITLES_OFF, oneSpace, pickAudioTrack, trackKey, trackRows, type TrackLanguageInput } from '../../vod/tracks.ts';
import {
  SUBTITLE_KEY_OFF, shapeCheckDue, trackShape, tracksDue, tracksKeyId,
} from '../../vod/vodPlayerLogic.ts';
import {
  ANOTHER_VERSION_ROW, DELAY_EARLIER_ROW, DELAY_LATER_ROW, DELAY_POINTER_STEP_MS, DELAY_ROW, FIND_ONLINE_ROW, LOAD_FILE_ROW, LOAD_URL_ROW,
  REMOVE_EXT_ROW, SPEED_ROW, SUBTITLE_EXT_ROW, SUBTITLE_KEY_EXT, onlineLanguageLabel, pickSubtitle, sourceRowIndex, sourceSubtitleName,
  subtitleExtraRows,
} from '../../vod/subtitleLogic.ts';
import type { VodCore } from './createVodCore.ts';
import type { LoadedSubtitleState } from './createLoadedSubtitle.ts';
import type { SubtitleFinder } from './createSubtitleFinder.ts';
import { TRACKS_ID, errName } from './layout.ts';

/** A file picker exists on computers only (TV engines have no file dialog). */
const CAN_LOAD_FILE = !isTvPlatform(platformId);

export function createVodTracks(c: VodCore, sub: LoadedSubtitleState, finder: SubtitleFinder, d: {
  /** The choices to (re)apply whenever the stream starts playing; updated by the picker. */
  chosen: VodTracks;
  /** After the picker closes: the controls' bar when it still shows, else the screen. */
  focusBarOrRoot: () => void;
}) {
  const { p, cu } = c;
  const { chosen, focusBarOrRoot } = d;
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [rowsTick, setRowsTick] = createSignal(0);
  /** Embedded subtitle tracks' languages detected from their cues this open, by engine track id. */
  const [detectedLangs, setDetectedLangs] = createSignal<Record<string, string>>({});
  const cueLangs = cueLanguageCollector((id, lang) => setDetectedLangs((dl) => ({ ...dl, [id]: lang })));
  /** Everything the track labels and badges know about languages besides the tracks' own data. */
  const langInput = (): TrackLanguageInput => ({ ...(p.languageHints ? { hints: p.languageHints } : {}), detected: detectedLangs() });
  let pickerNode: ElementNode | undefined;
  let removePicker: (() => void) | undefined;
  let rowsTimer: ReturnType<typeof setTimeout> | undefined;
  /** The `startedAttempts` value the remembered tracks were last applied for (once per engine attempt). */
  let tracksAppliedAt: number | undefined;
  /** The track lists' shape when they were last applied (`trackShape`): late tracks re-apply the choices. */
  let tracksAppliedShape: string | undefined;
  /** Ticks since the tracks were last applied (`shapeCheckDue`). */
  let shapeTicks = 0;

  const applyTracks = () => {
    tracksAppliedAt = playback.startedAttempts();
    const audios = playback.audioTracks();
    const texts = playback.textTracks();
    tracksAppliedShape = trackShape(audios, texts);
    shapeTicks = 0;
    // The remembered choice, else the preferred language from Settings (applied, never remembered as the user's choice).
    const a = pickAudioTrack(audios, chosen.audio, settings()?.audioLanguage ?? 'auto');
    if (a && !a.active) playback.selectAudioTrack(a.id);
    applySubtitle(texts);
  };

  /** The remembered subtitle choice, else the preferred language from Settings (`pickSubtitle`). */
  const applySubtitle = (texts = playback.textTracks()) => {
    const pick = pickSubtitle({
      chosen: chosen.subtitle, texts, hasExternal: sub.external() !== undefined, preferred: settings()?.subtitleLanguage ?? 'off',
    });
    if (pick.kind === 'external' || pick.kind === 'off') {
      // The track automatic sync listens to stays on (unseen) while the loaded file shows.
      if (texts.some((t) => t.active && !(pick.kind === 'external' && t.id === sub.syncTrackId()))) playback.selectTextTrack(null);
    } else if (pick.kind === 'track') {
      const t = texts.find((x) => x.id === pick.id);
      if (t && !t.active) playback.selectTextTrack(t.id);
    }
    sub.showExternal(pick.kind === 'external');
  };

  /** Each tick: a new engine attempt plays (a quick reopen may never leave 'playing'): re-apply the remembered tracks. */
  const tick = (playing: boolean) => {
    shapeTicks++;
    const shape = playing && shapeCheckDue(shapeTicks) ? trackShape(playback.audioTracks(), playback.textTracks()) : tracksAppliedShape;
    if (tracksDue(tracksAppliedAt, playback.startedAttempts(), playing, tracksAppliedShape, shape)) applyTracks();
  };

  const rows = (): PickerRow[] => {
    rowsTick();
    const ext = sub.external();
    const on = sub.extOn();
    // Subtitles only: audio tracks are chosen in Options. A loaded file showing: "Subtitles off" is not checked
    // (the stream's tracks are all off).
    const base = trackRows([], playback.textTracks(), langInput())
      .map((r) => (r.kind === 'list' && on && (r.id === SUBTITLES_OFF || r.id.startsWith('s:')) ? { ...r, checked: false } : r));
    // Catch-up: the stream's own tracks only (a loaded file would be kept per title, and catch-up keeps nothing).
    if (cu) return base;
    return [...base, ...subtitleExtraRows({
      ...(p.subtitles ? { source: p.subtitles } : {}),
      external: ext && { name: oneSpace(ext.name), active: on, ...(sub.extLanguage() ? { language: sub.extLanguage() } : {}) }, canLoadFile: CAN_LOAD_FILE, canSearchOnline: finder.onlineOk(),
      delayMs: sub.subDelay(), speed: sub.subSpeed(), pointer: pointerMode(),
      ...(ext?.online && finder.onlineOk() ? { another: { label: onlineLanguageLabel(ext.online.language) } } : {}),
    })];
  };
  /** Engines may report the new active track a moment later: read the rows now and once more shortly after. */
  const refreshRows = () => {
    setRowsTick((v) => v + 1);
    if (rowsTimer !== undefined) clearTimeout(rowsTimer);
    rowsTimer = setTimeout(() => { if (c.alive) setRowsTick((v) => v + 1); }, 300);
  };

  const remember = (tracks: VodTracks) => {
    if (cu) return; // catch-up keeps nothing
    // Episodes remember their choices per series; movies per title.
    api.setVodTracks(tracksKeyId(p), tracks).catch((err) => console.warn('Track save failed', errName(err)));
  };

  const closePicker = () => {
    removePicker?.();
    removePicker = undefined;
    setPickerOpen(false);
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
    queueMicrotask(() => { if (c.alive) pickerNode?.setFocus(); });
  };

  const pickTrack = (row: PickerRow) => {
    if (row.kind !== 'list') return;
    if (row.id === DELAY_EARLIER_ROW || row.id === DELAY_LATER_ROW) {
      sub.changeDelay(row.id === DELAY_LATER_ROW ? 1 : -1, DELAY_POINTER_STEP_MS);
      return;
    }
    if (row.id === DELAY_ROW) return; // Left/Right change it
    if (row.id === SPEED_ROW) {
      sub.changeSpeed(1); // Left/Right too; Ok (or a click) steps on, wrapping
      return;
    }
    if (row.id === ANOTHER_VERSION_ROW) {
      closePicker();
      finder.openVersions();
      return;
    }
    if (row.id === FIND_ONLINE_ROW) {
      closePicker();
      finder.openOnline();
      return;
    }
    if (row.id === LOAD_URL_ROW) {
      closePicker();
      finder.openLinkEntry();
      return;
    }
    if (row.id === LOAD_FILE_ROW) {
      closePicker();
      finder.pickFile();
      return;
    }
    if (row.id === REMOVE_EXT_ROW) {
      sub.removeExternal();
      refreshRows();
      return;
    }
    const srcIndex = sourceRowIndex(row.id);
    if (srcIndex !== undefined) {
      const s = p.subtitles?.[srcIndex];
      const ext = sub.external();
      // Already loaded: just turn it on; else download it (a failure is a toast, the picker stays).
      if (s && ext && ext.name === sourceSubtitleName(s)) sub.useExternal();
      else if (s) {
        void sub.loadWith(() => api.loadSourceSubtitle(p.itemId, s)).then((error) => {
          if (!c.alive) return;
          if (error) showToast(error);
          refreshRows();
        });
        return;
      }
    } else if (row.id === SUBTITLE_EXT_ROW) {
      sub.useExternal();
    } else if (row.id === SUBTITLES_OFF) {
      playback.selectTextTrack(null);
      sub.showExternal(false);
      chosen.subtitle = SUBTITLE_KEY_OFF;
      remember({ subtitle: SUBTITLE_KEY_OFF });
      sub.setCue('');
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
      sub.showExternal(false);
      chosen.subtitle = trackKey(t);
      remember({ subtitle: chosen.subtitle });
    }
    refreshRows();
  };

  return {
    pickerOpen, rowsTick, cueLangs, langInput, applyTracks, applySubtitle, tick, rows, refreshRows, remember,
    openPicker, closePicker, pickTrack,
    /** Ticks since the tracks were last applied (other once-a-second checks run every 4th tick). */
    shapeTicks: () => shapeTicks,
    pickerRef: (el: ElementNode) => { pickerNode = el; },
    /** Unmount: the rows' re-read timer stops; the picker's back layer goes (without its close handler). */
    disposeTimer: () => { if (rowsTimer !== undefined) clearTimeout(rowsTimer); },
    disposePicker: () => {
      removePicker?.();
      router.removeOverlay(TRACKS_ID);
    },
  };
}
