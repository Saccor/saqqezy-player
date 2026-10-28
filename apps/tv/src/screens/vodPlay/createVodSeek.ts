/**
 * The VOD player's seeking: pause, the key scrub (Left/Right, held runs speed up), the ±10/±30 skips, and the timeline
 * click and drag. A pending seek commits after its source's idle delay (or Ok); Back drops it. Catch-up seeks in place
 * when the open stream covers the target, else re-opens the archive there. Not unit-tested: the pure rules live in
 * seekLogic.ts and catchupLogic.ts.
 */
import { playback } from '../../playback/playback.ts';
import { seekLimitMs, seekPlan } from '../../playback/catchupLogic.ts';
import { commitDelayMs, dragScrub, holdPress, pressScrub, seekStep, type HoldRun } from '../../vod/seekLogic.ts';
import type { VodCore } from './createVodCore.ts';

export function createVodSeek(c: VodCore, d: {
  /** Catch-up: the programme is not available (nothing seeks). */
  notAvail: () => boolean;
  /** Catch-up: a new archive URL from `targetMs` into the programme. */
  reopenAt: (targetMs: number) => void;
}) {
  const { cu, bump } = c;
  let commitTimer: ReturnType<typeof setTimeout> | undefined;
  let hold: HoldRun | undefined;

  const togglePause = () => {
    bump();
    if (playback.paused()) {
      playback.resume();
    } else {
      playback.pause();
      c.arm({ userPaused: true }); // paused while it played: this is where they are
      c.save();
    }
    c.setPaused(playback.paused());
    return true;
  };

  const clearCommit = () => {
    if (commitTimer !== undefined) clearTimeout(commitTimer);
    commitTimer = undefined;
  };
  /** Drops a pending seek without seeking (Back, a failure, the end). A held drag stops following the pointer. */
  const dropSeek = () => {
    clearCommit();
    c.setScrub(undefined);
    c.setDragging(false);
  };

  const commitSeek = () => {
    const s = c.scrub();
    dropSeek();
    if (!s || !c.alive) return;
    if (cu) {
      // In place when the open stream covers the target (HLS archive playlists), else a new URL from there.
      const plan = seekPlan(s.targetMs, c.openedAt(), playback.durationMs());
      if (plan.kind === 'inPlace') {
        playback.seek(plan.engineMs);
        c.setPos(s.targetMs);
        c.setBufEnd(undefined);
        c.lastPos = s.targetMs;
      } else {
        d.reopenAt(plan.offsetMs);
      }
      return;
    }
    c.arm({ userSeeked: true }); // the user chose this position
    playback.seek(s.targetMs);
    c.setPos(s.targetMs);
    c.setBufEnd(undefined); // the buffer reading is the old position's until the engine reports again
    c.lastPos = s.targetMs;
  };

  /** The duration a seek may use now; undefined while the title failed, ended or has no known length. */
  const seekableDur = () => {
    if (c.failed() || c.ended() || d.notAvail()) return undefined;
    // Catch-up: the programme, and for one on air only up to now.
    if (cu) return seekLimitMs(c.cur() ?? cu, Date.now()) || undefined;
    const dur = c.trustedDur();
    return dur !== undefined && Number.isFinite(dur) && dur > 0 ? dur : undefined;
  };

  /** One press of a scrub (Left/Right) or skip (±10): moves the target; it commits after its source's idle delay. */
  const scrubPress = (dir: 1 | -1, stepMs: number, source: 'keys' | 'skip') => {
    bump();
    const dur = seekableDur();
    if (dur === undefined || c.dragging()) return true;
    const s = pressScrub(c.scrub(), c.playhead(), dur, dir, stepMs, source);
    c.setScrub(s);
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
    const dur = seekableDur();
    if (dur === undefined) return;
    c.setScrub(dragScrub(c.scrub(), c.playhead(), dur, fraction));
    commitSeek();
  };
  /** A drag on the timeline moves the target live; the release commits it, Back (or a lost drag) drops it. */
  const onDrag = (fraction: number, phase: 'start' | 'move' | 'end' | 'cancel') => {
    bump();
    if (phase === 'cancel') {
      if (c.dragging()) dropSeek();
      return;
    }
    if (phase !== 'start' && !c.dragging()) return; // Back cancelled this drag: ignore it until the release
    const dur = seekableDur();
    if (dur === undefined) {
      dropSeek();
      return;
    }
    if (phase === 'start') {
      clearCommit();
      c.setDragging(true);
    }
    c.setScrub(dragScrub(c.scrub(), c.playhead(), dur, fraction));
    if (phase === 'end') commitSeek();
  };

  return {
    togglePause, dropSeek, commitSeek, scrubPress, scrubKey, pointerSeek, onDrag,
    /** A released Left/Right ends the hold run (the next press steps 10 s again). */
    endHold: () => { hold = undefined; },
  };
}
