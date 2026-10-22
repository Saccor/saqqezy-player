import { streamCooldownKey } from '@iptv/core';
import {
  ConnectionLedger, PlaybackJournal, PlaybackSupervisor, SharedOpenGap, SourceOpenRate, type JournalEvent, type Player,
} from '@iptv/player';
import { api } from '../api.ts';
import { cooldownOf, initState, platformId, setStreamCooldown, setSupervisorStatus, settings } from '../state/appState.ts';
import {
  AVPLAY_DISPLAY_SPACE, createAvplayStorePool, getAvplay, isUnavailableAvplay, mountAvplayObject, readPanelCaps, setScreenSaver,
} from '../platform/tizen.ts';
import { createSharedSaver } from '../platform/screenSaverGuard.ts';
import { createVideoResources, tizenWindowCeiling, type TizenMultiviewGlobals } from '../platform/tizenMultiview.ts';
import { AvplayPlayer, type AvplayLike } from '../video/AvplayPlayer.ts';
import { isTvPlatform } from '../video/engineConfig.ts';
import { Html5Player, type EngineOverrides } from '../video/Html5Player.ts';
import { createSlotRoot, createVideoLayer } from '../video/videoLayer.ts';
import { SOURCE_COPY } from '../copy.ts';
import { showToast } from '../shell/Toast.tsx';
import { createSignal } from 'solid-js';
import { createPlaybackController, type CooldownGate, type PlaybackController, type PlayerKind } from './controller.ts';
import { createPlaybackPool, type PlaybackPool } from './pool.ts';
import { createPrimaryFacade } from './primary.ts';
import { createConnectionMemory } from './connectionMemory.ts';
import { createDeviceWindows, type DeviceRefusal } from './deviceWindows.ts';
import { createDisplacementDetector } from './displacement.ts';
import { classifyRefusal, createRefusalScope, type RefusalFacts, type RefusalScope } from './refusalScope.ts';
import { activeMaxConnections } from '../state/activeLimit.ts';
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
 * else it is `Html5Player` on a `<video>`. Tizen 7.0+ gets two windows, each on an `avplaystore` instance (Samsung's
 * documented two-player pattern), sharing the MAIN and SUB scalers (spec 2026-10-22-tizen-multiview).
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
  /** Multiview: mutes this window while another has the sound (HTML5, and AVPlay through its audio stream). */
  setMuted?(muted: boolean): void;
  /** HTML5 only (multiview): a window's engine profile from its next live open; undefined clears it. */
  setEngineOverrides?(o: EngineOverrides | undefined): void;
}

const isTv = isTvPlatform(platformId);
const avplay = platformId === 'tizen' ? getAvplay() : undefined;
/** Tizen: 2 when the TV has two scalers and per-player audio, else 1 (no multiview). */
const tizenWindows = avplay ? tizenWindowCeiling(globalThis as TizenMultiviewGlobals, navigator.userAgent).windows : 1;
/** The scalers every AVPlay player claims from (Tizen multiview only; single-view TVs set nothing new). */
const videoResources = tizenWindows > 1 ? createVideoResources() : undefined;
/** One screensaver for every AVPlay player: off while any of them shows a picture full screen. */
const sharedSaver = createSharedSaver((s) => { setScreenSaver(s); });
const panelCaps = avplay ? readPanelCaps() : undefined;
/** The windows' AVPlay instances, reused across multiview sessions (the store makes 4 at most). */
const storePlayers = createAvplayStorePool();
// The app is going away: hand the screensaver back to the TV.
if (avplay) window.addEventListener('pagehide', () => { setScreenSaver('on'); });

/** After the frame that shows the key press: rAF, then a macrotask (the frame is painted by then). */
const afterFrame = (fn: () => void): void => {
  requestAnimationFrame(() => { setTimeout(fn, 0); });
};

function createAvplayPlayer(av: AvplayLike, n: number): AvplayPlayer {
  // `journal`, `multiviewOpen` and `refuseDevice` are read when used, after this module has finished loading.
  const note = (what: 'refererDropped') => journal.add({ k: 'note', t: Date.now(), what });
  return new AvplayPlayer(av, {
    displaySpace: AVPLAY_DISPLAY_SPACE,
    afterFrame,
    note,
    screenSaver: sharedSaver.member(),
    ...(panelCaps ? { panel: panelCaps } : {}),
    ...(videoResources ? {
      resources: videoResources, coversScreen: () => multiviewOpen(), deviceRefused: (why: DeviceRefusal) => refuseDevice(why, n),
    } : {}),
  });
}

/**
 * Slot 0's AVPlay: on a multiview TV a store instance too, so both windows are the same kind of player as in Samsung's
 * sample (`webapis.avplay` beside a store instance is undocumented). No instance free: `webapis.avplay`.
 */
function mainAvplay(): { av: AvplayLike; fromStore: boolean } {
  if (videoResources) {
    const av = storePlayers.take();
    if (!isUnavailableAvplay(av)) return { av, fromStore: true };
  }
  return { av: avplay!, fromStore: false };
}

function createStack(root: HTMLElement): { player: AppPlayer; layer: { relayout(): void; destroy?(): void } } {
  if (avplay) {
    mountAvplayObject(root);
    const { av, fromStore } = mainAvplay();
    const player = createAvplayPlayer(av, 0);
    // AVPlay works in design space, so a window resize needs no relayout. A freed store instance is kept for reuse.
    return { player, layer: { relayout: () => {}, ...(fromStore ? { destroy: () => storePlayers.give(av) } : {}) } };
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

/** Multiview windows this device may open: the platform's, or 1 once the TV refused a second picture (remembered). */
const deviceWindows = createDeviceWindows(avplay ? tizenWindows : 1, localStore);
const [deviceWindowsVersion, setDeviceWindowsVersion] = createSignal(0);
/** The device's window ceiling, read reactively (Options, Multiview, Settings > Playback). */
export const deviceWindowMax = (): number => {
  deviceWindowsVersion();
  return avplay ? Math.min(pool.max, deviceWindows.max()) : pool.max;
};
/** Why this TV is down to one window (Diagnostics), read reactively. */
export const deviceRefusal = () => {
  deviceWindowsVersion();
  return deviceWindows.refusal();
};
/** Diagnostics' Test again: the platform's ceiling back, until the TV refuses again. */
export const testMultiviewAgain = (): void => {
  deviceWindows.reset();
  setDeviceWindowsVersion((v) => v + 1);
};
/** The TV refused a second picture: one window from now on, and the window says why. Never a stream's failure. */
function refuseDevice(why: DeviceRefusal, n: number): void {
  if (deviceWindows.refuse(why, Date.now())) setDeviceWindowsVersion((v) => v + 1);
  if (multiviewOpen()) noteWindow(n, { deviceLimit: true, at: Date.now() });
}

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

/** One playback stack. Slot 0 starts as the single-view player; slots 1..5 are made for multiview windows. */
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

/** What multiview learned per source on this device (Diagnostics -> Connections). Numbers only. */
export const connectionMemory = createConnectionMemory(localStore);

/** What a window shows beyond its status: the source cut it, two windows kept cutting each other, or escalation. */
export interface WindowNote { kicked?: number; pingPong?: boolean; escalated?: boolean; deviceLimit?: boolean; at: number }
const [windowNotes, setWindowNotes] = createSignal<ReadonlyMap<number, WindowNote>>(new Map());
export { windowNotes };
const noteWindow = (n: number, note: WindowNote | undefined) => {
  setWindowNotes((m) => {
    const next = new Map(m);
    if (note) next.set(n, note);
    else next.delete(n);
    return next;
  });
};
/** A window opens again (Retry, another channel): its note goes. */
export const clearWindowNote = (n: number): void => { if (windowNotes().has(n)) noteWindow(n, undefined); };

/** A window's refusal: kept on it, or the host's (journaled either way; escalation is noted on the window). */
function scopeWindowRefusal(n: number, hostKey: string, facts: RefusalFacts): RefusalScope {
  // The source cut this window because another opened (the detector said so just before): never the host's refusal.
  if (displacedSlots.delete(n)) return 'tile';
  const scope = refusalScope.decide(hostKey, facts);
  const t = Date.now();
  const reported = activeMaxConnections();
  journal.add({
    k: 'tileRefused', t, tile: n, concurrent: facts.concurrent ?? 0, scope,
    ...(facts.httpStatus !== undefined ? { httpStatus: facts.httpStatus } : {}),
    ...(reported !== undefined ? { reported } : {}),
  });
  if (scope === 'host' && classifyRefusal(facts) === 'tile') {
    journal.add({ k: 'escalated', t, tile: n });
    noteWindow(n, { escalated: true, at: t });
  }
  return scope;
}

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
    {
      ...cooldownGate,
      current: (s) => { if (primary()) setStreamCooldown(s?.cooldownKey, s?.cooldown); },
      // Kept on the window: the source refused window k (k = the streams open + this one).
      tileRefused: (key, _url, facts) => { connectionMemory.learn(key, (facts.concurrent ?? 0) + 1); },
    },
    (what) => journal.add({ k: 'page', t: Date.now(), what }),
    // A combined channel: its next stream takes over when one fails (never after a refusal; at most two per tune).
    {
      fetch: (id) => api.getPlayable(id, { exact: true }),
      failed: (id) => { api.reportSourceFailed(id).catch(reportFailed); },
      switched: () => showToast(SOURCE_COPY.switched),
    },
    { scope: (key, url, facts) => (single() ? 'host' : scopeWindowRefusal(n, streamCooldownKey(key, url), facts)) },
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

/** A multiview window's slot: on Tizen an `avplaystore` instance on the shared plane, else its own `<video>`. */
function createWindowSlot(n: number): PlaybackSlot {
  if (avplay) {
    const av = storePlayers.take();
    const windowPlayer = createAvplayPlayer(av, n);
    // The store had no instance left: the TV cannot show this window.
    if (isUnavailableAvplay(av)) windowPlayer.onState((st) => { if (st === 'error') refuseDevice('noInstance', n); });
    return buildSlot(n, windowPlayer, { relayout: () => {} }, 'AVPlay', () => {
      windowPlayer.destroy();
      storePlayers.give(av);
    });
  }
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
 * Every playback slot. Desktop may have 6 windows, Tizen 7.0+ 2 (two scalers); other TVs keep one video. The first slot 0 is
 * never disposed while it is primary; it is built with `dispose` so multiview can free it when another window keeps
 * the sound.
 */
export const pool: PlaybackPool<PlaybackSlot> = createPlaybackPool<PlaybackSlot>(
  createMainSlot(), (n) => (n === 0 ? createMainSlot() : createWindowSlot(n)), avplay ? tizenWindows : isTv ? 1 : 6,
);
pool.onPrimary((n, prev) => {
  setPrimaryIndex(n);
  // Exactly one window has sound.
  pool.slot(prev).player.setMuted?.(true);
  pool.slot(n).player.setMuted?.(false);
  // The new single-view player's status and stream feed the overlay and the cooldown copy from now on.
  const p = pool.slot(n).playback;
  setSupervisorStatus(p.status());
  const cur = p.current();
  setStreamCooldown(cur?.cooldownKey, cur?.cooldown);
});

const [slotsVersion, setSlotsVersion] = createSignal(0);
pool.onSlots(() => setSlotsVersion((v) => v + 1));
/** The multiview windows without sound, read reactively (each gets its own cooldown hold in `App.tsx`). */
export const otherSlots = (): PlaybackSlot[] => {
  slotsVersion();
  primaryIndex();
  return pool.slots().slice(1);
};

/**
 * A source that cuts the oldest stream when a window opens (spec 2026-10-20-multiview §5.5): the newest window stops
 * with the reason, the cut one gets its one normal reconnect, and the count is learned. Two windows that keep cutting
 * each other: the newer one stops. Only while multiview is open; never retried by itself.
 */
// 20 s, not the spec's 8 s: an HLS player notices a cut only at its next playlist reload (up to one segment, often
// 10 s) plus its own retries; the fake panel's kick mode measured 4 s and 10+ s.
const displacement = createDisplacementDetector({ windowMs: 20_000 });
/** Windows the source just cut: their refusal that follows is the cut, kept on the window. */
const displacedSlots = new Set<number>();
ledger.onEvent((e) => {
  // Always fed (the stream playing before multiview opened counts), acted on only in multiview.
  const v = displacement.feed(e);
  if (!v || !multiviewOpen()) return;
  const t = Date.now();
  const stopSlot = v.k === 'displaced' ? v.byTile : v.stop;
  if (v.k === 'displaced') {
    displacedSlots.add(v.victim);
    journal.add({ k: 'displaced', t, tile: v.victim, byTile: v.byTile, afterMs: v.afterMs });
    connectionMemory.learn(v.key, v.concurrentBefore + 1);
    noteWindow(stopSlot, { kicked: v.concurrentBefore, at: t });
  } else {
    journal.add({ k: 'pingPong', t, tile: v.stop });
    noteWindow(stopSlot, { pingPong: true, at: t });
  }
  // Not inside the supervisor's own failure handling: one macrotask later. The newest window closes first; the window
  // the source cut then gets its one normal reconnect (a window stops on a refusal, so the app opens it once more).
  setTimeout(() => {
    pool.slots().find((s) => s.n === stopSlot)?.playback.stop();
    if (v.k !== 'displaced') return;
    const victim = pool.slots().find((s) => s.n === v.victim);
    const cur = victim?.playback.current();
    if (victim && cur) victim.playback.playChannel(cur, { countOpen: true });
  }, 0);
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
