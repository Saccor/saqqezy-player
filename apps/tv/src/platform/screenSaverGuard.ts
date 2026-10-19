export type SaverState = 'on' | 'off';
export interface SaverInput {
  /** The video covers the screen (live Player or VodPlay), not the Home/Guide preview. */
  fullscreen: boolean;
  /** A picture is up: playing, or a reconnect holding the last frame. */
  video: boolean;
  paused: boolean;
}

/** Off only while fullscreen video plays; on everywhere else (OLED burn-in on long previews). */
export function desiredScreenSaver(i: SaverInput): SaverState {
  return i.fullscreen && i.video && !i.paused ? 'off' : 'on';
}

export function createScreenSaverGuard(set: (s: SaverState) => void): { update(i: SaverInput): void } {
  let last: SaverState | undefined;
  return {
    update(i) {
      const want = desiredScreenSaver(i);
      if (want === last) return;
      last = want;
      try {
        set(want);
      } catch {
        // Not available on this TV: the platform default stays.
      }
    },
  };
}
