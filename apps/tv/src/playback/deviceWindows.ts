/**
 * How many multiview windows this device may open (spec 2026-10-22-tizen-multiview §2.1): the platform's ceiling until
 * the TV itself refuses a second picture (no second AVPlay instance, the SUB scaler or the per-player audio call is
 * refused). Then 1, remembered on this device until Diagnostics' Test again. A stream's own failure never counts: only
 * these device answers do, so one bad channel cannot turn multiview off. Pure apart from the injected storage.
 */
import { PLAYER_COPY } from '../copy.ts';

export type DeviceRefusal = 'noInstance' | 'subScaler' | 'audioStream';
export interface DeviceRefusalRecord { why: DeviceRefusal; at: number }

export interface DeviceWindows {
  max(): number;
  refusal(): DeviceRefusalRecord | undefined;
  /** True when this lowered the ceiling (the first refusal). */
  refuse(why: DeviceRefusal, at: number): boolean;
  /** Test again: back to the platform's ceiling. */
  reset(): void;
}

const KEY = 'iptv.multiviewDevice';
const WHYS: readonly DeviceRefusal[] = ['noInstance', 'subScaler', 'audioStream'];

export function createDeviceWindows(base: number, store: () => Storage | undefined): DeviceWindows {
  const read = (): DeviceRefusalRecord | undefined => {
    try {
      const v: unknown = JSON.parse(store()?.getItem(KEY) ?? 'null');
      if (typeof v !== 'object' || v === null) return undefined;
      const { why, at } = v as { why?: unknown; at?: unknown };
      return WHYS.includes(why as DeviceRefusal) && typeof at === 'number' ? { why: why as DeviceRefusal, at } : undefined;
    } catch {
      return undefined;
    }
  };
  let refused = base > 1 ? read() : undefined;
  return {
    max: () => (refused ? 1 : base),
    refusal: () => refused,
    refuse(why, at) {
      if (base <= 1 || refused) return false;
      refused = { why, at };
      try {
        store()?.setItem(KEY, JSON.stringify(refused));
      } catch {
        // Kept for this run only.
      }
      return true;
    },
    reset() {
      refused = undefined;
      try {
        store()?.removeItem(KEY);
      } catch {
        // nothing stored
      }
    },
  };
}

const WHY_TEXT: Readonly<Record<DeviceRefusal, string>> = PLAYER_COPY.windows.why;

/** Diagnostics' Multiview line. */
export function deviceWindowsLine(max: number, refusal: DeviceRefusalRecord | undefined): string {
  if (refusal) return PLAYER_COPY.windows.oneWindow(WHY_TEXT[refusal.why]);
  return max > 1 ? PLAYER_COPY.windows.upTo(max) : PLAYER_COPY.windows.notOnDevice;
}
