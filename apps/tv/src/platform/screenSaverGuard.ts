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

/**
 * One screensaver for several players (Tizen multiview): each member reports what it wants; the TV's screensaver is
 * off while any member wants it off. `set` runs only on a change and never throws.
 */
export function createSharedSaver(set: (s: SaverState) => void): { member(): (s: SaverState) => void } {
  const wants: SaverState[] = [];
  let last: SaverState | undefined;
  const apply = () => {
    const want: SaverState = wants.includes('off') ? 'off' : 'on';
    if (want === last) return;
    last = want;
    try {
      set(want);
    } catch {
      // Not available on this TV: the platform default stays.
    }
  };
  return {
    member() {
      const i = wants.push('on') - 1;
      return (s) => {
        wants[i] = s;
        apply();
      };
    },
  };
}
