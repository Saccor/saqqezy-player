import { readHostInfo, type ExitPolicy, type PlatformId } from '@iptv/platform';
import { exit as exitTizen, type TizenLike } from '../platform/tizen.ts';

/** Only the error's name is logged: messages may carry URLs or other data. */
function errName(err: unknown): string | undefined {
  return (err as { name?: unknown } | null | undefined)?.name as string | undefined;
}

export interface ExitGlobals {
  tizen?: TizenLike;
  /** LG's webOSTV.js global (packaged with the webOS app). */
  webOS?: { platformBack?: () => void };
  /** A native shell's host object (desktop, Android TV). */
  __IPTV_HOST__?: unknown;
}

const globals = (): ExitGlobals => globalThis as unknown as ExitGlobals;

/**
 * Leaves the app:
 * - Tizen exits the application.
 * - webOS hands Back to the platform (`platformBack()`: the system exit popup on 6.0+, Home on 5.x). `window.close()`
 *   is not used: LG's checklist wants the platform's own behaviour.
 * - Desktop and Android TV ask their native host.
 * - The browser does nothing.
 */
export function exitApp(platform: PlatformId, g: ExitGlobals = globals()): void {
  try {
    if (platform === 'tizen') exitTizen(g);
    else if (platform === 'webos') {
      const back = g.webOS?.platformBack;
      if (typeof back === 'function') back.call(g.webOS);
      else console.warn('Exit failed', 'NoPlatformBack');
    } else if (platform === 'desktop' || platform === 'androidtv') {
      readHostInfo(g.__IPTV_HOST__)?.exit?.();
    }
  } catch (err) {
    console.error('Exit failed', errName(err));
  }
}

/** What a Back that reached the root did. */
export type RootBack = 'dialog' | 'left' | 'ignored';

/**
 * A Back no screen handled reached the root (spec 2026-10-26 §0.6):
 * - A repeated keydown (the key is held) is ignored. Samsung reserves a long press of Back/Exit for force-close, and
 *   no platform wants a held key to open and close a dialog.
 * - `dialog`: the caller opens our exit question.
 * - Otherwise the app leaves at once, the platform's way.
 */
export function rootBack(policy: ExitPolicy, platform: PlatformId, repeat: boolean, g: ExitGlobals = globals()): RootBack {
  if (repeat) return 'ignored';
  if (policy === 'dialog') return 'dialog';
  exitApp(platform, g);
  return 'left';
}
