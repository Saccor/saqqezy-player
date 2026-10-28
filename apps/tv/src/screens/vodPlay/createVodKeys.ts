/**
 * The VOD player's keys and buttons: Ok, Left/Right (a scrub), Back (a pending scrub first), the remote's media keys,
 * the control row's buttons and the centre card's. Not unit-tested: the pure rules live in seekLogic.ts.
 */
import { sendKey } from '../../input/keys.ts';
import { playback } from '../../playback/playback.ts';
import { router } from '../../shell/router.ts';
import { mediaKeyAction, SEEK_STEP_MS, SKIP_LONG_MS } from '../../vod/seekLogic.ts';
import type { VodCore } from './createVodCore.ts';
import type { createEpisodeSwitch } from './createEpisodeSwitch.ts';
import type { createVodCatchup } from './createVodCatchup.ts';
import type { createVodFocus } from './createVodFocus.ts';
import type { createVodOptions } from './createVodOptions.ts';
import type { createVodSeek } from './createVodSeek.ts';
import type { createVodTracks } from './createVodTracks.ts';

export function createVodKeys(c: VodCore, parts: {
  focus: ReturnType<typeof createVodFocus>;
  seek: ReturnType<typeof createVodSeek>;
  catchup: ReturnType<typeof createVodCatchup>;
  tracks: ReturnType<typeof createVodTracks>;
  options: ReturnType<typeof createVodOptions>;
  episodes: ReturnType<typeof createEpisodeSwitch>;
  /** Back: save (unless `saveFirst` is false), stop, leave. */
  leave: (saveFirst?: boolean) => void;
}) {
  const { p, cu, startMs, bump, visible, failed, ended } = c;
  const { focus, seek, catchup, tracks, options, episodes, leave } = parts;
  const { togglePause, scrubPress } = seek;

  const onAction = (id: string) => {
    if (id === 'back') { onBack(); return; }
    bump();
    // Failed or ended: only the card's buttons act (Next episode and Options, for another source, still may).
    if ((failed() || ended()) && id !== 'next' && id !== 'options') return;
    if (id === 'toggle') togglePause();
    else if (id === 'back10') scrubPress(-1, SEEK_STEP_MS, 'skip');
    else if (id === 'fwd10') scrubPress(1, SEEK_STEP_MS, 'skip');
    else if (id === 'back30') scrubPress(-1, SKIP_LONG_MS, 'skip');
    else if (id === 'fwd30') scrubPress(1, SKIP_LONG_MS, 'skip');
    else if (id === 'tracks') tracks.openPicker();
    else if (id === 'options') options.openOptions();
    else if (id === 'next') episodes.nextNow();
  };

  const retry = () => {
    bump();
    if (cu) {
      catchup.reopenAt(c.lastPos ?? c.openedAt());
      focus.focusRoot();
      return;
    }
    // Until saves are armed the playhead is not the title's real position (it never played, or dropped the start seek).
    playback.playVod(p, c.saveArmed ? (c.lastPos ?? startMs) : startMs);
    focus.focusRoot();
  };
  const onCardAction = (id: string) => {
    if (id === 'live') catchup.watchLive();
    else if (id === 'back') leave(false);
    else if (id === 'next') catchup.playNextProgramme();
    else if (id === 'retry') retry();
    else if (id === 'nextNow') void episodes.playNext();
    else if (id === 'cancel') { episodes.stopCountdown(); leave(false); }
  };

  /** Ok on the root (the overlay hidden, or shown by a pause): pause, and the timeline takes the focus. */
  const onEnter = () => {
    if (failed() || ended() || catchup.endCard() || catchup.notAvail()) return true;
    if (!visible()) {
      bump();
      if (!playback.paused()) togglePause();
    } else {
      togglePause();
    }
    return focus.focusTimeline();
  };
  /** Ok on the timeline: commit a pending scrub at once, else play/pause. */
  const onTimelineEnter = () => {
    if (failed() || ended()) return true;
    if (c.dragging()) return true;
    if (c.scrub()) {
      bump();
      seek.commitSeek();
      return true;
    }
    return togglePause();
  };
  /** Left/Right on the root: the overlay shows with the timeline focused, and the press already scrubs. */
  const rootScrub = (key: 'Left' | 'Right') => {
    focus.focusTimeline();
    return seek.scrubKey(key);
  };
  /** Play, Pause, Stop, Fast-forward and Rewind (remote media keys); Stop is Back. */
  const mediaKey = (key: 'Play' | 'Pause' | 'Stop' | 'FastForward' | 'Rewind') => {
    const act = mediaKeyAction(key, { paused: playback.paused(), blocked: failed() !== undefined || ended() });
    if (act === 'stop') { sendKey('Back'); return true; } // the same path as a Back press (layers close first)
    if (act === 'toggle') togglePause();
    else if (act === 'forward') scrubPress(1, SKIP_LONG_MS, 'skip');
    else if (act === 'back') scrubPress(-1, SKIP_LONG_MS, 'skip');
    return true;
  };
  const onBack = () => {
    if (router.topOverlay() !== undefined) return false; // the shell closes the picker first
    if (c.scrub() !== undefined || c.dragging()) {
      bump();
      seek.dropSeek(); // Back cancels a pending scrub: nothing seeks
      return true;
    }
    episodes.stopCountdown();
    leave(!ended());
    return true;
  };

  return { onAction, onCardAction, onEnter, onTimelineEnter, rootScrub, mediaKey, onBack };
}
