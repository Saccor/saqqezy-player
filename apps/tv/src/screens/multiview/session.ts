import type { PlayableChannel } from '@iptv/app-api';
import type { Rect } from '@iptv/player';
import { layout, type SizeClass, type TileGeometry } from './layout.ts';
import { layoutInput, type MvState, type MvWindow } from './mvLogic.ts';

/**
 * Multiview's link to the playback slots (spec 2026-10-20-multiview §7; owner 2026-10-22: no reconnect on leave).
 * Entering keeps the playing slot as window 1; a window opens in a free slot, muted, sized and placed before its one
 * counted play; layout changes are rects only; the sound is the pool's primary slot; leaving frees every other slot and
 * leaves the one with sound playing full screen. No stream is ever moved between slots. Testable with fake slots.
 */
export interface SessionSlot {
  readonly n: number;
  player: {
    setMuted?(muted: boolean): void;
    setEngineOverrides?(o: { hls?: Record<string, unknown>; mpegts?: Record<string, unknown> } | undefined): void;
  };
  playback: {
    setRect(rect: Rect | 'fullscreen'): void;
    playChannel(ch: PlayableChannel, opts?: { countOpen?: boolean }): boolean;
    stop(): void;
    current(): PlayableChannel | undefined;
  };
}

export interface SessionPool<S extends SessionSlot> {
  readonly max: number;
  slot(n: number): S;
  primary(): number;
  setPrimary(n: number): void;
  release(): void;
}

export interface SessionDeps<S extends SessionSlot> {
  pool: SessionPool<S>;
  setInMultiview(open: boolean): void;
  fetch(channelId: string): Promise<PlayableChannel | undefined>;
  /** The engine profile for a window of this size (`tileProfile`). */
  profile(sizeClass: SizeClass): { hls?: Record<string, unknown>; mpegts?: Record<string, unknown> };
}

export interface MultiviewSession {
  /** Multiview opens over the playing channel; undefined when nothing plays. */
  enter(): MvWindow | undefined;
  /** Opens `channelId` in a free slot at `at`; undefined when no slot is free or the channel is gone. */
  openWindow(channelId: string, windows: readonly MvWindow[], at: TileGeometry): Promise<MvWindow | undefined>;
  /** Changes the channel of a window in place (its slot closes the old stream before it opens the new one). */
  changeChannel(w: MvWindow, channelId: string): Promise<MvWindow | undefined>;
  /** Stops a window's stream (Close window); its slot is freed on leave. */
  close(w: MvWindow): void;
  /** Rects and sound for `s`: never a play. */
  apply(s: MvState, windowLimit: number): void;
  /** Leaves multiview: the slot with sound keeps playing full screen; the others are freed. */
  leave(): void;
}

const HIDDEN: Rect = { x: 0, y: 0, w: 0, h: 0 };

export function createMultiviewSession<S extends SessionSlot>(d: SessionDeps<S>): MultiviewSession {
  const freeSlot = (windows: readonly MvWindow[]): number | undefined => {
    for (let n = 0; n < d.pool.max; n++) if (!windows.some((w) => w.slot === n)) return n;
    return undefined;
  };
  return {
    enter() {
      const slot = d.pool.slot(d.pool.primary());
      const cur = slot.playback.current();
      if (!cur) return undefined;
      d.setInMultiview(true);
      return { slot: slot.n, channelId: cur.id };
    },
    async openWindow(channelId, windows, at) {
      const n = freeSlot(windows);
      if (n === undefined) return undefined;
      const ch = await d.fetch(channelId);
      if (!ch) return undefined;
      const slot = d.pool.slot(n);
      slot.player.setMuted?.(true);
      slot.player.setEngineOverrides?.(d.profile(at.sizeClass));
      slot.playback.setRect(at.rect);
      slot.playback.playChannel(ch, { countOpen: true });
      return { slot: n, channelId: ch.id };
    },
    async changeChannel(w, channelId) {
      const ch = await d.fetch(channelId);
      if (!ch) return undefined;
      d.pool.slot(w.slot).playback.playChannel(ch, { countOpen: d.pool.primary() !== w.slot });
      return { slot: w.slot, channelId: ch.id };
    },
    close(w) {
      d.pool.slot(w.slot).playback.stop();
    },
    apply(s, windowLimit) {
      const l = layout(layoutInput(s, windowLimit));
      for (const t of l.tiles) {
        const w = s.windows[t.tile];
        if (!w) continue;
        // Full screen: that window fills the screen; the others keep playing at no size (their boxes would cover it).
        const rect = s.fullScreen === undefined ? t.rect : s.fullScreen === t.tile ? 'fullscreen' : HIDDEN;
        d.pool.slot(w.slot).playback.setRect(rect);
      }
      const sound = s.windows[s.sound];
      if (sound && sound.slot !== d.pool.primary()) d.pool.setPrimary(sound.slot);
    },
    leave() {
      d.pool.release();
      d.setInMultiview(false);
      const main = d.pool.slot(d.pool.primary());
      main.player.setEngineOverrides?.(undefined);
      main.player.setMuted?.(false);
      main.playback.setRect('fullscreen');
    },
  };
}
