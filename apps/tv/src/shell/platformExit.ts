import type { PlatformId } from '@iptv/platform';

interface ExitGlobals {
  tizen?: { application?: { getCurrentApplication?: () => { exit?: () => void } } };
  close?: () => void;
}

/** Leaves the app: Tizen exits the application, webOS closes the window, the browser does nothing. */
export function exitApp(platform: PlatformId, g: ExitGlobals = globalThis as unknown as ExitGlobals): void {
  try {
    if (platform === 'tizen') g.tizen?.application?.getCurrentApplication?.()?.exit?.();
    else if (platform === 'webos') g.close?.();
  } catch (err) {
    console.error('Exit failed', err);
  }
}
