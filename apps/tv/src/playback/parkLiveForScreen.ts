import { initState } from '../state/appState.ts';
import { liveReturn } from '../vod/liveReturn.ts';
import { createParkLive } from './parkLive.ts';
import { playback, pool } from './playback.ts';

/** `createParkLive` bound to the app's playback, source and live-return slot. Call once in a screen's `onMount`. */
export const parkLiveForScreen = createParkLive({
  currentId: () => playback.current()?.id,
  statusKind: () => playback.status()?.kind,
  rectIsFullscreen: () => playback.rectIsFullscreen(),
  activeSourceId: () => initState()?.activeSourceId,
  stop: () => pool.stopAll(),
  setRect: (rect) => playback.setRect(rect),
  liveReturn,
});
