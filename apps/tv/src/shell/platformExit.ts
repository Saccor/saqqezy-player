import type { PlatformId } from '@iptv/platform';
import { exit as exitTizen, type TizenLike } from '../platform/tizen.ts';

/** Only the error's name is logged: messages may carry URLs or other data. */
function errName(err: unknown): string | undefined {
  return (err as { name?: unknown } | null | undefined)?.name as string | undefined;
}

interface ExitGlobals {
  tizen?: TizenLike;
  close?: () => void;
}

/** Leaves the app: Tizen exits the application, webOS closes the window, the browser does nothing. */
export function exitApp(platform: PlatformId, g: ExitGlobals = globalThis as unknown as ExitGlobals): void {
  try {
    if (platform === 'tizen') exitTizen(g);
    else if (platform === 'webos') g.close?.();
  } catch (err) {
    console.error('Exit failed', errName(err));
  }
}
