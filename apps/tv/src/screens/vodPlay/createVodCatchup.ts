/**
 * The VOD player in catch-up mode (spec 2026-10-20-catch-up §5.4–5.5): seeks that re-open the archive, the end card
 * (next programme, Watch live, Back), "Not available", and the live channel played again on the way out. Not
 * unit-tested: the pure rules live in catchupLogic.ts.
 */
import { createSignal } from 'solid-js';
import { api } from '../../api.ts';
import { failureText } from '../../playback/failureText.ts';
import { journal, playback } from '../../playback/playback.ts';
import { CATCHUP_COPY } from '../../copy.ts';
import { router } from '../../shell/router.ts';
import { showToast } from '../../shell/Toast.tsx';
import { REOPEN_MIN_GAP_MS, catchupVodPlayable, missingArchive, reopenAllowed, reopenStartMs } from '../../vod/catchupLogic.ts';
import type { VodCore } from './createVodCore.ts';
import { errName } from './layout.ts';

const CANT_PLAY_NOW = failureText({ reason: 'unavailable' });

export function createVodCatchup(c: VodCore, d: {
  closePicker: () => void;
  dropSeek: () => void;
  /** The card's buttons take the focus (after this tick, once they are drawn). */
  focusCard: () => void;
}) {
  /** Catch-up: the programme ended (or its end was reached); the card offers the next one and live. */
  const [endCard, setEndCard] = createSignal(false);
  /** Catch-up: the source did not return this programme (§5.5). */
  const [notAvail, setNotAvail] = createSignal(false);
  let lastReopenAt: number | undefined;
  let reopenTimer: ReturnType<typeof setTimeout> | undefined;
  let reopenSeq = 0;

  /** Plays a live channel again (no screen change): the screen below sets its own video rect. */
  const resumeLive = (channelId: string) => {
    const token = playback.begin();
    api.getPlayable(channelId).then((pc) => {
      if (pc && playback.isLatest(token) && playback.current() === undefined) playback.playChannel(pc);
    }, (err) => console.warn('Live resume failed', errName(err)));
  };

  /** Catch-up: Watch live on the programme's channel (back to a Player below, else a new one in this place). */
  const watchLive = () => {
    const cur = c.cur();
    if (!cur || !c.alive) return;
    const token = playback.begin();
    api.getPlayable(cur.channelId).then((pc) => {
      if (!c.alive || !pc || !playback.isLatest(token)) return;
      c.alive = false;
      d.closePicker();
      playback.playChannel(pc);
      const params2 = { channelId: cur.channelId, groupId: 'all' };
      if (router.below()?.screen === 'player') router.back(params2);
      else router.replace('player', params2);
    }, (err) => {
      console.warn('Watch live failed', errName(err));
      showToast(CANT_PLAY_NOW);
    });
  };

  /** Catch-up: the next programme of the channel from the archive, in this player's place. */
  const playNextProgramme = () => {
    const cur = c.cur();
    if (!cur?.next || !c.alive) return;
    api.getCatchupPlayable(cur.channelId, cur.next.start).then((n) => {
      if (!c.alive) return;
      if (!('kind' in n)) {
        showToast(CATCHUP_COPY.notAvailable);
        return;
      }
      c.alive = false;
      d.closePicker();
      router.replace('vodPlay', { catchup: n });
    }, (err) => console.warn('Next programme failed', errName(err)));
  };

  /** Catch-up: a new archive URL that starts at `targetMs` into the programme (at most one per 2 s, close before open). */
  const reopenAt = (targetMs: number) => {
    const cur = c.cur();
    if (!cur || !c.alive) return;
    const now = Date.now();
    if (!reopenAllowed(lastReopenAt, now)) {
      if (reopenTimer !== undefined) clearTimeout(reopenTimer);
      reopenTimer = setTimeout(() => { reopenTimer = undefined; reopenAt(targetMs); }, REOPEN_MIN_GAP_MS - (now - (lastReopenAt ?? now)));
      return;
    }
    lastReopenAt = now;
    const seq = ++reopenSeq;
    c.setPos(targetMs);
    c.lastPos = targetMs;
    api.getCatchupPlayable(cur.channelId, cur.start, targetMs).then((n) => {
      if (!c.alive || seq !== reopenSeq) return;
      if (!('kind' in n)) {
        showToast(CATCHUP_COPY.notAvailable);
        return;
      }
      c.setCur(n);
      c.setOpenedAt(n.openedAtMs);
      c.setBufEnd(undefined);
      state.openedWall = Date.now();
      playback.playVod(catchupVodPlayable(n), reopenStartMs(targetMs, n.openedAtMs, n.url));
    }, (err) => console.warn('Catch-up seek failed', errName(err)));
  };

  /** Catch-up: the source did not return this programme. The Guide stops offering it for a while; the journal notes it. */
  const showNotAvailable = (httpStatus?: number) => {
    if (notAvail()) return;
    const cur = c.cur();
    if (cur) missingArchive.mark(cur.channelId, cur.start, Date.now());
    journal.add({ k: 'catchupMissing', t: Date.now(), ...(cur?.mode ? { mode: cur.mode } : {}), ...(httpStatus !== undefined ? { httpStatus } : {}) });
    c.stopOurs();
    setNotAvail(true);
    d.focusCard();
  };
  const showEndCard = () => {
    if (endCard() || notAvail()) return;
    if (!playback.paused()) playback.pause();
    setEndCard(true);
    d.dropSeek();
    d.closePicker();
    d.focusCard();
  };

  const state = {
    endCard, notAvail, resumeLive, watchLive, playNextProgramme, reopenAt, showNotAvailable, showEndCard,
    /** A frame was seen this open (a later failure is a normal one). */
    everPlayed: false,
    /** When the stream was asked for (an end or failure right after it, with no frame, is Not available). */
    openedWall: Date.now(),
    /** Unmount: a re-open waiting for its 2 s gap never runs. */
    dispose: () => { if (reopenTimer !== undefined) clearTimeout(reopenTimer); },
  };
  return state;
}
