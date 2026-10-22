import type { MaxWindows } from '@iptv/core';

/**
 * How many multiview windows may be open (spec 2026-10-20-multiview §5.2, owner decision §12.2). Only the device and
 * the user's Max windows setting limit it: the source's reported connection limit is information only, never a cap.
 * Pure.
 */
export type { MaxWindows };

/** The most windows any device gets: 4 on desktop since 2026-10-22 (the 3- and 4-window layouts); 5–6 come with P2. */
export const MULTIVIEW_CEILING = 4;

/** What this device can play at once: the pool's slots, at most this phase's ceiling. */
export function deviceCeiling(poolMax: number): number {
  return Math.min(poolMax, MULTIVIEW_CEILING);
}

/** min(device ceiling, Max windows); Auto is the ceiling. */
export function windowLimit(deviceMax: number, userMax: MaxWindows): number {
  return userMax === 'auto' ? deviceMax : Math.min(deviceMax, userMax);
}

export function canAddWindow(i: { deviceMax: number; userMax: MaxWindows; open: number }):
  { ok: true } | { ok: false; reason: 'device' | 'setting'; limit: number } {
  const limit = windowLimit(i.deviceMax, i.userMax);
  if (i.open < limit) return { ok: true };
  return { ok: false, reason: i.userMax !== 'auto' && i.userMax < i.deviceMax ? 'setting' : 'device', limit };
}
