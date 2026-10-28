/**
 * Multiview's window health: what each window's failure says (a device limit, a cooldown, a refusal by the source,
 * stopped so another could play, a plain failure), Retry and Retry now, and a source at its limit's "Watch this one
 * instead" (G9 decision C: it stops just enough other windows, waits for the source, then reopens). Create it inside
 * the screen component: its signals and effects belong to the screen. Not unit-tested: the pure rules live in
 * mvLogic.ts and tileFailure.ts.
 */
import { createEffect, createSignal } from 'solid-js';
import { api } from '../../api.ts';
import { MULTIVIEW_COPY } from '../../copy.ts';
import {
  clearWindowNote, connectionMemory, dropRefusalMark, keepRefusalOnWindow, pool, windowNotes,
} from '../../playback/playback.ts';
import { tileFailure } from '../../playback/tileFailure.ts';
import { activeMaxConnections } from '../../state/activeLimit.ts';
import { cooldownForStream, initState } from '../../state/appState.ts';
import {
  atSourceLimit, createWatchInstead, reopenStatus, retryAction, sourceLimit, windowsToStop, wasCut, type MvState, type MvWindow,
} from './mvLogic.ts';
import type { MultiviewSession } from './session.ts';

export function createMvHealth(d: {
  alive: () => boolean;
  state: () => MvState | undefined;
  update: (next: MvState) => void;
  session: MultiviewSession;
  /** The 1 s clock the failure texts count down with. */
  now: () => number;
}) {
  const { state, session } = d;
  /** When each slot's stream failed (for Retry's 3 s rest). */
  const failedAt = new Map<number, number>();
  /** "Watch this one instead": the window waiting for the source to free a connection (it shows "Freeing…"). */
  const [freeingSlot, setFreeingSlot] = createSignal<number | undefined>(undefined);
  const watch = createWatchInstead(setFreeingSlot, (slot) => pool.slots().find((p) => p.n === slot)?.playback.status());
  /** Windows stopped so another could play: they say so and offer Retry. */
  const [yielded, setYielded] = createSignal<ReadonlySet<number>>(new Set());
  const unyield = (slot: number) => {
    if (!yielded().has(slot)) return;
    setYielded((y) => {
      const next = new Set(y);
      next.delete(slot);
      return next;
    });
  };

  const windowAt = (i: number): MvWindow | undefined => state()?.windows[i];
  const slotOf = (i: number) => {
    const w = windowAt(i);
    return w ? pool.slots().find((s) => s.n === w.slot) : undefined;
  };

  const retry = (i: number) => {
    const w = windowAt(i);
    if (!w) return;
    clearWindowNote(w.slot);
    unyield(w.slot);
    failedAt.delete(w.slot);
    void session.changeChannel(w, w.channelId);
  };
  /** A window the cooldown holds: one probe of its source (as the single-view player's Retry now); the hold opens it. */
  const retryNow = (i: number) => {
    const slot = slotOf(i);
    const cur = slot?.playback.current();
    if (!slot || !cur) return;
    api.retrySource(cur.url).then(() => {
      if (d.alive() && cooldownForStream(slot.playback.current()).state === 'clear') slot.playback.resumeHeld();
    }, (err: unknown) => { console.warn('Retry failed', err instanceof Error ? err.name : 'Error'); });
  };

  // ---- a source at its limit (G9 decision C): "Watch this one instead" ----
  const statusOf = (slot: number) => pool.slots().find((p) => p.n === slot)?.playback.status()?.kind;
  /** The reported and learned limits of the active source (both inform; neither blocks). */
  const limits = (): { reported?: number; learnedRefusalAt?: number } => {
    const source = initState()?.activeSourceId;
    // A source reporting 0 connections reports nothing (it is not a limit of 1).
    const max = activeMaxConnections();
    const reported = max !== undefined && max > 0 ? max : undefined;
    const learned = source ? connectionMemory.refusedAt(source) : undefined;
    return { ...(reported !== undefined ? { reported } : {}), ...(learned !== undefined ? { learnedRefusalAt: learned } : {}) };
  };
  /** The source cut or refused window `i` (not the TV, not an escalation). */
  const cutAt = (i: number): boolean => {
    const w = windowAt(i);
    return w ? wasCut(windowNotes().get(w.slot), slotOf(i)?.playback.status()) : false;
  };
  /** The other windows playing now, newest first. */
  const othersPlaying = (i: number): MvWindow[] =>
    (state()?.windows ?? []).filter((w, k) => k !== i && statusOf(w.slot) === 'playing').reverse();
  const retryKind = (i: number) => {
    const others = othersPlaying(i).length;
    return retryAction({ cut: cutAt(i), otherPlaying: others > 0, atLimit: atSourceLimit({ ...limits(), othersPlaying: others }) });
  };
  /**
   * Stops just enough of the other windows, gives this one the sound, waits 5 s for the source, then opens it. Its
   * refusal stays on the window (no source cooldown); refused once, it tries once more 20 s later, then never again.
   */
  const watchInstead = (i: number) => {
    const s = state();
    const w = windowAt(i);
    if (!s || !w) return;
    const others = othersPlaying(i);
    const stop = others.slice(0, windowsToStop(others.length, sourceLimit(limits())));
    for (const o of stop) {
      session.close(o);
      clearWindowNote(o.slot);
    }
    setYielded((y) => new Set([...y, ...stop.map((o) => o.slot)]));
    clearWindowNote(w.slot);
    failedAt.delete(w.slot);
    if (!s.pinned) d.update({ ...s, sound: i });
    watch.start(w.slot, () => {
      const k = state()?.windows.findIndex((x) => x.slot === w.slot) ?? -1;
      if (!d.alive() || k < 0) return;
      keepRefusalOnWindow(w.slot);
      retry(k);
    });
  };
  // The reopens it made: refused once, "Freeing…" again and one more try; played or failed otherwise, the mark goes.
  createEffect(() => {
    for (const w of state()?.windows ?? []) {
      const st = pool.slots().find((p) => p.n === w.slot)?.playback.status();
      const r = watch.observe(w.slot, reopenStatus(st), st);
      if (r === 'played' || r === 'failed') dropRefusalMark(w.slot);
    }
  });
  /**
   * Window `slot` moves on (zap, another channel, closed) while a reopen may be starting: the reopen is no longer
   * watched and its mark goes, so a later refusal there is judged as usual (host cooldown, escalation).
   */
  const forgetReopen = (slot: number) => {
    watch.forget(slot);
    dropRefusalMark(slot);
  };

  return {
    watch, freeingSlot, unyield, windowAt, slotOf, retry, retryNow, retryKind, watchInstead, forgetReopen,
    /**
     * Starts noting when each slot fails (for Retry's rest). Call it where the screen's failure effect belongs: before
     * the effect that moves the sound off a failed window, which reads `failure`.
     */
    trackFailures: (slotsNow: () => ReturnType<typeof pool.slots>) => {
      createEffect(() => {
        for (const s of slotsNow()) {
          const kind = s.playback.status()?.kind;
          if (kind === 'failed' && !failedAt.has(s.n)) failedAt.set(s.n, Date.now());
          else if (kind !== 'failed') failedAt.delete(s.n);
        }
      });
    },
    /** What window `i` says instead of its picture, or undefined while it plays (or starts). */
    failure: (i: number) => {
      const w = windowAt(i);
      const slot = slotOf(i);
      if (!w || !slot) return undefined;
      // Waiting to open after "Watch this one instead": it shows "Freeing a connection…", not the old failure.
      if (freeingSlot() === w.slot) return undefined;
      const note = windowNotes().get(w.slot);
      const st = slot.playback.status();
      const t = d.now();
      if (note?.deviceLimit) {
        return tileFailure({ reason: st?.kind === 'failed' ? st.reason : 'unsupported', deviceLimit: true, at: note.at, now: t });
      }
      // Held by a cooldown (its stream stopped, nothing opens): the cooldown's words and Retry now, never a black window.
      const cooldown = cooldownForStream(slot.playback.current());
      if (cooldown.state !== 'clear' && st?.kind !== 'playing') {
        return tileFailure({ reason: st?.kind === 'failed' ? st.reason : 'refused', cooldown, at: t, now: t });
      }
      if (yielded().has(w.slot) && st?.kind !== 'playing' && st?.kind !== 'loading' && st?.kind !== 'reconnecting') {
        return { text: MULTIVIEW_COPY.stoppedForOther, retry: { enabled: true, inMs: 0 }, close: true as const };
      }
      if (note) {
        const kicked = note.kicked ?? (note.pingPong ? Math.max(1, (state()?.windows.length ?? 2) - 1) : undefined);
        return tileFailure({ reason: 'refused', ...(kicked !== undefined ? { kicked } : {}), escalated: note.escalated === true, at: note.at, now: t });
      }
      if (st?.kind !== 'failed') return undefined;
      const reported = activeMaxConnections();
      return tileFailure({
        reason: st.reason, at: failedAt.get(w.slot) ?? t, now: t,
        ...(st.httpStatus !== undefined ? { httpStatus: st.httpStatus } : {}),
        ...(reported !== undefined ? { maxConnections: reported } : {}),
      });
    },
  };
}

export type MvHealth = ReturnType<typeof createMvHealth>;
