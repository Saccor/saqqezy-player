import { streamCooldownKey } from '@iptv/core';
import {
  ConnectionLedger, PlaybackJournal, PlaybackSupervisor, SharedOpenGap, SourceOpenRate, type JournalEvent, type Player,
} from '@iptv/player';
import { api } from '../api.ts';
import { cooldownOf, initState, platformId, setStreamCooldown, setSupervisorStatus, settings } from '../state/appState.ts';
import { AVPLAY_DISPLAY_SPACE, getAvplay, mountAvplayObject, readPanelCaps, setScreenSaver } from '../platform/tizen.ts';
import { AvplayPlayer } from '../video/AvplayPlayer.ts';
import { isTvPlatform } from '../video/engineConfig.ts';
import { Html5Player } from '../video/Html5Player.ts';
import { createSlotRoot, createVideoLayer } from '../video/videoLayer.ts';
import { SOURCE_COPY } from '../copy.ts';
import { showToast } from '../shell/Toast.tsx';
import { createSignal } from 'solid-js';
import { createPlaybackController, type CooldownGate, type PlaybackController, type PlayerKind } from './controller.ts';
import { createPlaybackPool, type PlaybackPool } from './pool.ts';
import { createPrimaryFacade } from './primary.ts';
import { createRefusalScope } from './refusalScope.ts';
import { slotRole, type SlotRole } from './slotRole.ts';
import { createJournalPersist, pageLoadEvent } from './journalStore.ts';
import { createLiveTargetStore } from './liveTargets.ts';
import { retryDeps } from './retryDeps.ts';
import { createSharedSleepTimer } from './sleepTimer.ts';
import { onBackOnline } from '../state/backOnline.ts';

/**
 * The app's playback: a pool of stacks (video layer, player, `PlaybackSupervisor`, controller). Outside multiview one
 * stack plays: the Home preview and the fullscreen Player share it, so going fullscreen is just a rect change.
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

function createStack(root: HTMLElement): { player: AppPlayer; layer: { relayout(): void; destroy?(): void } } {
  if (avplay) {
    mountAvplayObject(root);
    // AVPlay works in design space, so a window resize needs no relayout.
    // `journal` is read at open time, after this module has finished loading.
    const note = (what: 'refererDropped') => journal.add({ k: 'note', t: Date.now(), what });
    const player = new AvplayPlayer(avplay, {
      displaySpace: AVPLAY_DISPLAY_SPACE,
      note,
      screenSaver: (s) => { setScreenSaver(s); },
      panel: readPanelCaps(),
    });
    // The app is going away: hand the screensaver back to the TV.
    window.addEventListener('pagehide', () => { setScreenSaver('on'); });
    return { player, layer: { relayout: () => {} } };
  }
  const layer = createVideoLayer(root);
  // Native HLS only on TVs. Desktop Chrome reports native HLS too, but its built-in player cannot decode HEVC in
  // TS segments (UHD channels): sound over a black picture, with no error. hls.js plays them, so desktop uses it.
  return { player: new Html5Player(layer, { preferNativeHls: isTv, isTv }), layer };
}

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

/** Per source, the gap between opens of every slot (multiview windows open about 1.15 s apart). */
const openGap = new SharedOpenGap();
/** Per source and host, the streams every slot has open: a window's refusal can stay on that window. */
export const ledger = new ConnectionLedger();

const reportFailed = (err: unknown) => console.warn('Cooldown report failed', err instanceof Error ? err.name : 'Error');

/** The worker owns the refusal cooldown: no stream opens while its host or the active source is cooling down. */
const cooldownGate: CooldownGate = {
  // The playable's seed counts until the worker announces that host (it is published only after this decision).
  blocked: (s) => cooldownOf(s.cooldownKey, s.cooldown).state !== 'clear',
  refused: (key, url, retryAfterMs) => { api.reportStreamRefused(key, url, retryAfterMs).catch(reportFailed); },
  answered: (key, url) => { api.reportStreamAnswered(key, url).catch(reportFailed); },
};

/** One playback stack. Slot 0 starts as the single-view player; slots 1..3 are made for multiview windows. */
export interface PlaybackSlot {
  readonly n: number;
  player: AppPlayer;
  supervisor: PlaybackSupervisor;
  playback: PlaybackController;
  layer: { relayout(): void };
  stop(): void;
  dispose?(): void;
}

/** The slot with sound (the pool's primary), as a signal: the app-wide exports and the slot roles follow it. */
const [primaryIndex, setPrimaryIndex] = createSignal(0);
const [multiviewOpen, setMultiviewOpen] = createSignal(false);
/** The multiview screen says when it is open: every slot is then a window, the one with sound too. */
export const setInMultiview = (open: boolean): void => { setMultiviewOpen(open); };
export const inMultiview = multiviewOpen;
const roleOf = (n: number): SlotRole => slotRole(n, primaryIndex(), multiviewOpen());

/** Window refusals per host this session: the 4th within 10 min cools the host down after all. */
const refusalScope = createRefusalScope();

/**
 * Builds slot `n` around its player. Its role (`slotRole`) is read when used, so a window that keeps the sound when
 * multiview ends becomes the single-view player with no reconnect, and back. The single-view player keeps today's
 * behaviour: the user's live delay, learned live targets, one immediate retry after a refusal and the host cooldown.
 * A window uses the `stable` delay, learns nothing, and a refusal stops only it unless it is about the host.
 */
function buildSlot(n: number, slotPlayer: AppPlayer, layer: { relayout(): void }, kind: PlayerKind, dispose?: () => void): PlaybackSlot {
  const single = () => roleOf(n) === 'single';
  const slotSupervisor = new PlaybackSupervisor(slotPlayer, {
    preset: () => (single() ? settings()?.liveDelay ?? 'balanced' : 'stable'),
    // TVs mute or ignore playbackRate changes: they correct drift by seeking only.
    allowRate: !isTv,
    liveTargets: {
      get: (key) => (single() ? liveTargets.get(key) : undefined),
      set: (key, raise) => { if (single()) liveTargets.set(key, raise); },
    },
    journal,
    openRate,
    openGap,
    ledger,
    tile: () => (single() ? undefined : n),
    onRefusal: () => (single() ? 'retry' : 'stop'),
    ...retryDeps,
  });
  const primary = () => primaryIndex() === n;
  const slotPlayback = createPlaybackController(
    // Status changes feed the debug overlay, and the stream's host the cooldown copy, for the slot with sound only.
    slotPlayer, slotSupervisor, (s) => { if (primary()) setSupervisorStatus(s); }, kind, () => initState()?.activeSourceId,
    { ...cooldownGate, current: (s) => { if (primary()) setStreamCooldown(s?.cooldownKey, s?.cooldown); } },
    (what) => journal.add({ k: 'page', t: Date.now(), what }),
    // A combined channel: its next stream takes over when one fails (never after a refusal; at most two per tune).
    {
      fetch: (id) => api.getPlayable(id, { exact: true }),
      failed: (id) => { api.reportSourceFailed(id).catch(reportFailed); },
      switched: () => showToast(SOURCE_COPY.switched),
    },
    { scope: (key, url, facts) => (single() ? 'host' : refusalScope.decide(streamCooldownKey(key, url), facts)) },
  );
  const slot: PlaybackSlot = {
    n, player: slotPlayer, supervisor: slotSupervisor, playback: slotPlayback, layer, stop: () => slotPlayback.stop(),
  };
  if (dispose) {
    slot.dispose = () => {
      slotSupervisor.dispose();
      dispose();
    };
  }
  return slot;
}

/** Slot 0 on `#video-layer`, made again on demand after multiview freed it (another window kept the sound). */
function createMainSlot(): PlaybackSlot {
  const stack = createStack(videoRoot!);
  return buildSlot(0, stack.player, stack.layer, avplay ? 'AVPlay' : 'HTML5', () => {
    stack.player.destroy();
    stack.layer.destroy?.();
  });
}

/** A multiview window's slot (desktop only): its own `<video>` root right after `#video-layer`. */
function createWindowSlot(n: number): PlaybackSlot {
  const root = createSlotRoot(videoRoot!, n);
  const layer = createVideoLayer(root);
  const windowPlayer = new Html5Player(layer, { preferNativeHls: isTv, isTv });
  return buildSlot(n, windowPlayer, layer, 'HTML5', () => {
    windowPlayer.destroy();
    layer.destroy();
    root.remove();
  });
}

/**
 * Every playback slot. TVs keep one video until the P4 spike, so only desktop may have windows. The first slot 0 is
 * never disposed while it is primary; it is built with `dispose` so multiview can free it when another window keeps
 * the sound.
 */
export const pool: PlaybackPool<PlaybackSlot> = createPlaybackPool<PlaybackSlot>(
  createMainSlot(), (n) => (n === 0 ? createMainSlot() : createWindowSlot(n)), isTv || avplay ? 1 : 4,
);
pool.onPrimary((n) => {
  setPrimaryIndex(n);
  // The new single-view player's status and stream feed the overlay and the cooldown copy from now on.
  const p = pool.slot(n).playback;
  setSupervisorStatus(p.status());
  const cur = p.current();
  setStreamCooldown(cur?.cooldownKey, cur?.cooldown);
});

/** The slot with sound, read reactively (Solid tracks `primaryIndex`). */
const primarySlot = (): PlaybackSlot => {
  primaryIndex();
  return pool.slots()[0]!;
};

/**
 * The single-view player, its supervisor and its controller: always the slot with sound. Screens keep importing these;
 * they follow multiview's sound moves with no reconnect.
 */
export const player: AppPlayer = createPrimaryFacade(() => primarySlot().player);
export const supervisor: PlaybackSupervisor = createPrimaryFacade(() => primarySlot().supervisor);
/** `playChannel`, `stop`, `setRect`, `playerKind`, `status` and `current`; status changes also feed the debug overlay. */
export const playback: PlaybackController = createPrimaryFacade(() => primarySlot().playback);
/** Re-applies every slot's video layout after a window resize. */
export const videoLayer: { relayout(): void } = { relayout: () => { for (const s of pool.slots()) s.layer.relayout(); } };

// Engines that can suspend (AVPlay) get the multitasking path: live closes, VOD suspends (spec 3.1).
const canSuspend = typeof player.suspend === 'function';
// A live channel closed in the background while the network was down reopens once it is back.
onBackOnline(globalThis.window, () => { for (const s of pool.slots()) s.playback.networkBack(); });

// Hidden pages present no frames: the stall ladder pauses while hidden. Back from the background after a while,
// the stream is behind, so jump to live.
let hiddenAt: number | undefined;
document.addEventListener('visibilitychange', () => {
  for (const s of pool.slots()) s.supervisor.setHidden(document.hidden);
  journal.add({ k: 'page', t: Date.now(), what: document.hidden ? 'hidden' : 'visible' });
  // TVs may suspend or kill a backgrounded app without firing pagehide.
  if (document.hidden) journal.flush();
  if (document.hidden) {
    hiddenAt = Date.now();
    if (canSuspend) for (const s of pool.slots()) s.playback.suspendForBackground();
    return;
  }
  if (canSuspend) for (const s of pool.slots()) s.playback.resumeFromBackground({ networkUp: navigator.onLine !== false });
  else if (hiddenAt !== undefined) for (const s of pool.slots()) s.supervisor.onResume(Date.now() - hiddenAt);
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

/**
 * The Player's sleep timer, one for the app: it survives Player remounts (the Guide, Home and back). When it runs
 * out while no Player is on screen to ask "Still watching?", live playback simply stops. A film or episode
 * (`vod:` ids, VodPlay's own screen) is never cut: the timer belongs to live TV.
 */
export const sleepTimer = createSharedSleepTimer({ onExpireUnattended: () => { if (!isVodId(playback.current()?.id)) pool.stopAll(); } });

/** VodPlay's playables carry a `vod:` id (see `liveReturn.ts`). */
export function isVodId(id: string | undefined): boolean {
  return id !== undefined && id.startsWith('vod:');
}
