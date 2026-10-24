import { normalizeCountry } from '@iptv/core';

interface LocaleValue { language?: unknown; country?: unknown }

/** The platform globals this reads (Tizen's `systeminfo`; nothing elsewhere). */
export interface DeviceCountryGlobals {
  tizen?: {
    systeminfo?: {
      getPropertyValue?(property: 'LOCALE', ok: (v: LocaleValue) => void, err?: (e: unknown) => void): void;
    };
  };
}

/** The region of a locale tag: "sv-SE" and Tizen's "sv_SE" give "SE", "zh-Hant-TW" gives "TW"; a bare language, undefined. */
export function regionOf(tag: unknown): string | undefined {
  if (typeof tag !== 'string') return undefined;
  const parts = tag.split(/[-_]/);
  for (let i = 1; i < parts.length; i++) if (/^[A-Za-z]{2}$/.test(parts[i]!)) return parts[i]!.toUpperCase();
  return undefined;
}

/** Tizen's LOCALE (asynchronous), or undefined when the API is missing, fails or takes longer than `timeoutMs`. */
function tizenLocale(g: DeviceCountryGlobals, timeoutMs: number): Promise<LocaleValue | undefined> {
  const info = g.tizen?.systeminfo;
  if (typeof info?.getPropertyValue !== 'function') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: LocaleValue | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    try {
      info.getPropertyValue!('LOCALE', (v) => done(v), () => done(undefined));
    } catch {
      done(undefined);
    }
  });
}

/**
 * This TV's country (spec 2026-10-22-your-countries-flags): Tizen's LOCALE country, else the region of the browser
 * language ("sv-SE" → SE), as a code of the detector's closed table (`normalizeCountry`: UK → GB); else undefined.
 * Never throws; the UI sends it to the worker once at boot.
 */
export async function deviceCountry(
  g: DeviceCountryGlobals = globalThis as unknown as DeviceCountryGlobals,
  language: string | undefined = typeof navigator === 'undefined' ? undefined : navigator.language,
  timeoutMs = 1000,
): Promise<string | undefined> {
  const loc = await tizenLocale(g, timeoutMs);
  const fromTizen = regionOf(loc?.country) ?? regionOf(loc?.language);
  const tizenCode = fromTizen ? normalizeCountry(fromTizen) : undefined;
  if (tizenCode) return tizenCode;
  const fromBrowser = regionOf(language);
  return fromBrowser ? normalizeCountry(fromBrowser) : undefined;
}
