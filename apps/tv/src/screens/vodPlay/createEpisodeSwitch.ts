/**
 * A series' episodes in the VOD player: Channel up / down (and the overlay's Next episode button) switch to the next or
 * previous one, and an ended episode counts down to the next. Each switch replaces this screen. Not unit-tested: it
 * drives the router and the worker.
 */
import { createSignal } from 'solid-js';
import type { VodPlayable } from '@iptv/app-api';
import { api } from '../../api.ts';
import { failureText } from '../../playback/failureText.ts';
import { router } from '../../shell/router.ts';
import { showToast } from '../../shell/Toast.tsx';
import { NEXT_COUNTDOWN_S } from '../../vod/vodPlayerLogic.ts';
import type { VodCore } from './createVodCore.ts';
import { errName } from './layout.ts';

const CANT_PLAY_NOW = failureText({ reason: 'unavailable' });

export function createEpisodeSwitch(c: VodCore, d: {
  closePicker: () => void;
  /** Back: leave the player (`saveFirst` false: the position was already saved). */
  leave: (saveFirst?: boolean) => void;
  /** The card's buttons take the focus (after this tick, once they are drawn). */
  focusCard: () => void;
}) {
  const { p } = c;
  const [countdown, setCountdown] = createSignal<number | undefined>(undefined);
  let countdownTimer: ReturnType<typeof setInterval> | undefined;

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
    if (!target || !seriesId || c.switchBusy || !c.alive) return;
    c.switchBusy = true;
    stopCountdown();
    let np: VodPlayable | undefined;
    try {
      np = await api.getVodPlayable(target.id, seriesId);
    } catch (err) {
      console.warn('Episode switch failed', errName(err));
    }
    c.switchBusy = false;
    if (!c.alive) return;
    if (!np) {
      showToast(CANT_PLAY_NOW);
      if (c.ended()) d.leave(false);
      return;
    }
    d.closePicker();
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
    d.focusCard();
  };

  /** Save where we are, then switch (ignored while another switch is in flight). */
  const saveAndSwitch = (target: { id: string } | undefined) => {
    if (!target || !p.series || c.switchBusy) return true;
    // The end card already saved the end position; the engine's playhead may now read short of it.
    if (!c.ended()) c.save();
    void switchTo(target);
    return true;
  };

  return {
    countdown, stopCountdown, startCountdown, playNext,
    /** Channel up and the overlay's Next episode button: the next episode. */
    nextNow: () => saveAndSwitch(p.next),
    /** Channel down: the previous episode. */
    prevNow: () => saveAndSwitch(p.prev),
    /** Unmount: the countdown stops. */
    dispose: () => { if (countdownTimer !== undefined) clearInterval(countdownTimer); },
  };
}
