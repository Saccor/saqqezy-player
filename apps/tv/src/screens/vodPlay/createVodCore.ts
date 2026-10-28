/**
 * The VOD player's shared state: what plays (a title, or a catch-up programme as a stand-in title), the playhead and
 * duration the screen trusts, the overlay's visibility, and progress saves. Every other part of the screen
 * (`createVodSeek`, `createVodTracks`, …) reads and writes through this one object. Create it inside the screen
 * component (its signals then belong to the screen). Not unit-tested: it drives the shared `playback`.
 */
import { createSignal } from 'solid-js';
import type { CatchupPlayable, VodPlayable } from '@iptv/app-api';
import { api } from '../../api.ts';
import { isVodId, playback } from '../../playback/playback.ts';
import type { ScreenEntry } from '../../shell/router.ts';
import { catchupVodPlayable } from '../../playback/catchupLogic.ts';
import type { Scrub } from '../../vod/seekLogic.ts';
import { knownDuration, overlayVisible, progressSaveArmed } from '../../vod/vodPlayerLogic.ts';
import { errName } from './layout.ts';

export function createVodCore(entry: ScreenEntry) {
  const params = entry.params as { playable?: VodPlayable; fromStart?: boolean; catchup?: CatchupPlayable };
  /**
   * Catch-up mode (spec 2026-10-20-catch-up §5.4): a programme from the source's archive, played as a stand-in title.
   * Its timeline is the programme; nothing is saved (no progress, no remembered tracks, no loaded subtitles).
   */
  const cu = params.catchup;
  const p: VodPlayable = cu ? catchupVodPlayable(cu) : params.playable!;
  const startMs = cu ? 0 : params.fromStart ? 0 : p.resumeMs;
  const standId = `vod:${p.itemId}`;
  /** The live channel that played before a catch-up programme opened: Back plays it again. */
  const liveBefore = cu && !isVodId(playback.current()?.id) ? playback.current()?.id : undefined;

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
  /** Catch-up: the URL playing now (a seek may re-open another), and where in the programme it starts. */
  const [cur, setCur] = createSignal<CatchupPlayable | undefined>(cu);
  const [openedAt, setOpenedAt] = createSignal(cu?.openedAtMs ?? 0);

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
  /** Catch-up: programme time (where the URL starts plus the engine's playhead), and the programme's length. */
  const trustedPos = () => {
    if (!ours()) return undefined;
    const e = playback.positionMs();
    return e === undefined || !cu ? e : openedAt() + e;
  };
  const trustedDur = () => (ours() ? (cu ? p.durationMs : playback.durationMs()) : undefined);

  const c = {
    params, cu, p, startMs, standId, liveBefore,
    now, setNow, pos, setPos, dur, setDur, paused, setPaused, scrub, setScrub, dragging, setDragging, bufEnd, setBufEnd,
    cur, setCur, openedAt, setOpenedAt,
    /** False once the screen leaves or unmounts: late answers change nothing. */
    alive: true,
    /** The last trusted playhead (a retry or a source switch after a failure resumes there). */
    lastPos: startMs as number | undefined,
    /** One title switch (another episode or version) in flight at a time. */
    switchBusy: false,
    /**
     * Playhead saves wait until this attempt played near the start position (or the user seeked, or paused while it
     * played): see `progressSaveArmed`. A start at 0 is armed at once.
     */
    saveArmed: progressSaveArmed({ armed: false, startMs, playing: false, posMs: undefined }),
    /** Re-evaluates the arming from what the stream shows now (plus a user action). */
    arm: (user: { userSeeked?: boolean; userPaused?: boolean } = {}) => {
      c.saveArmed = progressSaveArmed({ armed: c.saveArmed, startMs, playing: status()?.kind === 'playing', posMs: trustedPos(), ...user });
    },
    status, failed, ended, visible, bump, ours, trustedPos, trustedDur,
    /** The trusted playhead, else the last one drawn. */
    playhead: () => trustedPos() ?? pos(),
    /**
     * Saves `atMs` (default: the trusted playhead, once saves are armed) when the duration is known. Never after
     * unmount.
     */
    save: (atMs?: number) => {
      if (!c.alive || cu) return; // catch-up never appears in Continue watching
      const d = knownDuration(trustedDur(), p.durationMs);
      if (atMs === undefined) {
        c.arm();
        if (!c.saveArmed) return;
      }
      const at = atMs ?? trustedPos();
      if (d === undefined || at === undefined || !Number.isFinite(at)) return;
      api.saveVodProgress(p.itemId, Math.max(0, Math.min(at, d)), d, p.series).catch((err) => console.warn('Progress save failed', errName(err)));
    },
    /**
     * Stops the stream only while it is still this title's: never one that has since replaced it (the next episode's
     * screen starts its own, and a held live channel may already be back).
     */
    stopOurs: () => {
      if (playback.current()?.id === standId) playback.stop();
    },
  };
  return c;
}

export type VodCore = ReturnType<typeof createVodCore>;
