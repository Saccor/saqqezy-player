/**
 * A subtitle file the user loaded for this title (a link, a file, the source's own or one found online): whether it
 * shows instead of the stream's, its delay and speed (kept with the file), the speed matched to the video's frame rate
 * once, and automatic sync against the stream's own subtitles (spec 2026-10-21 §4). Not unit-tested: the pure rules
 * live in subtitleLogic.ts and syncRecorder.ts.
 */
import { createMemo, createSignal } from 'solid-js';
import type { VodTracks } from '@iptv/app-api';
import type { LoadedSubtitle, SubtitleInput } from '@iptv/core';
import { api } from '../../api.ts';
import { VOD_COPY } from '../../copy.ts';
import type { PickerRow } from '../homeMenuLogic.ts';
import { playback, player } from '../../playback/playback.ts';
import { showToast } from '../../shell/Toast.tsx';
import { SyncRecorder, syncReferenceTrack } from '../../vod/syncRecorder.ts';
import { oneSpace } from '../../playback/tracks.ts';
import {
  DELAY_ROW, SPEED_ROW, SUBTITLE_KEY_EXT, autoSpeed, delayLabel, loadedLanguage, normalizeSpeed, stepDelay, stepSpeed,
  type SubtitleSpeed,
} from '../../vod/subtitleLogic.ts';
import type { VodCore } from './createVodCore.ts';
import { errName } from './layout.ts';

/** Automatic sync asks the worker once this much video is recorded, then at most this often. */
const SYNC_ASK_AFTER_MS = 4 * 60_000;
const SYNC_ASK_EVERY_MS = 30_000;

export function createLoadedSubtitle(c: VodCore, d: {
  /** The choices to (re)apply whenever the stream starts playing. */
  chosen: VodTracks;
  /** Remembers a track choice for the title (or series). */
  remember: (tracks: VodTracks) => void;
  /** Re-applies the subtitle choice (`createVodTracks`). */
  applySubtitle: () => void;
  /** The subtitle picker's rows are read again. */
  refreshRows: () => void;
}) {
  const { p, cu } = c;
  const { chosen } = d;
  /** The cue on screen: the stream's (engines that cannot draw their own) or the loaded file's. */
  const [cue, setCue] = createSignal('');
  /** Subtitles the user loaded for this title (a link or a file), and whether they show instead of the stream's. */
  const [external, setExternal] = createSignal<LoadedSubtitle | undefined>(undefined);
  const [extOn, setExtOn] = createSignal(false);
  /** The loaded file's language (stored, or from its name or text). */
  const extLanguage = createMemo(() => {
    const ext = external();
    return ext ? loadedLanguage(ext) : undefined;
  });
  const [subBusy, setSubBusy] = createSignal(false);
  /** The loaded file's delay: how much later (positive) or earlier its cues show. Kept with the file. */
  const [subDelay, setSubDelay] = createSignal(0);
  /** The loaded file's speed (a frame-rate fix): how fast its time runs against the video's. Kept with the file. */
  const [subSpeed, setSubSpeed] = createSignal<SubtitleSpeed>(1);
  /** Ticks left to wait for the video's frame rate before the loaded file's automatic speed is given up. */
  let autoSpeedTries = 0;
  /** Ticks left asking for the video's frame rate early (about 10 s of playing). */
  let fpsPrimeTicks = 40;
  let delaySaveTimer: ReturnType<typeof setTimeout> | undefined;
  // Automatic subtitle sync (spec 2026-10-21 §4): listening to the stream's own track (unseen) while a loaded file shows.
  let sync: { recorder: SyncRecorder; trackId: string; key: string; nextAskAt: number; asking: boolean } | undefined;
  /** The file sync is done with (synced, given up, or the user set its delay or speed): never listened to again. */
  let syncFinishedFor: string | undefined;

  /** Shows (or stops showing) the loaded subtitle file; the cue on screen is cleared either way. */
  const showExternal = (on: boolean) => {
    if (!on) stopSync(false);
    if (on === extOn()) return;
    setExtOn(on);
    setCue('');
  };

  /** The loaded file on, the stream's subtitles off; remembered like any other subtitle choice. */
  const useExternal = () => {
    if (!external()) return;
    if (playback.textTracks().some((t) => t.active)) playback.selectTextTrack(null);
    showExternal(true);
    chosen.subtitle = SUBTITLE_KEY_EXT;
    d.remember({ subtitle: SUBTITLE_KEY_EXT });
  };

  /** Left/Right on the delay row (or a pointer row): move the loaded file's cues; saved shortly after the last press. */
  const changeDelay = (dir: 1 | -1, step?: number) => {
    finishSync(); // the user sets it: automatic sync stops for this file
    const next = stepDelay(subDelay(), dir, step);
    setSubDelay(next);
    d.refreshRows();
    if (delaySaveTimer !== undefined) clearTimeout(delaySaveTimer);
    delaySaveTimer = setTimeout(() => {
      delaySaveTimer = undefined;
      api.setSubtitleDelay(p.itemId, next).catch((err) => console.warn('Subtitle delay save failed', errName(err)));
    }, 400);
  };
  const adjustRow = (row: PickerRow, dir: 1 | -1) => {
    if (row.kind !== 'list') return false;
    if (row.id === DELAY_ROW) changeDelay(dir);
    else if (row.id === SPEED_ROW) changeSpeed(dir);
    else return false;
    return true;
  };

  /** The loaded file's speed set (by the user, or once automatically): kept with the file, never overridden later. */
  const setSpeedFor = (ext: LoadedSubtitle, speed: SubtitleSpeed) => {
    setSubSpeed(speed);
    setExternal({ ...ext, speed });
    api.setSubtitleSpeed(p.itemId, speed).catch((err) => console.warn('Subtitle speed save failed', errName(err)));
  };
  /** Left/Right on the speed row: Normal, 25 → 23.976, 23.976 → 25 (wrapping). */
  const changeSpeed = (dir: 1 | -1) => {
    const ext = external();
    if (!ext) return;
    finishSync();
    setSpeedFor(ext, stepSpeed(subSpeed(), dir));
    d.refreshRows();
  };

  /** The playing video's frame rate, when the engine reports it. */
  const videoFps = (): number | undefined => {
    try {
      const fps = player.streamInfo().fps;
      return fps !== undefined && Number.isFinite(fps) && fps > 0 ? fps : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * A loaded file with no speed set: when its frame rate and the video's are both known and differ, the matching
   * speed is set (and said). Waits a few ticks for the engine to report the video's rate; a set speed is kept.
   */
  const applyAutoSpeed = (quiet = false): boolean => {
    const ext = external();
    if (!ext || ext.speed !== undefined || ext.fps === undefined || autoSpeedTries <= 0) return false;
    const fps = videoFps();
    if (fps === undefined) {
      autoSpeedTries--;
      return false;
    }
    autoSpeedTries = 0;
    const speed = autoSpeed(ext.fps, fps);
    if (speed === 1) return false;
    setSpeedFor(ext, speed);
    d.refreshRows();
    if (!quiet) showToast(VOD_COPY.speedAdjusted);
    return true;
  };

  // ---- automatic sync against the stream's own subtitles (spec 2026-10-21 §4) ----

  const syncKey = (ext: LoadedSubtitle) => `${ext.name}|${ext.cues.length}`;

  /** Starts listening when a loaded file shows and the stream has a track to compare with (not catch-up). */
  const startSync = () => {
    const ext = external();
    if (sync || cu || !ext || !extOn() || syncFinishedFor === syncKey(ext)) return;
    const ref = syncReferenceTrack(playback.textTracks(), ext.language ?? ext.online?.language);
    if (!ref) return;
    if (!ref.active) playback.selectTextTrack(ref.id);
    sync = { recorder: new SyncRecorder(), trackId: ref.id, key: syncKey(ext), nextAskAt: 0, asking: false };
  };
  /** Stops listening. `release`: the stream's track goes off again (only while the loaded file is still the choice). */
  const stopSync = (release: boolean) => {
    const s = sync;
    sync = undefined;
    if (release && s && chosen.subtitle === SUBTITLE_KEY_EXT && playback.textTracks().some((t) => t.id === s.trackId && t.active)) {
      playback.selectTextTrack(null);
    }
  };
  const finishSync = () => {
    const ext = external();
    if (ext) syncFinishedFor = syncKey(ext);
    stopSync(true);
  };
  /**
   * Each tick: record, and every 30 s (once 4 min are recorded) ask the worker for a better delay and speed.
   * `shapeTicks`: the tick count the track check keeps (a new listen is tried every 4th tick).
   */
  const syncTick = (at: number | undefined, playing: boolean, shapeTicks: number) => {
    if (!sync) {
      if (playing && shapeTicks % 4 === 0) startSync();
      return;
    }
    const ext = external();
    // Another file, the file off, or the stream's track turned off elsewhere: listen again from the start later.
    if (!ext || !extOn() || syncKey(ext) !== sync.key || !playback.textTracks().some((t) => t.id === sync!.trackId && t.active)) {
      stopSync(false);
      return;
    }
    if (at === undefined || !Number.isFinite(at)) return;
    sync.recorder.tick(at, playing && !playback.paused());
    if (sync.recorder.exhausted()) {
      finishSync();
      return;
    }
    const t = Date.now();
    if (sync.asking || t < sync.nextAskAt || sync.recorder.playedMs() < SYNC_ASK_AFTER_MS) return;
    const s = sync;
    s.asking = true;
    s.nextAskAt = t + SYNC_ASK_EVERY_MS;
    api.syncSubtitle(p.itemId, s.recorder.sample(), { delayMs: subDelay(), speed: subSpeed() }).then((res) => {
      s.asking = false;
      if (!c.alive || sync !== s || !res) return;
      const cur = external();
      if (!cur) return;
      setSubDelay(res.delayMs);
      api.setSubtitleDelay(p.itemId, res.delayMs).catch((err) => console.warn('Subtitle delay save failed', errName(err)));
      if (normalizeSpeed(res.speed) !== subSpeed()) setSpeedFor(cur, normalizeSpeed(res.speed));
      finishSync();
      d.refreshRows();
      showToast(VOD_COPY.synced(delayLabel(res.delayMs)));
    }, (err) => {
      s.asking = false;
      console.warn('Subtitle sync failed', errName(err));
    });
  };

  const removeExternal = () => {
    stopSync(true);
    api.clearSubtitle(p.itemId).catch((err) => console.warn('Subtitle remove failed', errName(err)));
    setSubSpeed(1);
    setExternal(undefined);
    showExternal(false);
    // It was the choice: the preferred language takes over (the choice stays for the series' other episodes).
    if (chosen.subtitle === SUBTITLE_KEY_EXT) d.applySubtitle();
  };

  /** The loaded file now showing: its delay and speed (Normal until set, or set to match the video's frame rate). */
  const useLoaded = (loaded: LoadedSubtitle) => {
    // A delay change still waiting to be saved belonged to the previous file.
    if (delaySaveTimer !== undefined) {
      clearTimeout(delaySaveTimer);
      delaySaveTimer = undefined;
    }
    setExternal(loaded);
    setSubDelay(loaded.delayMs ?? 0);
    setSubSpeed(normalizeSpeed(loaded.speed));
    // About 5 s for the engine to report the video's frame rate.
    autoSpeedTries = 20;
  };

  /** A newly loaded file starts with no delay. `toastName`: what the toast calls it (default: its name). */
  const loadWith = async (load: () => Promise<LoadedSubtitle>, toastName?: string): Promise<string | undefined> => {
    if (subBusy()) return undefined;
    setSubBusy(true);
    // The previous file must not get an automatic speed while the new one downloads.
    autoSpeedTries = 0;
    try {
      const loaded = await load();
      if (!c.alive) return undefined;
      useLoaded(loaded);
      useExternal();
      // One toast: the file, and the speed when it was matched to the video at once.
      const matched = applyAutoSpeed(true);
      showToast(VOD_COPY.subtitlesOn(oneSpace(toastName ?? loaded.name), matched));
      return undefined;
    } catch (err) {
      console.warn('Subtitle load failed', errName(err));
      return err instanceof Error && err.name === 'SubtitleError' ? err.message : VOD_COPY.subtitleLoadFailed;
    } finally {
      setSubBusy(false);
    }
  };

  /** Loads, keeps and turns on a subtitle file; returns the error to show (a message meant for the user). */
  const loadSubtitle = (input: SubtitleInput) => loadWith(() => api.loadSubtitle(p.itemId, input));

  return {
    cue, setCue, external, extOn, extLanguage, subBusy, subDelay, subSpeed,
    showExternal, useExternal, changeDelay, changeSpeed, adjustRow, videoFps, applyAutoSpeed, syncTick, finishSync, stopSync,
    removeExternal, useLoaded, loadWith, loadSubtitle,
    /** The stream's track automatic sync listens to (it stays on, unseen, while the loaded file shows). */
    syncTrackId: (): string | undefined => sync?.trackId,
    /** A stream cue arrived while sync listens: noted at programme time `at()`. Nothing happens while it does not listen. */
    syncCue: (hasText: boolean, at: () => number | undefined) => {
      if (!sync) return;
      const t = at();
      if (t !== undefined && Number.isFinite(t)) sync.recorder.cue(hasText, t);
    },
    /** Each tick while playing: a loaded file without a speed gets it once the engine reports the video's frame rate. */
    tickAutoSpeed: () => { if (autoSpeedTries > 0) applyAutoSpeed(); },
    /** Where the engine reports no frame rate it is measured once playing: ask early, so a search has it. */
    primeFps: () => { if (fpsPrimeTicks > 0 && !cu) fpsPrimeTicks = videoFps() === undefined ? fpsPrimeTicks - 1 : 0; },
    /** Unmount: a delay changed just before leaving is saved now. */
    flushDelay: () => {
      if (delaySaveTimer !== undefined) {
        clearTimeout(delaySaveTimer);
        api.setSubtitleDelay(p.itemId, subDelay()).catch((err) => console.warn('Subtitle delay save failed', errName(err)));
      }
    },
  };
}

export type LoadedSubtitleState = ReturnType<typeof createLoadedSubtitle>;
