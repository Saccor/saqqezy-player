import { PlaybackSupervisor, type Player } from '@iptv/player';
import { initState, platformId, setSupervisorStatus, settings } from '../state/appState.ts';
import { AVPLAY_DISPLAY_SPACE, getAvplay, mountAvplayObject } from '../platform/tizen.ts';
import { AvplayPlayer } from '../video/AvplayPlayer.ts';
import { isTvPlatform } from '../video/engineConfig.ts';
import { Html5Player } from '../video/Html5Player.ts';
import { createVideoLayer } from '../video/videoLayer.ts';
import { createPlaybackController } from './controller.ts';
import { createLiveTargetStore } from './liveTargets.ts';

/**
 * The app's single playback stack: one video layer, one player, one `PlaybackSupervisor`. The Home preview and
 * the fullscreen Player share it, so only one stream is ever open and going fullscreen is just a rect change.
 * On Tizen (with `webapis.avplay` available) the player is `AvplayPlayer` on Samsung's video plane; everywhere
 * else it is `Html5Player` on a `<video>`.
 */
const videoRoot = document.getElementById('video-layer');
if (!videoRoot) throw new Error('index.html is missing #video-layer');

/** The shared player, plus the in-flight URL for the stream info panel (credentials: never display/log it). */
export interface AppPlayer extends Player {
  currentUrl(): string | undefined;
  /** HTML5 only: drops a mute the desktop autoplay policy forced on us (call from a user gesture). */
  unmuteIfAutoMuted?(): void;
}

const isTv = isTvPlatform(platformId);
const avplay = platformId === 'tizen' ? getAvplay() : undefined;

function createStack(root: HTMLElement): { player: AppPlayer; layer: { relayout(): void } } {
  if (avplay) {
    mountAvplayObject(root);
    // AVPlay works in design space, so a window resize needs no relayout.
    return { player: new AvplayPlayer(avplay, { displaySpace: AVPLAY_DISPLAY_SPACE }), layer: { relayout: () => {} } };
  }
  const layer = createVideoLayer(root);
  // Dev-only switch to exercise the hls.js path on browsers that also have native HLS: `?hlsjs`.
  const forceHlsJs = import.meta.env.DEV && new URLSearchParams(location.search).has('hlsjs');
  return { player: new Html5Player(layer, { preferNativeHls: !forceHlsJs, isTv }), layer };
}

const stack = createStack(videoRoot);
export const player: AppPlayer = stack.player;
/** Re-applies the video layout after a window resize. */
export const videoLayer: { relayout(): void } = stack.layer;

/** Learned live delay per source (this device only). */
const liveTargets = createLiveTargetStore(() => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
});

export const supervisor = new PlaybackSupervisor(player, {
  preset: () => settings()?.liveDelay ?? 'balanced',
  // TVs mute or ignore playbackRate changes: they correct drift by seeking only.
  allowRate: !isTv,
  liveTargets,
});

/** `playChannel`, `stop`, `setRect`, `playerKind`, `status` and `current`; status changes also feed the debug overlay. */
export const playback = createPlaybackController(
  player, supervisor, setSupervisorStatus, avplay ? 'AVPlay' : 'HTML5', () => initState()?.activeSourceId,
);

// Hidden pages present no frames: the stall ladder pauses while hidden. Back from the background after a while,
// the stream is behind, so jump to live.
let hiddenAt: number | undefined;
document.addEventListener('visibilitychange', () => {
  supervisor.setHidden(document.hidden);
  if (document.hidden) {
    hiddenAt = Date.now();
    return;
  }
  if (hiddenAt !== undefined) supervisor.onResume(Date.now() - hiddenAt);
  hiddenAt = undefined;
});

let previewHeld = false;
/**
 * Set when playback was stopped on purpose (sleep timer) right before returning to Home: Home then does not
 * resume or auto-preview until the user moves the focus. `take()` reads and clears it.
 */
export const previewHold = {
  set(): void { previewHeld = true; },
  take(): boolean { const v = previewHeld; previewHeld = false; return v; },
};
