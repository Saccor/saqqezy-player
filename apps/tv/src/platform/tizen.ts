import { TIZEN_KEYS_TO_REGISTER } from '@iptv/platform';
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
  avplay?: AvplayLike;
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
 * `<object type="application/avplayer">`. Html, body and the layer lose their opaque backgrounds; screens draw
 * their own.
 */
export function mountAvplayObject(root: HTMLElement, doc: Document = document): HTMLElement {
  const obj = doc.createElement('object');
  obj.setAttribute('type', 'application/avplayer');
  Object.assign(obj.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%' });
  Object.assign(root.style, { left: '0', top: '0', width: '100%', height: '100%', background: 'transparent' });
  root.appendChild(obj);
  doc.documentElement.style.background = 'transparent';
  doc.body.style.background = 'transparent';
  return obj;
}
