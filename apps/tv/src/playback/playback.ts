import { PlaybackJournal, PlaybackSupervisor, SourceOpenRate, type JournalEvent, type Player } from '@iptv/player';
import { api } from '../api.ts';
import { cooldownOf, initState, platformId, setStreamCooldown, setSupervisorStatus, settings } from '../state/appState.ts';
import { AVPLAY_DISPLAY_SPACE, getAvplay, mountAvplayObject } from '../platform/tizen.ts';
import { AvplayPlayer } from '../video/AvplayPlayer.ts';
import { isTvPlatform } from '../video/engineConfig.ts';
import { Html5Player } from '../video/Html5Player.ts';
import { createVideoLayer } from '../video/videoLayer.ts';
import { createPlaybackController } from './controller.ts';
import { createJournalPersist, pageLoadEvent } from './journalStore.ts';
import { createLiveTargetStore } from './liveTargets.ts';
import { retryDeps } from './retryDeps.ts';

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
  /** HTML5 only: the app's volume, 0..1. */
  setVolume?(level: number): void;
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
  // Native HLS only on TVs. Desktop Chrome reports native HLS too, but its built-in player cannot decode HEVC in
  // TS segments (UHD channels): sound over a black picture, with no error. hls.js plays them, so desktop uses it.
  return { player: new Html5Player(layer, { preferNativeHls: isTv, isTv }), layer };
}

const stack = createStack(videoRoot);
export const player: AppPlayer = stack.player;
/** Re-applies the video layout after a window resize. */
export const videoLayer: { relayout(): void } = stack.layer;

const localStore = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** Learned live delay per source (this device only). */
const liveTargets = createLiveTargetStore(localStore);

/** What the player did, on this device only (Diagnostics -> Playback log). Survives reloads and restarts. */
export const journal = new PlaybackJournal({ persist: createJournalPersist(localStore) });
journal.add(pageLoadEvent(Date.now(), globalThis.performance));

/**
 * Stream opens per source across zaps, reconnects and reloads (6 a minute, 30 in ten minutes), on this device. Keys
 * are source ids; nothing else is stored.
 */
const OPEN_RATE_KEY = 'iptv.openRate';
const openRate = new SourceOpenRate({
  store: {
    load: () => localStore()?.getItem(OPEN_RATE_KEY),
    save: (data) => localStore()?.setItem(OPEN_RATE_KEY, data),
  },
});

export const supervisor = new PlaybackSupervisor(player, {
  preset: () => settings()?.liveDelay ?? 'balanced',
  // TVs mute or ignore playbackRate changes: they correct drift by seeking only.
  allowRate: !isTv,
  liveTargets,
  journal,
  openRate,
  ...retryDeps,
});

const reportFailed = (err: unknown) => console.warn('Cooldown report failed', err instanceof Error ? err.name : 'Error');

/** `playChannel`, `stop`, `setRect`, `playerKind`, `status` and `current`; status changes also feed the debug overlay. */
export const playback = createPlaybackController(
  player, supervisor, setSupervisorStatus, avplay ? 'AVPlay' : 'HTML5', () => initState()?.activeSourceId,
  // The worker owns the refusal cooldown: no stream opens while its host or the active source is cooling down.
  {
    // The playable's seed counts until the worker announces that host (it is published only after this decision).
    blocked: (s) => cooldownOf(s.cooldownKey, s.cooldown).state !== 'clear',
    refused: (key, url, retryAfterMs) => { api.reportStreamRefused(key, url, retryAfterMs).catch(reportFailed); },
    answered: (key, url) => { api.reportStreamAnswered(key, url).catch(reportFailed); },
    current: (s) => setStreamCooldown(s?.cooldownKey, s?.cooldown),
  },
);

// Hidden pages present no frames: the stall ladder pauses while hidden. Back from the background after a while,
// the stream is behind, so jump to live.
let hiddenAt: number | undefined;
document.addEventListener('visibilitychange', () => {
  supervisor.setHidden(document.hidden);
  journal.add({ k: 'page', t: Date.now(), what: document.hidden ? 'hidden' : 'visible' });
  // TVs may suspend or kill a backgrounded app without firing pagehide.
  if (document.hidden) journal.flush();
  if (document.hidden) {
    hiddenAt = Date.now();
    return;
  }
  if (hiddenAt !== undefined) supervisor.onResume(Date.now() - hiddenAt);
  hiddenAt = undefined;
});

// Saves are throttled: write anything pending before the page goes away.
window.addEventListener('pagehide', () => journal.flush());
if (import.meta.env.DEV) {
  (globalThis as { __playbackLog?: () => JournalEvent[] }).__playbackLog = () => journal.entries();
}

let previewHeld = false;
/**
 * Set when playback was stopped on purpose (sleep timer) right before returning to Home: Home then does not
 * resume or auto-preview until the user moves the focus. `take()` reads and clears it.
 */
export const previewHold = {
  set(): void { previewHeld = true; },
  take(): boolean { const v = previewHeld; previewHeld = false; return v; },
};
