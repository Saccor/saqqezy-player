/**
 * Live TV's preview requests (ported from Home: playById / playHere / resumeLast / stopPreview / openFullscreen /
 * retryHere). Only OK (or the startup resume) plays; moving the focus never does. Not unit-tested: it drives the
 * shared `playback` and the worker.
 */
import { createSignal } from 'solid-js';
import { api } from '../../api.ts';
import { retrySource } from '../../playback/cooldown.ts';
import { devResume } from '../../playback/devResume.ts';
import { playback } from '../../playback/playback.ts';
import { rowIdOf } from '../../playback/sourceLogic.ts';
import { router } from '../../shell/router.ts';

/**
 * The playable for row (or stream) `id`: the stream on screen exactly when `id` is its row, so a return from the Player or
 * OK on the playing row never swaps a combined channel's stream; else (and after a failure) the row's best stream.
 */
function playableFor(id: string) {
  const cur = playback.current();
  const keep = cur && (cur.id === id || rowIdOf(cur) === id) && playback.status()?.kind !== 'failed';
  return keep ? api.getPlayable(cur.id, { exact: true }) : api.getPlayable(id);
}

export function createLivePreview(alive: () => boolean) {
  // The channel an OK (or the startup resume) is fetching right now: its getPlayable has not answered yet.
  const [requested, setRequested] = createSignal<string | undefined>(undefined);
  // Dev builds only: the last channel was not resumed after a page load (devResume.ts); the preview box says so.
  const [pausedNote, setPausedNote] = createSignal(devResume.paused());

  /** The user started a channel: in dev builds, auto-resume after a reload works again for this page. */
  const userPlayed = () => {
    devResume.release();
    setPausedNote(false);
  };

  /** Plays `id` in the preview unless a newer request (OK elsewhere, fullscreen, stop) has superseded this one. */
  const playById = async (id: string) => {
    userPlayed();
    const token = playback.begin();
    setRequested(id);
    try {
      const ch = await playableFor(id);
      if (alive() && ch && playback.isLatest(token)) playback.playChannel(ch);
    } catch (err) {
      console.warn('Preview failed', err instanceof Error ? err.name : 'Error');
    } finally {
      if (requested() === id) setRequested(undefined);
    }
  };

  /** OK on a channel that is not playing: it plays in the mini window, and counts as watched in group `g`. */
  const playHere = (id: string, g: string) => {
    void playById(id).then(() => {
      if (alive() && playback.currentRowId() === id) void api.markWatched(id, g).catch(() => undefined);
    });
  };

  /**
   * Startup: resumes the last channel in the preview. In dev builds a remote source is not resumed after a page load
   * (devResume.ts): the preview box asks for OK instead.
   */
  const resumeLast = async (id: string) => {
    const token = playback.begin();
    setRequested(id);
    try {
      const ch = await api.getPlayable(id);
      if (!alive() || !ch || !playback.isLatest(token)) return;
      if (devResume.allows(ch.url)) playback.playChannel(ch);
      else setPausedNote(true);
    } catch (err) {
      console.warn('Preview failed', err instanceof Error ? err.name : 'Error');
    } finally {
      if (requested() === id) setRequested(undefined);
    }
  };

  /** Cancels any preview request in flight: opening the menu stops a pending preview (as Home did). */
  const stopPreview = () => {
    playback.begin();
    setRequested(undefined);
  };

  /** Fullscreen on channel `id`: the playing channel keeps its stream (only the rect changes), then the Player opens. */
  const openFullscreen = (id: string, g: string, beforePush?: () => void) => {
    userPlayed();
    const token = playback.begin();
    setRequested(undefined);
    void (async () => {
      try {
        const ch = await playableFor(id);
        if (!alive() || !ch || !playback.isLatest(token)) return;
        // Same channel: the stream keeps running and only the rect changes (no reconnect).
        playback.playChannel(ch);
        playback.setRect('fullscreen');
        await api.markWatched(id, g).catch(() => undefined);
        if (alive() && playback.isLatest(token)) {
          beforePush?.();
          router.push('player', { channelId: id, groupId: g });
        }
      } catch (err) {
        console.warn('Open channel failed', err instanceof Error ? err.name : 'Error');
      }
    })();
  };

  /**
   * Manual Retry while the source cools down: one probe, then `id` (or the held channel) previews here. The user
   * stays on Live TV, where the result shows.
   */
  const retryHere = async (id?: string) => {
    userPlayed();
    const token = playback.begin();
    setRequested(undefined);
    const ch = id === undefined ? undefined : await api.getPlayable(id).catch(() => undefined);
    if (!alive() || !playback.isLatest(token)) return;
    await retrySource(ch);
  };

  /**
   * Choose source: `sourceId` plays first for row `rowId` from now on, and plays in the preview now (a new tune). Counts
   * as watched in group `g`.
   */
  const playSource = async (rowId: string, sourceId: string, g: string | undefined) => {
    userPlayed();
    const token = playback.begin();
    setRequested(rowId);
    try {
      await api.pickLiveSource(rowId, sourceId).catch(() => undefined);
      const ch = await api.getPlayable(sourceId, { exact: true });
      if (!alive() || !ch || !playback.isLatest(token)) return;
      playback.playChannel(ch);
      if (g !== undefined) void api.markWatched(rowId, g).catch(() => undefined);
    } catch (err) {
      console.warn('Choose source failed', err instanceof Error ? err.name : 'Error');
    } finally {
      if (requested() === rowId) setRequested(undefined);
    }
  };

  return { requested, pausedNote, playById, playHere, resumeLast, stopPreview, openFullscreen, retryHere, playSource };
}

export type LivePreview = ReturnType<typeof createLivePreview>;
