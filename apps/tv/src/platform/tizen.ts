import { TIZEN_KEYS_TO_REGISTER } from '@iptv/platform';
import type { PanelCaps } from '../video/adaptiveInfo.ts';
import type { AvplayLike, Size } from '../video/AvplayPlayer.ts';

/** The part of the `tizen` global this app uses. */
export interface TizenLike {
  tvinputdevice?: {
    registerKey(key: string): void;
    registerKeyBatch?(keys: string[], success?: () => void, error?: (e: unknown) => void): void;
  };
  application?: { getCurrentApplication(): { exit(): void } };
}

/** The part of the `webapis` global this app uses. */
export interface WebapisLike {
  avplay?: AvplayLike & { getVersion?(): string };
  /** Extra AVPlay instances (up to 4); multiview windows use them. */
  avplaystore?: { getPlayer(): AvplayLike };
  productinfo?: { isUdPanelSupported?(): boolean; is8KPanelSupported?(): boolean };
  avinfo?: { isHdrTvSupport?(): boolean };
  appcommon?: {
    AppCommonScreenSaverState?: { SCREEN_SAVER_OFF: unknown; SCREEN_SAVER_ON: unknown };
    setScreenSaver(state: unknown, success?: () => void, error?: (e: unknown) => void): void;
  };
}

interface TizenGlobals { tizen?: TizenLike; webapis?: WebapisLike }

const globals = (): TizenGlobals => globalThis as unknown as TizenGlobals;

/**
 * AVPlay's `setDisplayRect` coordinates. Samsung documents them as a fixed 1920x1080 space whatever the panel
 * (FHD, UHD or 8K) or the app's own resolution, which is exactly the app's design space. If a real TV shows the
 * video at the wrong size, this is the one value to change (e.g. to the panel size from `webapis.productinfo`).
 */
export const AVPLAY_DISPLAY_SPACE: Size = { w: 1920, h: 1080 };

/**
 * Asks the TV to deliver the remote keys the app uses (colour keys, digits, channel, play/pause, info);
 * without this Tizen keeps them for itself. Arrows, OK and Back are always delivered.
 * Returns false outside Tizen.
 */
export function registerKeys(g: TizenGlobals = globals()): boolean {
  const input = g.tizen?.tvinputdevice;
  if (!input) return false;
  const oneByOne = () => {
    for (const key of TIZEN_KEYS_TO_REGISTER) {
      try {
        input.registerKey(key);
      } catch {
        // Not on this remote/model: skip it, register the rest.
      }
    }
  };
  if (typeof input.registerKeyBatch === 'function') {
    try {
      input.registerKeyBatch([...TIZEN_KEYS_TO_REGISTER], undefined, oneByOne);
      return true;
    } catch {
      // fall through
    }
  }
  oneByOne();
  return true;
}

/** Leaves the app (back to the TV's home screen). Never throws. */
export function exit(g: TizenGlobals = globals()): void {
  try {
    g.tizen?.application?.getCurrentApplication().exit();
  } catch {
    // Nothing more we can do.
  }
}

/** `webapis.avplay` when running as a Tizen app with the AVPlay privilege, else undefined. */
export function getAvplay(g: TizenGlobals = globals()): AvplayLike | undefined {
  return g.webapis?.avplay;
}

/** An AVPlay that plays nothing: every open throws `NotSupportedError`, which the window shows as its failure. */
function unavailableAvplay(): AvplayLike {
  const none = () => {};
  const stub: AvplayLike = {
    open: () => { throw Object.assign(new Error('No AVPlay instance'), { name: 'NotSupportedError' }); },
    close: none, prepareAsync: none, play: none, stop: none, setListener: none, setDisplayRect: none, setDisplayMethod: none,
    getCurrentTime: () => 0, getTotalTrackInfo: () => [], setSelectTrack: none, getCurrentStreamInfo: () => [],
  };
  stubs.add(stub);
  return stub;
}

const stubs = new WeakSet<AvplayLike>();

/** True for the player `getAvplayStorePlayer` hands out when the store refused an instance. */
export function isUnavailableAvplay(p: AvplayLike): boolean {
  return stubs.has(p);
}

/**
 * `avplaystore` instances for multiview windows, reused: the store makes at most 4 and has no call to give one back,
 * so a window's instance goes back here when its slot is freed and the next window takes it.
 */
export function createAvplayStorePool(g: TizenGlobals = globals()): { take(): AvplayLike; give(p: AvplayLike): void } {
  const spare: AvplayLike[] = [];
  return {
    take: () => spare.pop() ?? getAvplayStorePlayer(g),
    // A stub is not kept: the next window asks the store again (memory may be free by then).
    give: (p) => { if (!stubs.has(p)) spare.push(p); },
  };
}

/**
 * A new AVPlay instance for a multiview window (`webapis.avplaystore.getPlayer()`). The store throws past 4 instances
 * or when memory is short: that window then gets a player whose opens fail. Never throws.
 */
export function getAvplayStorePlayer(g: TizenGlobals = globals()): AvplayLike {
  try {
    const p = g.webapis?.avplaystore?.getPlayer();
    if (p) return p;
  } catch {
    // QUOTA_EXCEEDED_ERR or no store
  }
  return unavailableAvplay();
}

/**
 * What the panel can show, read once and synchronously: UHD, 8K, HDR TV and the AVPlay version. Every call is
 * feature-detected and tried on its own; a boolean is true only when the call returned `true`, so a missing API,
 * a throw or a monitor-class display all read as Full HD (today's behaviour); `answered` records which calls gave a real answer. Never throws.
 */
export function readPanelCaps(g: TizenGlobals = globals()): PanelCaps {
  /** undefined = no answer (missing, threw, or not a boolean). */
  const ask = (fn: () => unknown): boolean | undefined => {
    try {
      const v = fn();
      return typeof v === 'boolean' ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const w = g.webapis;
  const uhd = ask(() => w?.productinfo?.isUdPanelSupported?.());
  const eightK = ask(() => w?.productinfo?.is8KPanelSupported?.());
  const hdrTv = ask(() => w?.avinfo?.isHdrTvSupport?.());
  const caps: PanelCaps = { uhd: uhd === true, eightK: eightK === true, hdrTv: hdrTv === true };
  const answered: NonNullable<PanelCaps['answered']> = {};
  if (uhd !== undefined) answered.uhd = true;
  if (eightK !== undefined) answered.eightK = true;
  if (hdrTv !== undefined) answered.hdrTv = true;
  if (Object.keys(answered).length > 0) caps.answered = answered;
  try {
    const v = w?.avplay?.getVersion?.();
    if (typeof v === 'string' && v) caps.avplayVersion = v;
  } catch {
    // version stays unknown
  }
  return caps;
}

/** Turns the TV's screensaver off (fullscreen video) or back on. False when the API is missing or refused. */
export function setScreenSaver(state: 'on' | 'off', g: TizenGlobals = globals()): boolean {
  const ac = g.webapis?.appcommon;
  const states = ac?.AppCommonScreenSaverState;
  if (!ac || !states) return false;
  try {
    ac.setScreenSaver(state === 'off' ? states.SCREEN_SAVER_OFF : states.SCREEN_SAVER_ON);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prepares `#video-layer` for AVPlay: AVPlay draws on a video plane *beneath* the whole page, so the page must be
 * transparent where video shows (the Lightning canvas already is) and the document needs one
 * `<object type="application/avplayer">` (one for every player). Html, body and the layer lose their opaque backgrounds; screens draw
 * their own.
 */
export function mountAvplayObject(root: HTMLElement, doc: Document = document): HTMLElement {
  // Slot 0 is made again after multiview freed it: every AVPlay player shares the one object.
  const existing = root.querySelector<HTMLElement>('object[type="application/avplayer"]');
  if (existing) return existing;
  const obj = doc.createElement('object');
  obj.setAttribute('type', 'application/avplayer');
  Object.assign(obj.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%' });
  Object.assign(root.style, { left: '0', top: '0', width: '100%', height: '100%', background: 'transparent' });
  root.appendChild(obj);
  doc.documentElement.style.background = 'transparent';
  doc.body.style.background = 'transparent';
  return obj;
}
